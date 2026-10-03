"""Frozen validation lineage and new-training admission need no numerical backend."""
from copy import deepcopy

import pytest

from prediction_contracts import (QUALITY_VALIDATION_V1, QUALITY_VALIDATION_V2, validate_definition,
    validate_new_training, validate_quality_lineage, validate_quality_report, validate_quality_update)
from prediction_contracts.quality import lineage_fingerprint, split_fingerprint


def root_case():
    snapshot = {"datasetId": "dataset", "revision": 1, "fingerprint": "snapshot-1"}
    definition = {"algorithm": {"kind": "knn"}, "implementationVersion": "knn-v1",
        "preprocessingVersion": "box-relative-v2", "snapshotFingerprint": "snapshot-1", "fingerprint": "model-1",
        "qualityValidation": deepcopy(QUALITY_VALIDATION_V2)}
    lineage = {"rootSnapshot": snapshot,
        "validationGroups": [{"designFingerprint": "a" * 64, "measurementIds": [5]}]}
    lineage["fingerprint"] = lineage_fingerprint(lineage, QUALITY_VALIDATION_V2)
    split = {"version": 2, "seed": 0, "holdoutFraction": .2, "trainingMeasurementIds": [1, 2, 3, 4],
        "validationMeasurementIds": [5], "trainingGroupCount": 4, "validationGroupCount": 1,
        "excluded": [], "lineageFingerprint": lineage["fingerprint"]}
    split["fingerprint"] = split_fingerprint(split)
    report = {"version": 2, "evaluation": "pre-save-holdout", "status": "complete", "dataset": snapshot,
        "definitionFingerprint": "model-1", "lineage": lineage, "split": split,
        "records": [{"recordId": 1, "key": "temperature", "unit": "K", "status": "evaluated",
            "trainingMeasurementIds": [1, 2, 3, 4], "evaluatedMeasurementIds": [5], "evaluatedGroupCount": 1,
            "excluded": [], "components": [{"component": "value", "mae": .1, "rmse": .2, "maxAbsoluteError": .3}]}]}
    return definition, report


def successor_case(definition, report):
    target = {"datasetId": "dataset", "revision": 2, "fingerprint": "snapshot-2"}
    update = {"mode": "rebuild", "targetSnapshot": target, "changeSet": {"baseSnapshot": report["dataset"],
        "targetSnapshot": target, "added": [6, 7, 8, 9], "changed": [], "removed": []}}
    child_definition = {**deepcopy(definition), "snapshotFingerprint": "snapshot-2", "fingerprint": "model-2"}
    child = {**deepcopy(report), "dataset": target, "definitionFingerprint": "model-2"}
    child["split"].update(trainingMeasurementIds=[1, 2, 3, 4, 6, 7, 8, 9], trainingGroupCount=8)
    child["split"]["fingerprint"] = split_fingerprint(child["split"])
    return update, child_definition, child


def test_new_training_uses_v2_while_legacy_definition_and_report_remain_readable():
    definition, report = root_case()
    assert validate_new_training(definition) == "rebuild"
    validate_quality_lineage(report, definition)
    definition["qualityValidation"] = deepcopy(QUALITY_VALIDATION_V1)
    report["version"] = report["split"]["version"] = 1
    report.pop("lineage")
    report["split"].pop("lineageFingerprint")
    report["split"]["fingerprint"] = split_fingerprint(report["split"])
    validate_definition(definition)
    validate_quality_report(report, definition)
    with pytest.raises(ValueError, match="version 2"):
        validate_new_training(definition)


@pytest.mark.parametrize("algorithm", ["knn", "mlp"])
@pytest.mark.parametrize("settings", [None, QUALITY_VALIDATION_V1, QUALITY_VALIDATION_V2])
def test_all_algorithms_require_v2_for_new_training_but_accept_legacy_inference(algorithm, settings):
    definition, _ = root_case()
    definition.update(algorithm={"kind": algorithm}, implementationVersion=f"{algorithm}-v1")
    if settings is None:
        definition.pop("qualityValidation")
    else:
        definition["qualityValidation"] = deepcopy(settings)
    validate_definition(definition)
    if settings == QUALITY_VALIDATION_V2:
        assert validate_new_training(definition) == "rebuild"
    else:
        with pytest.raises(ValueError, match="version 2; create a fresh model"):
            validate_new_training(definition)


def test_successor_keeps_exact_root_holdout_when_dataset_grows():
    definition, report = root_case()
    update, child_definition, child = successor_case(definition, report)
    original = deepcopy((report, definition, update, child))
    validate_quality_lineage(child, child_definition, update=update, base_definition=definition, base_report=report)
    assert validate_quality_update(update, child_definition, definition, report) == report["lineage"]
    assert (report, definition, update, child) == original
    with pytest.raises(ValueError, match="own root"):
        validate_quality_lineage(child, child_definition)


@pytest.mark.parametrize("change", ["changed", "removed"])
def test_holdout_changes_require_a_fresh_model_but_training_changes_can_rebuild(change):
    definition, report = root_case()
    update, child_definition, _ = successor_case(definition, report)
    update["changeSet"][change] = [1]
    validate_quality_update(update, child_definition, definition, report)
    update["changeSet"][change] = [5]
    with pytest.raises(ValueError, match="Root validation samples"):
        validate_quality_update(update, child_definition, definition, report)


@pytest.mark.parametrize("change", ["omit", "v1", "preprocessing", "outputs", "new-dataset", "lineage"])
def test_successor_cannot_drop_quality_or_replace_its_lineage(change):
    definition, report = root_case()
    update, child_definition, child = successor_case(definition, report)
    if change == "omit":
        child_definition.pop("qualityValidation")
    elif change == "v1":
        child_definition["qualityValidation"] = deepcopy(QUALITY_VALIDATION_V1)
    elif change == "preprocessing":
        child_definition["preprocessingVersion"] = "other"
    elif change == "outputs":
        child_definition["requiredRecordIds"] = [2]
    elif change == "new-dataset":
        update["targetSnapshot"]["datasetId"] = "other"
    else:
        child["lineage"]["validationGroups"][0]["designFingerprint"] = "b" * 64
        child["lineage"]["fingerprint"] = lineage_fingerprint(child["lineage"], QUALITY_VALIDATION_V2)
        child["split"]["lineageFingerprint"] = child["lineage"]["fingerprint"]
        child["split"]["fingerprint"] = split_fingerprint(child["split"])
    with pytest.raises(ValueError):
        validate_quality_lineage(child, child_definition, update=update, base_definition=definition, base_report=report)


@pytest.mark.parametrize("change", ["missing", "design", "duplicate", "members", "fingerprint", "root"])
def test_report_rejects_invalid_lineage_without_loading_a_model(change):
    definition, report = root_case()
    if change == "missing":
        report.pop("lineage")
    elif change == "design":
        report["lineage"]["validationGroups"][0]["designFingerprint"] = "not-a-hash"
    elif change == "duplicate":
        report["lineage"]["validationGroups"].append(deepcopy(report["lineage"]["validationGroups"][0]))
    elif change == "members":
        report["lineage"]["validationGroups"][0]["measurementIds"] = [4]
    elif change == "fingerprint":
        report["split"]["lineageFingerprint"] = "other"
        report["split"]["fingerprint"] = split_fingerprint(report["split"])
    else:
        report["lineage"]["rootSnapshot"] = {**report["dataset"], "revision": 2}
    with pytest.raises(ValueError):
        validate_quality_report(report, definition)


def test_quality_updates_do_not_advertise_or_accept_continued_weights():
    definition, report = root_case()
    update, child_definition, _ = successor_case(definition, report)
    for mode in ("warm_start", "incremental"):
        update["mode"] = mode
        with pytest.raises(ValueError, match="rebuild"):
            validate_quality_update(update, child_definition, definition, report)
