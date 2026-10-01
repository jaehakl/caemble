"""Prediction session handles and storage operations behind SDK handlers."""
from __future__ import annotations

import asyncio
from contextlib import nullcontext
import os
from pathlib import Path
import threading
import uuid

import psutil

from .dataset import DatasetReader
from .errors import PredictionError
from .models import IMPLEMENTATION_VERSION, PREPROCESSING_VERSION, ModelBundle
from .operations import ArtifactOperations
from .storage import ArtifactStore, check_cancel


class PredictorRuntime:
    def __init__(self, root: Path, owner_id: str, launcher_id: str, api_url: str,
                 memory_budget: int | None = None):
        self.store = ArtifactStore(root, owner_id, launcher_id)
        self.session_id = str(uuid.uuid4())
        self.memory_budget = memory_budget if memory_budget is not None else int(psutil.virtual_memory().available * .7)
        self.reader = DatasetReader(self.store, api_url, self.memory_budget)
        self.operations = ArtifactOperations(self.store, api_url, self.memory_budget)
        self.instances: dict[str, tuple[dict, ModelBundle, dict]] = {}
        self.generation = 0
        self.lock = threading.RLock()

    @classmethod
    def from_context(cls, context):
        owner, api_url = os.environ.get("CAEMBLE_PREDICTOR_OWNER_ID"), os.environ.get("CAEMBLE_PREDICTOR_API_URL")
        if not owner or not api_url or context.execution is None:
            raise PredictionError("configuration", "Predictor requires launcher-provided owner, API and resource allocation.")
        default_root = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share")) / "Caemble" / "predictor"
        root = Path(os.environ.get("CAEMBLE_PREDICTOR_STORAGE_ROOT", default_root))
        allocation = context.execution.allocation
        available = min(psutil.virtual_memory().available, allocation.ram_available_bytes or allocation.startup_ram_bytes)
        return cls(root, owner, context.execution.identity.launcher_id, api_url, int(available * .7))

    def _install(self, bundle: ModelBundle, artifact: dict) -> dict:
        self.generation += 1
        instance = {"executionId": "remote-knn", "sessionId": self.session_id,
                    "generation": self.generation, "handle": str(uuid.uuid4())}
        self.store.lease(bundle.metadata["modelId"], bundle.metadata["revision"], instance["handle"])
        self.instances[instance["handle"]] = (instance, bundle, artifact)
        return bundle.prepared(instance, artifact)

    def _instance(self, instance: dict):
        stored = self.instances.get(instance.get("handle"))
        if stored is None or stored[0] != instance:
            raise PredictionError("instance-invalidated", "Model instance is not loaded in this execution session.")
        return stored

    def _available_memory(self) -> int:
        used = sum(bundle.persistent_bytes for _, bundle, _ in self.instances.values())
        return max(0, min(self.memory_budget - used, int(psutil.virtual_memory().available * .7)))

    def dispatch(self, action: str, payload: dict, cancel: threading.Event | None = None) -> dict:
        if payload.get("protocolVersion") != 2 or not isinstance(payload.get("requestId"), str) or not payload["requestId"]:
            raise PredictionError("protocol", "Prediction protocol v2 and requestId are required.")
        if action != "predictor.hello" and payload.get("sessionId") != self.session_id:
            raise PredictionError("session-invalidated", "Prediction request belongs to another process session.")
        if action in ("artifact.backup", "artifact.restore", "artifact.remove", "artifact.verify", "operation.inspect"):
            result = self.operations.run(action, payload, cancel)
            return {**result, "protocolVersion": 2, "requestId": payload["requestId"], "sessionId": self.session_id}
        if action == "model.prepare" and payload.get("direction") != "forward":
            raise PredictionError("unsupported-model", "Inverse Prediction is retired. Use Optimization for inverse design.")
        if action in ("model.prepare", "model.load"):
            identity = payload["model"]["modelId"] if action == "model.prepare" else payload["modelId"]
            revision = payload["model"]["revision"] if action == "model.prepare" else payload["revision"]
            with self.lock, self.store.transaction(cancel, operation_id=f"prepare-{identity}-{revision}"), self.store.read_lease(
                    "models", identity, revision, cancel, allow_missing=True):
                if action == "model.load" or self.store.path("models", identity, revision).exists():
                    bundle, artifact = ModelBundle.load(self.store, identity, revision, self._available_memory(), cancel)
                    if action == "model.prepare" and (bundle.metadata["operationId"] != payload["model"]["operationId"] or bundle.metadata["definition"] != payload["definition"]):
                        raise PredictionError("revision-conflict", "Saved model revision belongs to another preparation operation.")
                else:
                    self.reader.memory_budget = self._available_memory()
                    reference = payload["dataset"]
                    lease = (self.store.read_lease("datasets", reference["datasetId"], reference["revision"], cancel, allow_missing=True)
                             if "datasetId" in reference else nullcontext())
                    with lease:
                        dataset = self.reader.load(reference, cancel, payload["definition"])
                    bundle = ModelBundle.prepare(dataset, payload["direction"], payload["definition"], payload["model"], self._available_memory(), cancel)
                    artifact = bundle.save(self.store, cancel)
                if payload.get("manifestChecksum") and payload["manifestChecksum"] != artifact["manifestChecksum"]:
                    raise PredictionError("artifact-checksum", "Saved model manifest differs from the registered model revision.")
                check_cancel(cancel)
                with self.store.transaction(cancel):
                    result = self._install(bundle, artifact)
            return {**result, "protocolVersion": 2, "requestId": payload["requestId"], "sessionId": self.session_id}
        disk = self.store.transaction(cancel) if action not in ("model.predict", "model.release", "model.list", "dataset.list", "dataset.preview") else nullcontext()
        with self.lock, disk:
            check_cancel(cancel)
            if action == "predictor.hello":
                result = {"storageId": self.store.storage_id, "launcherId": self.store.launcher_id,
                          "implementationVersion": IMPLEMENTATION_VERSION, "preprocessingVersion": PREPROCESSING_VERSION,
                          "capabilities": {"algorithms": ["knn"], "directions": ["forward"],
                                           "representations": ["box-relative-v2"], "persistentModels": True,
                                           "portableArchives": True, "archiveFormatVersion": 1},
                          "datasets": self.store.list("datasets", verify=False), "models": self.store.list("models", verify=False)}
            elif action == "dataset.import":
                imported = self.reader.import_grant(payload["grant"], cancel) if "grant" in payload else self.reader.import_local(payload["importId"], cancel, payload.get("experimentId"))
                result = {"dataset": imported}
            elif action == "dataset.list":
                result = {"datasets": self.store.list("datasets", verify=False)}
            elif action == "dataset.sync":
                result = {"dataset": self.reader.sync_local(payload["datasetId"], cancel, payload.get("experimentId"))}
            elif action == "dataset.preview":
                revision = self.store.latest_dataset(payload["datasetId"])
                with self.store.read_lease("datasets", payload["datasetId"], revision, cancel):
                    result = self.reader.sync_local(payload["datasetId"], cancel, payload.get("experimentId"), preview=True)
            elif action == "dataset.delete":
                self.store.delete("datasets", payload["datasetId"])
                result = {"deleted": True}
            elif action == "model.predict":
                _, bundle, _ = self._instance(payload["instance"])
                result = bundle.predict(payload["input"], cancel)
                check_cancel(cancel)
            elif action == "model.release":
                instance = payload["instance"]
                stored = self.instances.get(instance.get("handle"))
                if stored and stored[0] == instance:
                    self.store.release_lease(stored[1].metadata["modelId"], stored[1].metadata["revision"], instance["handle"])
                    del self.instances[instance["handle"]]
                result = {"released": True}
            elif action == "model.list":
                result = {"models": self.store.list("models", verify=False)}
            elif action == "model.delete":
                model_id, revision = payload["modelId"], payload.get("revision")
                self.store.delete("models", model_id, revision)
                result = {"deleted": True}
            else:
                raise PredictionError("unsupported-operation", "Unsupported Predictor operation.")
            return {**result, "protocolVersion": 2, "requestId": payload["requestId"], "sessionId": self.session_id}


def create_app():
    from sdk.slave import DataChannelMessage, SlaveApp
    app = SlaveApp(memory={})

    @app.initialize
    def initialize(memory, context):
        memory["runtime"] = PredictorRuntime.from_context(context)

    async def handle(message, memory, context):
        runtime = memory["runtime"]
        cancelled = threading.Event()
        task = asyncio.create_task(asyncio.to_thread(runtime.dispatch, message.type, message.payload or {}, cancelled))
        try:
            response = await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled.set()
            try:
                await asyncio.shield(task)
            except (PredictionError, asyncio.CancelledError):
                pass
            raise
        except Exception as error:
            response = {"protocolVersion": 2, "requestId": (message.payload or {}).get("requestId"),
                        "sessionId": runtime.session_id,
                        "error": {"code": error.code if isinstance(error, PredictionError) else "invalid-request",
                                  "message": str(error) if isinstance(error, PredictionError) else "Predictor request failed validation or storage access."}}
        return DataChannelMessage(id=message.id, type=f"{message.type}.result", payload=response)

    for action in ("predictor.hello", "dataset.import", "dataset.list", "dataset.sync", "dataset.preview", "dataset.delete", "model.prepare",
                   "model.load", "model.predict", "model.release", "model.list", "model.delete",
                   "artifact.backup", "artifact.restore", "artifact.remove", "artifact.verify", "operation.inspect"):
        app.handler(action)(handle)
    return app
