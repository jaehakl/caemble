"""Persistent Forward models, independent from process handles and algorithm internals."""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Protocol

from prediction_contracts import algorithm_descriptor, validate_definition

from .errors import PredictionError
from .forward import KnnForwardModel
from .storage import ArtifactStore


class ForwardModel(Protocol):
    """The model boundary is Vars to BoxGrid samples; storage remains outside it."""
    metadata: dict
    persistent_bytes: int
    input_layouts: list[dict]
    output_layouts: list[dict]

    def profile(self) -> dict: ...
    def record_profiles(self) -> list[dict]: ...
    def preparation_details(self) -> dict: ...
    def predict(self, values: dict, cancel=None) -> dict: ...
    def write(self, path: Path, cancel=None) -> None: ...


IMPLEMENTATIONS = {"knn": KnnForwardModel}


def implementation_for(definition: dict):
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
        self.persistent_bytes = implementation.persistent_bytes

    @classmethod
    def prepare(cls, dataset: dict, direction: str, definition: dict, model_ref: dict,
                memory_budget: int, cancel: threading.Event | None = None, progress=None) -> "ModelBundle":
        if direction != "forward" or definition.get("direction", "forward") != "forward":
            raise PredictionError("unsupported-model", "Inverse Prediction is retired. Use Optimization for inverse design.")
        try:
            validate_definition(definition)
        except ValueError as error:
            raise PredictionError("unsupported-model", str(error)) from error
        if definition.get("snapshotFingerprint") != dataset["fingerprint"]:
            raise PredictionError("dataset-checksum", "Model definition references a different Dataset fingerprint.")
        implementation = implementation_for(definition)
        return cls(implementation.prepare(dataset, definition, model_ref, memory_budget, cancel, progress))

    def profile(self) -> dict:
        return self.implementation.profile()

    def prepared(self, instance: dict, artifact: dict) -> dict:
        return {"fingerprint": self.metadata["definition"]["fingerprint"], "instance": instance,
                "profile": self.profile(), **self.implementation.preparation_details(), "artifact": artifact}

    def predict(self, query: dict, cancel=None) -> dict:
        if query.get("direction") != "forward":
            raise PredictionError("unsupported-model", "Prediction accepts Forward Vars input only.")
        result = self.implementation.predict(query["vars"], cancel)
        return {**result, "provenance": {"modelId": self.metadata["modelId"], "modelRevision": self.metadata["revision"],
            "datasetId": self.metadata["datasetId"], "datasetRevision": self.metadata["datasetRevision"]}}

    def save(self, store: ArtifactStore, cancel: threading.Event | None = None) -> dict:
        summary = {key: self.metadata[key] for key in ("modelId", "revision", "operationId", "name", "formatVersion", "direction", "algorithm", "definition", "datasetId", "datasetRevision", "datasetFingerprint", "experimentId")}
        profile = self.profile()
        summary.update({"profile": profile, "inputLayouts": self.implementation.input_layouts,
                        "outputLayouts": self.implementation.output_layouts})
        manifest, _, checksum = store.write("models", self.metadata["modelId"], self.metadata["revision"], summary,
            lambda path: self.implementation.write(path, cancel), cancel, publication_lock=True)
        return {**summary, "storageId": store.storage_id, "launcherId": store.launcher_id,
                "files": manifest["files"], "manifestChecksum": checksum, "verified": True}

    @classmethod
    def load(cls, store: ArtifactStore, model_id: str, revision: int, memory_budget: int, cancel=None):
        if store.deleted(model_id, revision):
            raise PredictionError("deleted", "This model revision has been deleted.")
        manifest, path, checksum = store.read("models", model_id, revision, memory_budget, cancel)
        content = json.loads((path / "model.json").read_bytes())
        metadata = content["metadata"]
        if metadata["modelId"] != model_id or metadata["revision"] != revision:
            raise PredictionError("artifact-checksum", "Saved model identity differs from the requested revision.")
        if metadata.get("direction") != "forward":
            raise PredictionError("unsupported-model", "Inverse Prediction is retired; its saved files remain available for management and backup.")
        implementation = implementation_for(metadata["definition"])
        model = implementation.load(metadata, content, path, manifest["files"], memory_budget, cancel)
        artifact = {**manifest["metadata"], "storageId": store.storage_id, "launcherId": store.launcher_id,
                    "files": manifest["files"], "manifestChecksum": checksum, "verified": True}
        return cls(model), artifact
