"""A second Forward implementation that records execution and cleanup boundaries."""
from __future__ import annotations

import copy
import math
from types import SimpleNamespace

import pytest

from prediction_contracts import ALGORITHMS
from sdk.protocol.execution import ResourceAllocation
from predictor import models
from predictor.representations import recorded_sample, vars_layouts, vars_samples
from predictor.runtime import PredictorRuntime
from predictor.storage import check_cancel, encode_json
from .fixtures import dataset, definition, stage


@pytest.fixture
def model_case(tmp_path, monkeypatch):
    descriptor = {**copy.deepcopy(ALGORITHMS["knn"]), "kind": "fixture", "implementationVersion": "fixture-v1"}
    descriptor["resources"]["training"] = {"cpu_cores": 2, "gpu_count": 1, "vram_budget_gb": 0.125}
    monkeypatch.setitem(ALGORITHMS, "fixture", descriptor)
    calls, contexts, instances = [], [], []

    class FixtureModel:
        def __init__(self, metadata, output):
            self.metadata, self.output = metadata, output
            self.persistent_bytes = 8
            self.input_layouts = vars_layouts(metadata["varsSchema"])
            self.output_layouts = [output["layout"]]
            self.close_calls = 0
            self.close_error = None
            instances.append(self)

        @classmethod
        def prepare(cls, data, model_definition, model_ref, context):
            calls.append("prepare")
            contexts.append(("prepare", context))
            check_cancel(context.cancel)
            if context.progress:
                context.progress({"stage": "training", "fraction": .5, "metrics": {"loss": 1.0}})
            output = recorded_sample(data["recorded"][0])
            output["values"] = [42]
            return cls({**model_ref, "formatVersion": 1, "direction": "forward", "algorithm": "fixture",
                        "definition": model_definition, "datasetId": data["datasetId"], "datasetRevision": data["revision"],
                        "datasetFingerprint": data["fingerprint"], "experimentId": data["experimentId"],
                        "varsSchema": copy.deepcopy(data["varsSchema"]), "rules": copy.deepcopy(data["rules"]),
                        "records": copy.deepcopy(data["records"]),
                        "includedMeasurementIds": sorted(row["id"] for row in data["measurements"])}, output)

        def profile(self):
            included = self.metadata["includedMeasurementIds"]
            return {"direction": "forward", "rowCount": len(included), "inputLayouts": self.input_layouts,
                    "inputSize": sum(math.prod(layout["shape"]) for layout in self.input_layouts),
                    "outputSize": len(self.output["values"]), "includedMeasurementIds": included,
                    "warningMeasurementIds": [], "diagnostics": [], "omittedDiagnosticGroups": 0,
                    "excluded": {}, "resources": {"persistentBytes": self.persistent_bytes, "workingSetBytes": 8}}

        def preparation_details(self):
            return {"rules": self.metadata["rules"], "errors": {}, "recordProfiles": [
                {"recordId": record["id"], "name": record["name"], "error": None, "profile": self.profile()}
                for record in self.metadata["records"]]}

        def predict(self, values, context):
            contexts.append(("predict", context))
            check_cancel(context.cancel)
            samples = vars_samples(values, self.metadata["varsSchema"])
            extrapolated = [sample["layout"]["key"] for sample in samples
                if any(value < sample["layout"]["minimum"] or value > sample["layout"]["maximum"] for value in sample["values"])]
            constant_changed = [sample["layout"]["key"] for sample in samples
                if sample["layout"]["minimum"] == sample["layout"]["maximum"]
                and any(value != sample["layout"]["minimum"] for value in sample["values"])]
            return {"direction": "forward", "fingerprint": self.metadata["definition"]["fingerprint"],
                    "output": [copy.deepcopy(self.output)], "extrapolatedInputKeys": extrapolated,
                    "constantInputKeysChanged": constant_changed, "queryDiagnostics": []}

        def write(self, path, cancel=None):
            check_cancel(cancel)
            (path / "model.json").write_bytes(encode_json({"metadata": self.metadata, "output": self.output}))

        @classmethod
        def load(cls, metadata, content, path, files, context):
            calls.append("load")
            contexts.append(("load", context))
            check_cancel(context.cancel)
            return cls(metadata, content["output"])

        @staticmethod
        def validate_artifact(path, manifest, content):
            calls.append("validate")
            assert content["output"]["values"] == [42]
            return {"model.json"}

        def close(self):
            self.close_calls += 1
            if self.close_error is not None:
                raise self.close_error
            self.persistent_bytes = 0

    monkeypatch.setitem(models.IMPLEMENTATIONS, "fixture", FixtureModel)
    allocation = ResourceAllocation(cpu_ids=[2, 4], cpu_cores=2, startup_ram_bytes=128 * 1024**2,
        ram_available_bytes=256 * 1024**2, gpu_devices=["fixture-gpu"],
        vram_budget_bytes={"fixture-gpu": 128 * 1024**2})
    worker = PredictorRuntime(tmp_path / "source", "owner-1", "launcher-1", "http://127.0.0.1:8000",
                              128 * 1024**2, allocation=allocation)
    manifest = dataset()
    reference = stage(worker, manifest)
    spec = {"operationId": "training-1", "pinId": "attempt-1", "storageId": worker.store.storage_id,
            "launcherId": worker.store.launcher_id, "sourceKind": "local", "canPin": True, "canRelease": False,
            "model": {"modelId": "trained", "revision": 1, "operationId": "training-1", "name": "Trained"},
            "definition": {**definition(manifest), "algorithm": {"kind": "fixture"}, "implementationVersion": "fixture-v1"},
            "dataset": reference}
    return SimpleNamespace(worker=worker, spec=spec, allocation=allocation, implementation=FixtureModel,
                           calls=calls, contexts=contexts, instances=instances)
