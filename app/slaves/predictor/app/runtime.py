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
from .storage import ArtifactStore, check_cancel


class PredictorRuntime:
    def __init__(self, root: Path, owner_id: str, launcher_id: str, api_url: str,
                 memory_budget: int | None = None):
        self.store = ArtifactStore(root, owner_id, launcher_id)
        self.session_id = str(uuid.uuid4())
        self.memory_budget = memory_budget if memory_budget is not None else int(psutil.virtual_memory().available * .7)
        self.reader = DatasetReader(self.store, api_url, self.memory_budget)
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
        used = sum(sum(array.nbytes for model in bundle.models for array in model.arrays.values())
                   for _, bundle, _ in self.instances.values())
        return max(0, min(self.memory_budget - used, int(psutil.virtual_memory().available * .7)))

    def dispatch(self, action: str, payload: dict, cancel: threading.Event | None = None) -> dict:
        disk = self.store.transaction(cancel) if action not in ("model.predict", "model.release") else nullcontext()
        with self.lock, disk:
            check_cancel(cancel)
            if payload.get("protocolVersion") != 1 or not isinstance(payload.get("requestId"), str) or not payload["requestId"]:
                raise PredictionError("protocol", "Prediction protocol v1 and requestId are required.")
            if action != "predictor.hello" and payload.get("sessionId") != self.session_id:
                raise PredictionError("session-invalidated", "Prediction request belongs to another process session.")
            if action == "predictor.hello":
                result = {"storageId": self.store.storage_id, "launcherId": self.store.launcher_id,
                          "implementationVersion": IMPLEMENTATION_VERSION, "preprocessingVersion": PREPROCESSING_VERSION,
                          "capabilities": {"algorithms": ["knn"], "directions": ["forward", "inverse"],
                                           "representations": ["box-relative-v2", "calculation-ordinal-v1"], "persistentModels": True},
                          "datasets": self.store.list("datasets"), "models": self.store.list("models")}
            elif action == "dataset.import":
                imported = self.reader.import_grant(payload["grant"], cancel) if "grant" in payload else self.reader.import_local(payload["importId"], cancel, payload.get("experimentId"))
                result = {"dataset": imported}
            elif action == "dataset.list":
                result = {"datasets": self.store.list("datasets")}
            elif action == "dataset.sync":
                result = {"dataset": self.reader.sync_local(payload["datasetId"], cancel, payload.get("experimentId"))}
            elif action == "dataset.delete":
                self.store.delete("datasets", payload["datasetId"])
                result = {"deleted": True}
            elif action == "model.prepare":
                model_ref = payload["model"]
                if self.store.path("models", model_ref["modelId"], model_ref["revision"]).exists():
                    bundle, artifact = ModelBundle.load(self.store, model_ref["modelId"], model_ref["revision"], self._available_memory())
                    if bundle.metadata["operationId"] != model_ref["operationId"] or bundle.metadata["definition"] != payload["definition"]:
                        raise PredictionError("revision-conflict", "Saved model revision belongs to another preparation operation.")
                else:
                    self.reader.memory_budget = self._available_memory()
                    dataset = self.reader.load(payload["dataset"], cancel, payload["direction"], payload["definition"])
                    bundle = ModelBundle.prepare(dataset, payload["direction"], payload["definition"], model_ref, self._available_memory(), cancel)
                    check_cancel(cancel)
                    artifact = bundle.save(self.store, cancel)
                check_cancel(cancel)
                result = self._install(bundle, artifact)
            elif action == "model.load":
                bundle, artifact = ModelBundle.load(self.store, payload["modelId"], payload["revision"], self._available_memory())
                if payload.get("manifestChecksum") and payload["manifestChecksum"] != artifact["manifestChecksum"]:
                    raise PredictionError("artifact-checksum", "Saved model manifest differs from the registered model revision.")
                check_cancel(cancel)
                result = self._install(bundle, artifact)
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
                result = {"models": self.store.list("models")}
            elif action == "model.delete":
                model_id, revision = payload["modelId"], payload.get("revision")
                self.store.delete("models", model_id, revision)
                result = {"deleted": True}
            else:
                raise PredictionError("unsupported-operation", "Unsupported Predictor operation.")
            return {**result, "protocolVersion": 1, "requestId": payload["requestId"], "sessionId": self.session_id}


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
            response = {"protocolVersion": 1, "requestId": (message.payload or {}).get("requestId"),
                        "sessionId": runtime.session_id,
                        "error": {"code": error.code if isinstance(error, PredictionError) else "invalid-request",
                                  "message": str(error) if isinstance(error, PredictionError) else "Predictor request failed validation or storage access."}}
        return DataChannelMessage(id=message.id, type=f"{message.type}.result", payload=response)

    for action in ("predictor.hello", "dataset.import", "dataset.list", "dataset.sync", "dataset.delete", "model.prepare",
                   "model.load", "model.predict", "model.release", "model.list", "model.delete"):
        app.handler(action)(handle)
    return app
