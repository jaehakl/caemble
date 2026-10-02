"""Prediction session handles and storage operations behind SDK handlers."""
from __future__ import annotations

import asyncio
from contextlib import ExitStack, nullcontext
import os
from pathlib import Path
import threading
import uuid

import psutil
from prediction_contracts import ALGORITHMS, EXECUTION_ID, PREDICTION_PROTOCOL_VERSION, algorithm_descriptor, validate_allocation
from sdk.protocol.execution import ResourceAllocation

from .dataset import DatasetReader
from .errors import PredictionError
from .execution import ModelExecutionContext
from .models import ModelBundle
from .operations import ArtifactOperations
from .storage import ArtifactStore, check_cancel
from .training_operations import TrainingOperations


class PredictorRuntime:
    def __init__(self, root: Path, owner_id: str, launcher_id: str, api_url: str,
                 memory_budget: int | None = None, *, allocation: ResourceAllocation | None = None):
        self.store = ArtifactStore(root, owner_id, launcher_id)
        self.session_id = str(uuid.uuid4())
        self.memory_budget = memory_budget if memory_budget is not None else int(psutil.virtual_memory().available * .7)
        self.reader = DatasetReader(self.store, api_url, self.memory_budget)
        self.operations = ArtifactOperations(self.store, api_url, self.memory_budget)
        self.training = TrainingOperations(self.store, api_url, self.reader, self._model_context)
        self.allocation = allocation
        self.instances: dict[str, tuple[dict, ModelBundle, dict]] = {}
        self._failed_load_leases: dict[ModelBundle, ExitStack] = {}
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
        return cls(root, owner, context.execution.identity.launcher_id, api_url, int(available * .7), allocation=allocation)

    def _retain(self, bundle: ModelBundle, artifact: dict) -> dict:
        self.generation += 1
        instance = {"executionId": EXECUTION_ID, "sessionId": self.session_id,
                    "generation": self.generation, "handle": str(uuid.uuid4())}
        self.instances[instance["handle"]] = (instance, bundle, artifact)
        self.store.lease(bundle.metadata["modelId"], bundle.metadata["revision"], instance["handle"])
        return instance

    def _install(self, bundle: ModelBundle, artifact: dict) -> dict:
        instance = self._retain(bundle, artifact)
        return bundle.prepared(instance, artifact)

    def _instance(self, instance: dict):
        stored = self.instances.get(instance.get("handle"))
        if stored is None or stored[0] != instance:
            raise PredictionError("instance-invalidated", "Model instance is not loaded in this execution session.")
        return stored

    def _available_memory(self) -> int:
        used = sum(bundle.persistent_bytes for _, bundle, _ in self.instances.values())
        return max(0, min(self.memory_budget - used, int(psutil.virtual_memory().available * .7)))

    def _model_context(self, cancel=None, progress=None) -> ModelExecutionContext:
        with self.lock:
            return ModelExecutionContext(self.allocation, self._available_memory(), cancel, progress)

    def dispatch(self, action: str, payload: dict, cancel: threading.Event | None = None) -> dict:
        if payload.get("protocolVersion") != PREDICTION_PROTOCOL_VERSION or not isinstance(payload.get("requestId"), str) or not payload["requestId"]:
            raise PredictionError("protocol", "Prediction protocol v3 and requestId are required. Update API, UI and Predictor together.")
        if action != "predictor.hello" and payload.get("sessionId") != self.session_id:
            raise PredictionError("session-invalidated", "Prediction request belongs to another process session.")
        if action in ("training.pin", "training.unpin", "training.inspect"):
            result = self.training.run(action, payload, cancel)
            return {**result, "protocolVersion": PREDICTION_PROTOCOL_VERSION, "requestId": payload["requestId"], "sessionId": self.session_id}
        if action in ("artifact.backup", "artifact.restore", "artifact.remove", "artifact.verify", "operation.inspect"):
            if action == "artifact.remove" and payload.get("kind") == "dataset":
                self.training.reconcile_dataset(payload["identity"], cancel)
            if action == "artifact.remove" and payload.get("kind") == "model":
                self.training.reconcile_model(payload["identity"], cancel)
            result = self.operations.run(action, payload, cancel)
            return {**result, "protocolVersion": PREDICTION_PROTOCOL_VERSION, "requestId": payload["requestId"], "sessionId": self.session_id}
        if action == "model.prepare":
            raise PredictionError("unsupported-operation", "Submit a durable training operation, then load its completed model revision.")
        if action == "model.load":
            identity, revision = payload["modelId"], payload["revision"]
            with self.lock, self.store.transaction(cancel, operation_id=f"prepare-{identity}-{revision}"), ExitStack() as read_access:
                read_access.enter_context(self.store.read_lease("models", identity, revision, cancel, allow_missing=True))
                if self.store.deleted(identity, revision):
                    raise PredictionError("deleted", "This model revision has been deleted.")
                if self.allocation is not None:
                    manifest, _, _ = self.store.read("models", identity, revision, cancel=cancel, verify=False)
                    try:
                        validate_allocation(manifest["metadata"]["definition"], "inference", self.allocation.model_dump())
                    except ValueError as error:
                        raise PredictionError("resource-allocation", str(error)) from error
                bundle, artifact = ModelBundle.load(self.store, identity, revision, self._model_context(cancel))
                try:
                    if payload.get("manifestChecksum") and payload["manifestChecksum"] != artifact["manifestChecksum"]:
                        raise PredictionError("artifact-checksum", "Saved model manifest differs from the registered model revision.")
                    check_cancel(cancel)
                    with self.store.transaction(cancel):
                        result = self._install(bundle, artifact)
                except BaseException:
                    try:
                        bundle.close()
                    except BaseException:
                        # A failed close still owns memory and must fence deletion.
                        # Its unusable handle remains until this process is reaped.
                        # Retain the read lease even if writing a model lease fails.
                        self._failed_load_leases[bundle] = read_access.pop_all()
                        if not any(stored[1] is bundle for stored in self.instances.values()):
                            self._retain(bundle, artifact)
                        raise
                    for handle, (instance, retained, _) in list(self.instances.items()):
                        if retained is bundle:
                            self.store.release_lease(bundle.metadata["modelId"], bundle.metadata["revision"], handle)
                            del self.instances[handle]
                    raise
            return {**result, "protocolVersion": PREDICTION_PROTOCOL_VERSION, "requestId": payload["requestId"], "sessionId": self.session_id}
        if action in ("dataset.sync", "dataset.delete"):
            self.training.reconcile_dataset(payload["datasetId"], cancel)
        if action == "model.delete":
            self.training.reconcile_model(payload["modelId"], cancel)
        disk = self.store.transaction(cancel) if action not in ("model.predict", "model.predict_batch", "model.release", "model.list", "dataset.list", "dataset.preview") else nullcontext()
        with self.lock, disk:
            check_cancel(cancel)
            if action == "predictor.hello":
                result = {"storageId": self.store.storage_id, "launcherId": self.store.launcher_id,
                          "algorithmDescriptors": [algorithm_descriptor(kind) for kind in ALGORITHMS],
                          "capabilities": {"algorithms": list(ALGORITHMS), "directions": ["forward"],
                                           "representations": sorted({value for descriptor in ALGORITHMS.values() for value in descriptor["representations"]}), "persistentModels": True,
                                           "portableArchives": True, "archiveFormatVersion": 1, "maxBatchInputs": 32},
                          "datasets": self.store.list("datasets", verify=False), "models": self.store.list("models", verify=False)}
            elif action == "dataset.import":
                imported = self.reader.import_grant(payload["grant"], cancel) if "grant" in payload else self.reader.import_local(payload["importId"], cancel, payload.get("experimentId"))
                result = {"dataset": imported}
            elif action == "dataset.list":
                result = {"datasets": self.store.list("datasets", verify=False)}
            elif action == "dataset.sync":
                self.store.assert_dataset_idle(payload["datasetId"])
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
                result = bundle.predict(payload["input"], self._model_context(cancel))
                check_cancel(cancel)
            elif action == "model.predict_batch":
                _, bundle, artifact = self._instance(payload["instance"])
                inputs = payload.get("inputs")
                if not isinstance(inputs, list) or not 1 <= len(inputs) <= 32:
                    raise PredictionError("invalid-batch", "Prediction batches require between 1 and 32 inputs.")
                identifiers = [item.get("candidateId") for item in inputs if isinstance(item, dict)]
                if (len(identifiers) != len(inputs) or any(not isinstance(identity, str) or not identity for identity in identifiers)
                        or len(set(identifiers)) != len(identifiers)):
                    raise PredictionError("invalid-batch", "Prediction candidate IDs must be unique nonempty strings.")
                predictions = []
                for item in inputs:
                    check_cancel(cancel)
                    prediction = bundle.predict(item["input"], self._model_context(cancel))
                    predictions.append({"candidateId": item["candidateId"], **prediction,
                        "provenance": {**prediction["provenance"], "manifestChecksum": artifact["manifestChecksum"]}})
                check_cancel(cancel)
                result = {"predictions": predictions}
            elif action == "model.release":
                instance = payload["instance"]
                stored = self.instances.get(instance.get("handle"))
                if stored and stored[0] == instance:
                    stored[1].close()
                    self.store.release_lease(stored[1].metadata["modelId"], stored[1].metadata["revision"], instance["handle"])
                    read_access = self._failed_load_leases.get(stored[1])
                    if read_access is not None:
                        read_access.close()
                        del self._failed_load_leases[stored[1]]
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
            return {**result, "protocolVersion": PREDICTION_PROTOCOL_VERSION, "requestId": payload["requestId"], "sessionId": self.session_id}


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
            response = {"protocolVersion": PREDICTION_PROTOCOL_VERSION, "requestId": (message.payload or {}).get("requestId"),
                        "sessionId": runtime.session_id,
                        "error": {"code": error.code if isinstance(error, PredictionError) else "invalid-request",
                                  "message": str(error) if isinstance(error, PredictionError) else "Predictor request failed validation or storage access."}}
        return DataChannelMessage(id=message.id, type=f"{message.type}.result", payload=response)

    for action in ("predictor.hello", "dataset.import", "dataset.list", "dataset.sync", "dataset.preview", "dataset.delete",
                   "model.load", "model.predict", "model.predict_batch", "model.release", "model.list", "model.delete",
                   "artifact.backup", "artifact.restore", "artifact.remove", "artifact.verify", "operation.inspect",
                   "training.pin", "training.unpin", "training.inspect"):
        app.handler(action)(handle)
    return app
