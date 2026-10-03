"""Fixed validation designs survive real immutable Predictor rebuilds."""
from copy import deepcopy
import hashlib

import pytest

from prediction_contracts import QUALITY_VALIDATION_V2, validate_quality_report
from predictor.errors import PredictionError
from predictor.models import ModelBundle
from predictor.quality import split_dataset
from predictor.storage import encode_json
from .fixtures import stage
from .test_prediction import call
from .test_quality import quality_dataset, quality_training
from .test_training import authorize


def expanded_dataset(manifest, split):
    target = deepcopy(manifest)
    target["revision"] += 1
    held_out = next(row for row in manifest["measurements"] if row["id"] == split["validationMeasurementIds"][0])
    for identity, variables in ((11, {"x": 11}), (12, held_out["vars"])):
        target["measurements"].append({"id": identity, "vars": deepcopy(variables)})
        row = deepcopy(target["recorded"][0])
        row.update(id=100 + identity, measurement_id=identity)
        row["data"]["storage"]["value"] = [[[[[[[1e9 if identity == 12 else variables["x"] * 10]]]]]]]
        target["recorded"].append(row)
    target.pop("fingerprint")
    target["fingerprint"] = "sha256:" + hashlib.sha256(encode_json(target)).hexdigest()
    return target


def prepare_update(case, monkeypatch):
    original = case.worker.training.train(case.spec, lambda: case.reference)["artifact"]
    case.spec.update(canPin=False, canRelease=True)
    call(case.worker, "training.unpin", grant=case.grant)
    target = expanded_dataset(case.manifest, original["qualityReport"]["split"])
    reference = stage(case.worker, target)
    spec = {**deepcopy(case.spec), "operationId": "quality-update", "pinId": "quality-update-pin",
        "canPin": True, "canRelease": False, "dataset": reference,
        "model": {**case.spec["model"], "revision": 2, "operationId": "quality-update"},
        "definition": {**deepcopy(case.spec["definition"]), "snapshotFingerprint": reference["fingerprint"],
                       "fingerprint": "quality-update-definition"},
        "update": {"mode": "rebuild", "baseModel": {"modelId": original["modelId"], "revision": 1,
            "checksum": original["manifestChecksum"], "storageId": case.worker.store.storage_id, "replicaId": "base-replica"},
            "targetSnapshot": reference, "changeSet": {"baseSnapshot": case.reference, "targetSnapshot": reference,
                "added": [11, 12], "changed": [], "removed": []}, "recipe": {"seed": 0}}}
    grant = authorize(monkeypatch, case.worker, spec)
    return original, target, spec, grant


def test_new_designs_train_and_repeated_validation_designs_stay_out():
    manifest = quality_dataset()
    _, _, legacy = split_dataset(manifest)
    _, _, root = split_dataset(manifest, settings=QUALITY_VALIDATION_V2)
    assert root["validationMeasurementIds"] == legacy["validationMeasurementIds"]
    target = expanded_dataset(manifest, root)
    training, groups, successor = split_dataset(target, settings=QUALITY_VALIDATION_V2, lineage=root["lineage"])
    assert successor["lineage"] == root["lineage"]
    assert successor["lineageFingerprint"] == root["lineageFingerprint"]
    assert successor["validationMeasurementIds"] == root["validationMeasurementIds"]
    assert successor["trainingMeasurementIds"] == [*root["trainingMeasurementIds"], 11]
    assert successor["excluded"] == [{"measurementId": 12, "reason": "Repeated root validation design is reserved from training."}]
    assert [row["id"] for row in training["measurements"]] == successor["trainingMeasurementIds"]
    assert sorted(row["id"] for group in groups for row in group) == root["validationMeasurementIds"]
    assert 12 not in [row["measurement_id"] for row in training["recorded"]]


@pytest.mark.parametrize("change", ["vars", "removed"])
def test_split_independently_rejects_changed_or_missing_root_design(change):
    manifest = quality_dataset()
    _, _, root = split_dataset(manifest, settings=QUALITY_VALIDATION_V2)
    target = expanded_dataset(manifest, root)
    identity = root["validationMeasurementIds"][0]
    if change == "vars":
        next(row for row in target["measurements"] if row["id"] == identity)["vars"] = {"x": 19}
    else:
        target["measurements"] = [row for row in target["measurements"] if row["id"] != identity]
    with pytest.raises(PredictionError, match="Root validation designs"):
        split_dataset(target, settings=QUALITY_VALIDATION_V2, lineage=root["lineage"])


@pytest.mark.parametrize("algorithm", ["knn", "mlp"])
def test_real_rebuild_inherits_lineage_without_loading_base_weights(quality_training, monkeypatch, algorithm):
    case = quality_training
    if algorithm == "mlp":
        case.spec["definition"].update(implementationVersion="mlp-v1",
            algorithm={"kind": "mlp", "hiddenLayers": [4], "epochs": 3, "batchSize": 4, "learningRate": .01, "seed": 0})
    original, target, spec, grant = prepare_update(case, monkeypatch)
    load = ModelBundle.load.__func__
    loaded_revisions = []
    def tracked_load(cls, store, model_id, revision, context):
        loaded_revisions.append(revision)
        assert revision == 2, "Rebuild must inspect base metadata without loading inference weights."
        return load(cls, store, model_id, revision, context)
    monkeypatch.setattr(ModelBundle, "load", classmethod(tracked_load))
    call(case.worker, "training.pin", grant=grant)
    artifact = case.worker.training.train(spec, lambda: spec["dataset"])["artifact"]
    report = artifact["qualityReport"]
    validate_quality_report(report, spec["definition"], spec["dataset"])
    assert report["lineage"] == original["qualityReport"]["lineage"]
    assert report["split"]["validationMeasurementIds"] == original["qualityReport"]["split"]["validationMeasurementIds"]
    assert 11 in artifact["profile"]["includedMeasurementIds"]
    assert 12 not in artifact["profile"]["includedMeasurementIds"]
    assert loaded_revisions == [2]
    if algorithm == "mlp":
        import numpy as np
        center = np.load(case.worker.store.path("models", "quality-model", 2) / "outputCenter.npy", allow_pickle=False)
        included = set(artifact["profile"]["includedMeasurementIds"])
        expected = np.mean([row["data"]["storage"]["value"][0][0][0][0][0][0][0]
                            for row in target["recorded"] if row["measurement_id"] in included])
        assert center.tolist() == pytest.approx([expected])
    assert case.worker.store.read("models", "quality-model", 1)[2] == original["manifestChecksum"]
    recovered = case.worker.training.train(spec, lambda: pytest.fail("Saved revision must recover without its Dataset."))
    assert recovered["artifact"] == artifact


@pytest.mark.parametrize("change", ["changed", "removed", "disable-quality"])
def test_invalid_holdout_update_fails_before_base_pin(quality_training, monkeypatch, change):
    case = quality_training
    original, _, spec, grant = prepare_update(case, monkeypatch)
    if change == "disable-quality":
        spec["definition"].pop("qualityValidation")
    else:
        spec["update"]["changeSet"][change] = [original["qualityReport"]["split"]["validationMeasurementIds"][0]]
    with pytest.raises(PredictionError, match="validation|Quality"):
        call(case.worker, "training.pin", grant=grant)
    assert not list((case.worker.store.path("models", "quality-model") / "training-pins").glob("*.json"))
    assert not case.worker.store.path("models", "quality-model", 2).exists()
    assert case.worker.store.read("models", "quality-model", 1)[2] == original["manifestChecksum"]


@pytest.mark.parametrize("field", ["sourceHash", "varsSchema", "records", "rules", "resultContracts"])
def test_worker_rejects_changed_source_contracts_before_rebuild(quality_training, monkeypatch, field):
    case = quality_training
    original, _, spec, grant = prepare_update(case, monkeypatch)
    call(case.worker, "training.pin", grant=grant)
    read = case.worker.reader.load
    def modified(reference, cancel=None, definition=None):
        manifest = read(reference, cancel, definition)
        manifest[field] = "changed"
        return manifest
    monkeypatch.setattr(case.worker.reader, "load", modified)
    with pytest.raises(PredictionError, match="unchanged source"):
        case.worker.training.train(spec, lambda: spec["dataset"])
    assert not case.worker.store.path("models", "quality-model", 2).exists()
    assert case.worker.store.read("models", "quality-model", 1)[2] == original["manifestChecksum"]
