"""Held-out quality contracts, leakage prevention and immutable artifact recovery."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import threading
from types import SimpleNamespace

import pytest

from prediction_contracts import ALGORITHMS, QUALITY_VALIDATION_V1, QUALITY_VALIDATION_V2, validate_quality_report, validate_training_update
from prediction_contracts.quality import split_fingerprint
from predictor.archives import create_archive, unpack_archive
from predictor.errors import PredictionError
from predictor.execution import ModelExecutionContext
from predictor.models import ModelBundle
from predictor.quality import evaluate_quality, split_dataset
from predictor.storage import encode_json
from .fixtures import dataset, definition, stage
from .test_prediction import call, runtime
from .test_training import authorize


def quality_dataset(values=range(10)):
    manifest = dataset()
    recorded, calculation = manifest["recorded"][0], manifest["calculationData"][0]
    manifest["varsSchema"]["x"]["max"] = 20
    manifest["measurements"], manifest["recorded"], manifest["calculationData"] = [], [], []
    for identity, value in enumerate(values, 1):
        manifest["measurements"].append({"id": identity, "vars": {"x": value}})
        row = copy.deepcopy(recorded)
        row.update(id=100 + identity, measurement_id=identity)
        row["data"]["storage"]["value"] = [[[[[[[value * 10]]]]]]]
        manifest["recorded"].append(row)
        manifest["calculationData"].append({**copy.deepcopy(calculation), "id": 200 + identity, "measurement_id": identity})
    manifest.pop("fingerprint")
    manifest["fingerprint"] = "sha256:" + hashlib.sha256(encode_json(manifest)).hexdigest()
    return manifest


@pytest.fixture
def quality_case():
    manifest = quality_dataset()
    training, groups, split = split_dataset(manifest)
    model_definition = {**definition(manifest), "qualityValidation": copy.deepcopy(QUALITY_VALIDATION_V1)}
    context = ModelExecutionContext(None, 128 * 1024**2)
    bundle = ModelBundle.prepare(training, "forward", model_definition,
        {"modelId": "quality-model", "revision": 1, "operationId": "quality-operation", "name": "Quality"}, context)
    try:
        yield SimpleNamespace(manifest=manifest, training=training, groups=groups, split=split,
                              bundle=bundle, context=context, definition=model_definition)
    finally:
        bundle.close()


@pytest.fixture
def quality_training(tmp_path, monkeypatch):
    worker, manifest = runtime(tmp_path / "source"), quality_dataset()
    reference = stage(worker, manifest)
    spec = {"operationId": "quality-operation", "pinId": "quality-pin", "storageId": worker.store.storage_id,
            "launcherId": worker.store.launcher_id, "sourceKind": "local", "canPin": True, "canRelease": False,
            "model": {"modelId": "quality-model", "revision": 1, "operationId": "quality-operation", "name": "Quality"},
            "definition": {**definition(manifest), "qualityValidation": copy.deepcopy(QUALITY_VALIDATION_V2)}, "dataset": reference}
    grant = authorize(monkeypatch, worker, spec)
    call(worker, "training.pin", grant=grant)
    return SimpleNamespace(worker=worker, manifest=manifest, reference=reference, spec=spec, grant=grant)


def test_split_normalizes_numeric_spellings_and_preserves_tensor_design_groups():
    manifest = quality_dataset([0, 0.0, -0.0, 1, 1.0, 2, 3, 4, 5])
    manifest["varsSchema"] = {"tensor": {"shape": [2], "min": 0, "max": 20}, "scalar": {"shape": [], "min": 0, "max": 20}}
    for row in manifest["measurements"]:
        value = row["vars"]["x"]
        row["vars"] = {"scalar": value, "tensor": [value, 1]}
    training, groups, split = split_dataset(manifest)
    assert split["trainingGroupCount"] + split["validationGroupCount"] == 6
    memberships = [set(split[key]) for key in ("trainingMeasurementIds", "validationMeasurementIds")]
    assert any({1, 2, 3}.issubset(partition) for partition in memberships)
    assert any({4, 5}.issubset(partition) for partition in memberships)
    reordered = copy.deepcopy(manifest)
    reordered["measurements"].reverse()
    reordered["varsSchema"] = dict(reversed(list(reordered["varsSchema"].items())))
    for row in reordered["measurements"]:
        row["vars"] = dict(reversed(list(row["vars"].items())))
    _, repeated_groups, repeated_split = split_dataset(reordered)
    assert repeated_split == split
    assert repeated_groups == groups
    assert training["fingerprint"] == manifest["fingerprint"]


def test_split_filters_all_measurement_payloads_without_copying_or_mutating_source():
    manifest = quality_dataset()
    original = copy.deepcopy(manifest)
    training, groups, split = split_dataset(manifest)
    held_out = set(split["validationMeasurementIds"])
    selected = set(split["trainingMeasurementIds"])
    assert held_out.isdisjoint(selected)
    assert {row["id"] for group in groups for row in group} == held_out
    assert {row["id"] for row in training["measurements"]} == selected
    for key in ("recorded", "calculationData"):
        assert {row["measurement_id"] for row in training[key]} == selected
        assert all(any(row is original_row for original_row in manifest[key]) for row in training[key])
    assert training["varsSchema"] is manifest["varsSchema"]
    assert manifest == original


def test_invalid_vars_are_excluded_and_never_count_towards_minimum_groups():
    manifest = quality_dataset([0, 1, 2, 3, 4, 5])
    manifest["measurements"].append({"id": 50, "vars": {"x": float("nan")}})
    manifest["measurements"].append({"id": 51, "vars": {"x": [3]}})
    training, _, split = split_dataset(manifest)
    assert {item["measurementId"] for item in split["excluded"]} == {50, 51}
    assert {row["id"] for row in training["measurements"]}.isdisjoint({50, 51})
    manifest["measurements"] = manifest["measurements"][:4] + manifest["measurements"][-2:]
    with pytest.raises(PredictionError) as unavailable:
        split_dataset(manifest)
    assert unavailable.value.code == "quality-unavailable"


def test_quality_weights_design_groups_equally_and_reports_each_component():
    manifest = quality_dataset()
    _, groups, _ = split_dataset(manifest)
    repeated = {"id": 50, "vars": copy.deepcopy(groups[0][0]["vars"])}
    manifest["measurements"].append(repeated)
    duplicate = copy.deepcopy(manifest["recorded"][0])
    duplicate.update(id=150, measurement_id=50)
    manifest["recorded"].append(duplicate)
    training, groups, split = split_dataset(manifest)
    held_out_errors = {groups[0][0]["id"]: 2, 50: 4, groups[1][0]["id"]: 10}
    for row in manifest["recorded"]:
        for grid in (row["data_schema"]["boxGrid"], row["data"]["boxGrid"]):
            grid["components"] = ["x", "y"]
        row["data"]["shape"][-1] = 2
        row["data"]["axes"][-1]["ticks"] = ["x", "y"]
        error = held_out_errors.get(row["measurement_id"], 0)
        row["data"]["storage"]["value"] = [[[[[[[error, -2 * error]]]]]]]
    model_definition = {**definition(manifest), "qualityValidation": copy.deepcopy(QUALITY_VALIDATION_V1)}
    context = ModelExecutionContext(None, 128 * 1024**2)
    bundle = ModelBundle.prepare(training, "forward", model_definition,
        {"modelId": "model", "revision": 1, "operationId": "operation", "name": "Group weights"}, context)
    try:
        report = evaluate_quality(bundle, manifest, groups, split, lambda: context)
    finally:
        bundle.close()
    assert report["status"] == "complete"
    output = report["records"][0]
    assert output["evaluatedGroupCount"] == 2 and len(output["evaluatedMeasurementIds"]) == 3
    assert output["components"] == [
        {"component": "x", "mae": 6.5, "rmse": pytest.approx(math.sqrt(55)), "maxAbsoluteError": 10},
        {"component": "y", "mae": 13, "rmse": pytest.approx(math.sqrt(220)), "maxAbsoluteError": 20}]


def test_quality_reports_unavailable_records_without_zero_error_metrics(quality_case):
    case = quality_case
    case.manifest["records"].append({"id": 11, "name": "missing.output", "contract_hash": "missing"})
    report = evaluate_quality(case.bundle, case.manifest, case.groups, case.split, lambda: case.context)
    assert report["status"] == "partial"
    missing = report["records"][1]
    assert missing["status"] == "unavailable"
    assert missing["components"] == [] and missing["evaluatedMeasurementIds"] == []
    assert {item["measurementId"] for item in missing["excluded"]} == set(case.split["validationMeasurementIds"])


@pytest.mark.parametrize("invalid", ["missing", "layout", "nonfinite", "malformed-storage", "malformed-axes"])
def test_invalid_holdout_record_is_excluded_without_losing_other_outputs(quality_case, invalid):
    case = quality_case
    target = case.groups[0][0]["id"]
    row = next(item for item in case.manifest["recorded"] if item["measurement_id"] == target)
    if invalid == "missing":
        case.manifest["recorded"].remove(row)
    elif invalid == "layout":
        row["data_schema"]["unit"] = "Pa"
    elif invalid == "nonfinite":
        row["data"]["storage"]["value"] = [[[[[[[float("inf")]]]]]]]
    elif invalid == "malformed-storage":
        row["data"]["storage"] = {"kind": "base64", "data": "!not-base64!", "byteLength": 8}
    else:
        row["data_schema"]["axes"] = []
    report = evaluate_quality(case.bundle, case.manifest, case.groups, case.split, lambda: case.context)
    assert report["status"] == "partial"
    record = report["records"][0]
    assert target not in record["evaluatedMeasurementIds"]
    assert [item["measurementId"] for item in record["excluded"]] == [target]
    assert record["evaluatedGroupCount"] == 1


def test_quality_rejects_no_evaluable_holdout_instead_of_reporting_zero(quality_case):
    case = quality_case
    held_out = set(case.split["validationMeasurementIds"])
    case.manifest["recorded"] = [row for row in case.manifest["recorded"] if row["measurement_id"] not in held_out]
    with pytest.raises(PredictionError) as unavailable:
        evaluate_quality(case.bundle, case.manifest, case.groups, case.split, lambda: case.context)
    assert unavailable.value.code == "quality-unavailable"


def test_quality_recomputes_scratch_budget_for_retained_model_memory(quality_case, monkeypatch):
    case, received = quality_case, []
    original = case.bundle.predict
    def retain(values, context):
        received.append(context.available_ram_bytes)
        result = original(values, context)
        case.bundle.implementation.persistent_bytes += 16
        return result
    monkeypatch.setattr(case.bundle, "predict", retain)
    before = case.bundle.persistent_bytes
    evaluate_quality(case.bundle, case.manifest, case.groups, case.split, lambda: case.context)
    assert received == [case.context.available_ram_bytes - before - index * 16 for index in range(len(case.groups))]
    with pytest.raises(PredictionError) as limited:
        evaluate_quality(case.bundle, case.manifest, case.groups, case.split,
                         lambda: ModelExecutionContext(None, case.bundle.persistent_bytes + 1))
    assert limited.value.code == "memory-limit"


def test_quality_cancellation_stops_before_next_measurement(quality_case, monkeypatch):
    case, cancelled, calls = quality_case, threading.Event(), []
    original = case.bundle.predict
    def cancel_after_prediction(query, context):
        calls.append(query)
        result = original(query, context)
        cancelled.set()
        return result
    monkeypatch.setattr(case.bundle, "predict", cancel_after_prediction)
    with pytest.raises(PredictionError) as stopped:
        evaluate_quality(case.bundle, case.manifest, case.groups, case.split,
                         lambda: ModelExecutionContext(None, 128 * 1024**2, cancelled))
    assert stopped.value.code == "cancelled" and len(calls) == 1
    with pytest.raises(PredictionError) as stopped_split:
        split_dataset(case.manifest, cancelled)
    assert stopped_split.value.code == "cancelled"


def test_quality_training_saved_reload_archive_and_retry_preserve_frozen_report(tmp_path, quality_training):
    case = quality_training
    source, manifest, reference, spec, grant = case.worker, case.manifest, case.reference, case.spec, case.grant
    artifact = source.training.train(spec, lambda: reference)["artifact"]
    report = artifact["qualityReport"]
    validate_quality_report(report, spec["definition"], reference)
    train_ids = set(report["split"]["trainingMeasurementIds"])
    held_out = set(report["split"]["validationMeasurementIds"])
    assert train_ids.isdisjoint(held_out)
    assert set(artifact["profile"]["includedMeasurementIds"]) == train_ids
    assert artifact["validation"]["measurementId"] in train_ids
    assert artifact["validation"]["loadPassed"] is True
    assert artifact["trainingMetrics"]["elapsedSeconds"] >= 0
    model_file = source.store.path("models", "quality-model", 1) / "model.json"
    content = json.loads(model_file.read_text(encoding="utf-8"))
    assert content["metadata"]["qualityReport"] == report
    assert set(content["models"][0]["cohort"]["includedMeasurementIds"]) == train_ids
    assert source.store.receipt(spec["operationId"])["artifact"]["qualityReport"] == report
    assert source.instances == {}

    spec.update(canPin=False, canRelease=True)
    call(source, "training.unpin", grant=grant)
    source.store.delete("datasets", "dataset-1")
    fresh = runtime(tmp_path / "source")
    recovered = fresh.training.train(spec, lambda: pytest.fail("Recovery must not recompute holdout or reload Dataset."))["artifact"]
    assert recovered["qualityReport"] == report
    assert recovered["manifestChecksum"] == artifact["manifestChecksum"]
    assert recovered["trainingMetrics"] == artifact["trainingMetrics"]
    assert recovered["executionMetrics"] == artifact["executionMetrics"]

    archive = create_archive(fresh.store, "model", "quality-model", 1, tmp_path / "quality.zip")
    target = runtime(tmp_path / "target")
    staging = target.store.namespace / "pending-quality"
    unpack_archive(tmp_path / "quality.zip", staging, "model", "quality-model", 1, archive["manifest_sha256"])
    target.store.publish_replica("models", "quality-model", 1, staging, archive["manifest_sha256"])
    loaded = call(target, "model.load", modelId="quality-model", revision=1)
    assert loaded["artifact"]["qualityReport"] == report
    assert loaded["artifact"]["trainingMetrics"] == artifact["trainingMetrics"]
    query = {"direction": "forward", "vars": next(row["vars"] for row in manifest["measurements"] if row["id"] in held_out)}
    assert call(target, "model.predict", instance=loaded["instance"], input=query)["output"]
    call(target, "model.release", instance=loaded["instance"])


@pytest.mark.parametrize("failure", ["insufficient-groups", "manual-k", "all-unavailable", "cancelled"])
def test_opted_in_quality_failure_never_publishes_full_dataset_model(quality_training, monkeypatch, failure):
    case, cancelled = quality_training, threading.Event()
    read = case.worker.reader.load
    def load(reference, cancel=None, definition=None):
        manifest = read(reference, cancel, definition)
        if failure == "insufficient-groups":
            manifest["measurements"] = manifest["measurements"][:4]
        elif failure == "all-unavailable":
            _, _, split = split_dataset(manifest)
            held_out = set(split["validationMeasurementIds"])
            manifest["recorded"] = [row for row in manifest["recorded"] if row["measurement_id"] not in held_out]
        return manifest
    monkeypatch.setattr(case.worker.reader, "load", load)
    if failure == "manual-k":
        case.spec["definition"]["algorithm"].update(kMode="manual", manualK=9)
    def progress(value):
        if failure == "cancelled" and value == "quality-evaluation":
            cancelled.set()
    with pytest.raises(PredictionError) as stopped:
        case.worker.training.train(case.spec, lambda: case.reference, cancelled, progress)
    assert stopped.value.code == ("cancelled" if failure == "cancelled" else
                                  "insufficient-cohort" if failure == "manual-k" else "quality-unavailable")
    assert case.worker.store.list("models") == []
    assert case.worker.instances == {}
    receipt = case.worker.store.receipt(case.spec["operationId"])
    assert receipt["state"] == ("cancelled" if failure == "cancelled" else "interrupted")
    assert receipt["executionMetrics"]["elapsedSeconds"] >= 0
    assert list((case.worker.store.path("datasets", "dataset-1") / "training-pins").glob("*.json"))


def test_quality_uses_per_record_training_cohorts_instead_of_model_union(quality_case):
    case = quality_case
    extra_record = {"id": 11, "name": "heat.other", "contract_hash": "heat-contract"}
    case.manifest["records"].append(extra_record)
    rule = copy.deepcopy(case.manifest["rules"][0])
    rule["label"] = extra_record["name"]
    case.manifest["rules"].append(rule)
    absent_train = case.split["trainingMeasurementIds"][0]
    for row in list(case.manifest["recorded"]):
        if row["measurement_id"] == absent_train:
            continue
        copied = copy.deepcopy(row)
        copied.update(id=1000 + row["id"], name=extra_record["name"], experiment_record_id=extra_record["id"])
        case.manifest["recorded"].append(copied)
    training, groups, split = split_dataset(case.manifest)
    bundle = ModelBundle.prepare(training, "forward", case.definition,
        {"modelId": "cohorts", "revision": 1, "operationId": "operation", "name": "Cohorts"}, case.context)
    try:
        report = evaluate_quality(bundle, case.manifest, groups, split, lambda: case.context)
        assert absent_train in bundle.profile()["includedMeasurementIds"]
    finally:
        bundle.close()
    first, second = report["records"]
    assert absent_train in first["trainingMeasurementIds"]
    assert absent_train not in second["trainingMeasurementIds"]
    assert set(second["trainingMeasurementIds"]) == set(first["trainingMeasurementIds"]) - {absent_train}


def test_invalid_frozen_quality_report_is_rejected_before_loading_weights(quality_case, tmp_path, monkeypatch):
    case, worker = quality_case, runtime(tmp_path)
    report = evaluate_quality(case.bundle, case.manifest, case.groups, case.split, lambda: case.context)
    report["definitionFingerprint"] = "another-model"
    case.bundle.metadata["qualityReport"] = report
    case.bundle.save(worker.store)
    def forbidden_load(*args, **kwargs):
        pytest.fail("Invalid quality evidence must fail before loading numerical model arrays.")
    monkeypatch.setattr(type(case.bundle.implementation), "load", forbidden_load)
    with pytest.raises(PredictionError) as invalid:
        ModelBundle.load(worker.store, "quality-model", 1, case.context)
    assert invalid.value.code == "artifact-checksum"


@pytest.mark.parametrize("corruption", ["missing", "definition", "dataset", "split-fingerprint", "overlap",
                                        "duplicate-id", "group-count", "noninteger-version", "unknown-validation",
                                        "nonfinite-error", "false-complete"])
def test_quality_contract_rejects_corrupt_report_and_split_inventory(quality_case, corruption):
    case = quality_case
    report = evaluate_quality(case.bundle, case.manifest, case.groups, case.split, lambda: case.context)
    if corruption == "missing":
        report = None
    elif corruption == "definition":
        report["definitionFingerprint"] = "other-model"
    elif corruption == "dataset":
        report["dataset"]["revision"] += 1
    elif corruption == "split-fingerprint":
        report["split"]["fingerprint"] = "sha256:" + "0" * 64
    elif corruption == "overlap":
        report["split"]["trainingMeasurementIds"].append(report["split"]["validationMeasurementIds"][0])
        report["split"]["fingerprint"] = split_fingerprint(report["split"])
    elif corruption == "duplicate-id":
        report["split"]["validationMeasurementIds"] *= 2
        report["split"]["fingerprint"] = split_fingerprint(report["split"])
    elif corruption == "group-count":
        report["split"]["validationGroupCount"] += 1
        report["split"]["fingerprint"] = split_fingerprint(report["split"])
    elif corruption == "noninteger-version":
        report["split"]["version"] = True
        report["split"]["fingerprint"] = split_fingerprint(report["split"])
    elif corruption == "unknown-validation":
        report["records"][0]["evaluatedMeasurementIds"].append(999)
    elif corruption == "nonfinite-error":
        report["records"][0]["components"][0]["rmse"] = float("nan")
    elif corruption == "false-complete":
        report["records"][0].update(status="unavailable", evaluatedMeasurementIds=[], evaluatedGroupCount=0, components=[],
            excluded=[{"measurementId": identity, "reason": "missing"} for identity in report["split"]["validationMeasurementIds"]])
    with pytest.raises(ValueError):
        validate_quality_report(report, case.definition, case.manifest)


@pytest.mark.parametrize("mode", ["warm_start", "incremental"])
def test_quality_rejects_updates_that_can_reuse_previously_seen_holdout_samples(quality_case, monkeypatch, mode):
    case = quality_case
    monkeypatch.setitem(ALGORITHMS["knn"], "supportedUpdateModes", ["rebuild", "warm_start", "incremental"])
    target = {key: case.manifest[key] for key in ("datasetId", "revision", "fingerprint")}
    base_snapshot = {**target, "revision": 1}
    update = {"mode": mode, "targetSnapshot": target, "recipe": {},
              "baseModel": {"modelId": "base", "revision": 1, "storageId": "storage", "replicaId": "replica", "checksum": "a" * 64},
              "changeSet": {"baseSnapshot": base_snapshot, "targetSnapshot": target, "added": [10], "changed": [], "removed": []}}
    with pytest.raises(ValueError, match="requires rebuild"):
        validate_training_update(update, case.definition)
    without_quality = {key: value for key, value in case.definition.items() if key != "qualityValidation"}
    assert validate_training_update(update, without_quality) == mode


def test_advisory_metrics_receipt_failure_keeps_successful_training_result(quality_training, monkeypatch):
    case, failed_writes = quality_training, []
    persist = case.worker.store.save_receipt
    def reject_metrics(operation_id, receipt):
        if "executionMetrics" in receipt:
            failed_writes.append(operation_id)
            raise OSError("Advisory metrics storage unavailable")
        persist(operation_id, receipt)
    monkeypatch.setattr(case.worker.store, "save_receipt", reject_metrics)
    artifact = case.worker.training.train(case.spec, lambda: case.reference)["artifact"]
    assert failed_writes == [case.spec["operationId"]]
    assert artifact["executionMetrics"]["elapsedSeconds"] >= 0
    assert artifact["validation"]["loadPassed"] is True and artifact["validation"]["predictPassed"] is True
    receipt = case.worker.store.receipt(case.spec["operationId"])
    assert receipt["state"] == "saved"
    assert receipt["artifact"]["manifestChecksum"] == artifact["manifestChecksum"]
    assert receipt["artifact"]["qualityReport"] == artifact["qualityReport"]


def test_advisory_metrics_receipt_failure_preserves_original_cancellation(quality_training, monkeypatch):
    case, failed_writes = quality_training, []
    persist = case.worker.store.save_receipt
    def reject_metrics(operation_id, receipt):
        if "executionMetrics" in receipt:
            failed_writes.append(operation_id)
            raise OSError("Advisory metrics storage unavailable")
        persist(operation_id, receipt)
    monkeypatch.setattr(case.worker.store, "save_receipt", reject_metrics)
    cancelled = PredictionError("cancelled", "Original training cancellation")
    def progress(value):
        if value == "quality-evaluation":
            raise cancelled
    with pytest.raises(PredictionError) as raised:
        case.worker.training.train(case.spec, lambda: case.reference, progress=progress)
    assert raised.value is cancelled
    assert failed_writes == [case.spec["operationId"]]
    assert case.worker.store.list("models") == [] and case.worker.instances == {}
    receipt = case.worker.store.receipt(case.spec["operationId"])
    assert receipt["state"] == "cancelled"
    assert receipt["error"] == {"code": "cancelled", "message": "Original training cancellation"}
