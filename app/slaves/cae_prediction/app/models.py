"""Persistent Forward models, independent from process handles and algorithm internals."""
from __future__ import annotations

import json
from copy import deepcopy
import threading
from pathlib import Path
from typing import Protocol

from prediction_contracts import algorithm_descriptor, validate_definition, validate_training_update

from .errors import PredictionError
from .execution import ModelExecutionContext
from .forward import KnnForwardModel
from .storage import ArtifactStore


class ForwardModel(Protocol):
    """The model boundary is Vars to BoxGrid samples; storage remains outside it."""
    metadata: dict
    persistent_bytes: int  # Retained host RAM; excludes device memory.
    input_layouts: list[dict]
    output_layouts: list[dict]

    def profile(self) -> dict: ...
    def preparation_details(self) -> dict: ...
    def predict(self, values: dict, context: ModelExecutionContext) -> dict: ...
    def write(self, path: Path, cancel: threading.Event | None = None) -> None: ...
    def close(self) -> None:
        """Idempotently release owned resources, even when the call was cancelled."""
        ...


class ForwardModelImplementation(Protocol):
    """Construction owns partial-resource cleanup until a model is returned."""

    @classmethod
    def prepare(cls, dataset: dict, definition: dict, model_ref: dict,
                context: ModelExecutionContext) -> ForwardModel: ...

    @classmethod
    def load(cls, metadata: dict, content: dict, path: Path, files: list[dict],
             context: ModelExecutionContext) -> ForwardModel: ...

    @staticmethod
    def validate_artifact(path: Path, manifest: dict, content: dict) -> set[str]:
        """Validate inert files and return their exact inventory without loading a model."""
        ...


class ForwardModelUpdateImplementation(ForwardModelImplementation, Protocol):
    """Optional training boundary for implementations advertising update modes."""

    @classmethod
    def update(cls, dataset: dict, definition: dict, model_ref: dict, base: ForwardModel,
               update: dict, context: ModelExecutionContext) -> ForwardModel:
        """Return a new model from completed weights without changing the base object."""
        ...


IMPLEMENTATIONS: dict[str, type[ForwardModelImplementation]] = {"knn": KnnForwardModel}


def implementation_for(definition: dict) -> type[ForwardModelImplementation]:
    try:
        descriptor = algorithm_descriptor(definition)
        if any(definition.get(key) != descriptor[key] for key in ("implementationVersion", "preprocessingVersion")):
            raise ValueError("Model implementation or preprocessing version is not supported.")
        return IMPLEMENTATIONS[descriptor["kind"]]
    except (ValueError, KeyError, TypeError) as error:
        raise PredictionError("unsupported-model", "Model implementation or preprocessing version is not supported.") from error


class ModelBundle:
    def __init__(self, implementation: ForwardModel):
        self.implementation = implementation
        self.metadata = implementation.metadata
        self._closing_bytes = 0
        self.closing = False
        self.closed = False

    @property
    def persistent_bytes(self) -> int:
        if self.closed:
            return 0
        return self._closing_bytes if self.closing else self.implementation.persistent_bytes

    @classmethod
    def prepare(cls, dataset: dict, direction: str, definition: dict, model_ref: dict,
                context: ModelExecutionContext, *, update: dict | None = None,
                base_model: "ModelBundle | None" = None) -> "ModelBundle":
        if direction != "forward" or definition.get("direction", "forward") != "forward":
            raise PredictionError("unsupported-model", "Inverse Prediction is retired. Use Optimization for inverse design.")
        try:
            mode = validate_training_update(update, definition)
        except ValueError as error:
            raise PredictionError("unsupported-model", str(error)) from error
        if definition.get("snapshotFingerprint") != dataset["fingerprint"]:
            raise PredictionError("dataset-checksum", "Model definition references a different Dataset fingerprint.")
        implementation = implementation_for(definition)
        if mode == "rebuild":
            model = implementation.prepare(dataset, definition, model_ref, context)
        else:
            if base_model is None or base_model.closing:
                raise PredictionError("unsupported-update", "Training requires a usable completed base model.")
            previous = base_model.metadata["definition"]
            if (any(previous.get(key) != definition.get(key) for key in ("implementationVersion", "preprocessingVersion"))
                    or previous.get("algorithm", {}).get("kind") != definition["algorithm"]["kind"]
                    or base_model.metadata.get("varsSchema") != dataset["varsSchema"]):
                raise PredictionError("unsupported-update", "Base model implementation or Vars schema is incompatible with this update.")
            train_update = getattr(implementation, "update", None)
            if train_update is None:
                raise PredictionError("unsupported-update", "The model implementation does not provide this training update mode.")
            model = train_update(dataset, definition, model_ref, base_model.implementation, update, context)
            if model is base_model.implementation:
                raise PredictionError("unsupported-update", "Training must return a new immutable model, not its base object.")
        try:
            if update is not None:
                model.metadata["update"] = deepcopy(update)
            return cls(model)
        except BaseException:
            model.close()
            raise

    def profile(self) -> dict:
        return self.implementation.profile()

    def prepared(self, instance: dict, artifact: dict) -> dict:
        return {"fingerprint": self.metadata["definition"]["fingerprint"], "instance": instance,
                "profile": self.profile(), **self.implementation.preparation_details(), "artifact": artifact}

    def predict(self, query: dict, context: ModelExecutionContext) -> dict:
        if self.closing:
            raise PredictionError("instance-invalidated", "Model is closing or already released.")
        if query.get("direction") != "forward":
            raise PredictionError("unsupported-model", "Prediction accepts Forward Vars input only.")
        result = self.implementation.predict(query["vars"], context)
        return {**result, "provenance": {"modelId": self.metadata["modelId"], "modelRevision": self.metadata["revision"],
            "datasetId": self.metadata["datasetId"], "datasetRevision": self.metadata["datasetRevision"]}}

    def close(self) -> None:
        if self.closed:
            return
        self._closing_bytes = self.persistent_bytes
        self.closing = True
        self.implementation.close()
        self.closed = True

    def save(self, store: ArtifactStore, cancel: threading.Event | None = None) -> dict:
        if self.closing:
            raise PredictionError("instance-invalidated", "Model is closing or already released.")
        summary = {key: self.metadata[key] for key in ("modelId", "revision", "operationId", "name", "formatVersion", "direction", "algorithm", "definition", "datasetId", "datasetRevision", "datasetFingerprint", "experimentId")}
        if "update" in self.metadata:
            summary["update"] = self.metadata["update"]
        profile = self.profile()
        summary.update({"profile": profile, "inputLayouts": self.implementation.input_layouts,
                        "outputLayouts": self.implementation.output_layouts})
        manifest, _, checksum = store.write("models", self.metadata["modelId"], self.metadata["revision"], summary,
            lambda path: self.implementation.write(path, cancel), cancel, publication_lock=True)
        return {**summary, "storageId": store.storage_id, "launcherId": store.launcher_id,
                "files": manifest["files"], "manifestChecksum": checksum, "verified": True}

    @classmethod
    def load(cls, store: ArtifactStore, model_id: str, revision: int,
             context: ModelExecutionContext) -> tuple["ModelBundle", dict]:
        if store.deleted(model_id, revision):
            raise PredictionError("deleted", "This model revision has been deleted.")
        manifest, path, checksum = store.read("models", model_id, revision, context.available_ram_bytes, context.cancel)
        content = json.loads((path / "model.json").read_bytes())
        metadata = content["metadata"]
        if metadata["modelId"] != model_id or metadata["revision"] != revision:
            raise PredictionError("artifact-checksum", "Saved model identity differs from the requested revision.")
        if metadata.get("direction") != "forward":
            raise PredictionError("unsupported-model", "Inverse Prediction is retired; its saved files remain available for management and backup.")
        implementation = implementation_for(metadata["definition"])
        artifact = {**manifest["metadata"], "storageId": store.storage_id, "launcherId": store.launcher_id,
                    "files": manifest["files"], "manifestChecksum": checksum, "verified": True}
        model = implementation.load(metadata, content, path, manifest["files"], context)
        try:
            return cls(model), artifact
        except BaseException:
            model.close()
            raise
