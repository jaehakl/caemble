"""Frozen consumer quality gates with fake persistence; no Solver, GPU or connection."""
from copy import deepcopy
import hashlib
import json
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError
import pytest

from optimization.evaluations import freeze_hybrid, freeze_quality, require_quality
from optimization.model_updates import reconcile_updates
from optimization.schemas import HybridSettings, OptimizationCreateRequest
from optimization.service import create_optimization
from prediction.db import ModelRevision, Operation, Replica, TrainingRun
from prediction_contracts import QUALITY_VALIDATION_V1
from prediction_contracts.quality import split_fingerprint


def saved_revision(rmse=0.5):
    split = {"version": 1, "seed": 0, "holdoutFraction": 0.2, "trainingMeasurementIds": [1, 2, 3, 4],
             "validationMeasurementIds": [5], "trainingGroupCount": 4, "validationGroupCount": 1, "excluded": []}
    split["fingerprint"] = split_fingerprint(split)
    source = {"datasetId": "dataset", "revision": 1, "fingerprint": "snapshot"}
    report = {"version": 1, "evaluation": "pre-save-holdout", "status": "complete", "dataset": source,
        "definitionFingerprint": "definition", "split": split, "records": [{"recordId": 7, "key": "temperature",
            "unit": "K", "status": "evaluated", "trainingMeasurementIds": [1, 2, 3, 4],
            "evaluatedMeasurementIds": [5], "evaluatedGroupCount": 1, "excluded": [],
            "components": [{"component": "value", "rmse": rmse, "mae": rmse, "maxAbsoluteError": rmse}]}]}
    return SimpleNamespace(revision=1, state="ready", dataset_id="dataset", dataset_revision=1,
        dataset_fingerprint="snapshot", definition={"algorithm": {"kind": "knn"}, "implementationVersion": "knn-v1",
            "preprocessingVersion": "box-relative-v2", "qualityValidation": QUALITY_VALIDATION_V1,
            "fingerprint": "definition", "snapshotFingerprint": "snapshot"},
        source_contracts={"sourceHash": "source", "resultContracts": {}, "records": [{"id": 7, "name": "temperature",
            "data_schema": {"unit": "K", "boxGrid": {"components": ["value"]}}}]},
        artifact={"manifest_sha256": "checksum", "quality_report": report,
            "validation": {"manifestChecksum": "checksum", "loadPassed": True, "predictPassed": True}})


def limits(maximum=0.5):
    return [{"recordId": 7, "component": "value", "rmseMaximum": maximum}]


def test_freeze_copies_report_and_preserves_native_unit_and_original_assessment():
    revision = saved_revision()
    evidence = freeze_quality(revision, limits())
    require_quality(evidence["quality_assessment"])
    restored = json.loads(json.dumps(evidence))
    revision.artifact["quality_report"]["records"][0]["components"][0]["rmse"] = 100
    assert restored == evidence
    assert evidence["quality_assessment"]["items"][0]["unit"] == "K"
    assert freeze_quality(revision, limits())["quality_assessment"]["status"] == "failed"


@pytest.mark.parametrize("change", ["dataset", "definition", "record", "key", "unit", "component"])
def test_report_must_match_revision_dataset_and_output_source(change):
    revision = saved_revision()
    report = revision.artifact["quality_report"]
    if change == "dataset":
        report["dataset"]["revision"] = 2
    elif change == "definition":
        report["definitionFingerprint"] = "different-model"
    elif change == "record":
        report["records"][0]["recordId"] = 8
    elif change == "component":
        report["records"][0]["components"][0]["component"] = "other"
    else:
        report["records"][0][change] = "other"
    with pytest.raises(HTTPException) as denied:
        freeze_quality(revision, limits())
    assert denied.value.status_code == 409


@pytest.mark.parametrize("requirement", [{"recordId": 99, "component": "value", "rmseMaximum": 1},
                                       {"recordId": 7, "component": "other", "rmseMaximum": 1}])
def test_requirement_outside_selected_model_is_rejected(requirement):
    with pytest.raises(HTTPException) as denied:
        freeze_quality(saved_revision(), [requirement])
    assert denied.value.status_code == 422


@pytest.mark.parametrize("requirements,expected", [(None, "requirements-not-configured"),
                                                   (limits(), "requirements-unassessed")])
def test_absent_report_is_allowed_only_without_requirements(requirements, expected):
    revision = saved_revision()
    revision.artifact.pop("quality_report")
    evidence = freeze_quality(revision, requirements)
    assert evidence["quality_report"] is None
    assert evidence["quality_assessment"]["reasonCode"] == expected
    if requirements:
        with pytest.raises(HTTPException, match="report-unavailable"):
            require_quality(evidence["quality_assessment"])
    else:
        require_quality(evidence["quality_assessment"])


def test_valid_partial_report_does_not_pass_an_unavailable_required_output():
    revision = saved_revision()
    revision.source_contracts["records"].append({"id": 8, "name": "other-temperature",
        "data_schema": {"unit": "K", "boxGrid": {"components": ["value"]}}})
    report = revision.artifact["quality_report"]
    report["status"] = "partial"
    report["records"].append({"recordId": 8, "key": "other-temperature", "unit": "K", "status": "unavailable",
        "trainingMeasurementIds": [], "evaluatedMeasurementIds": [], "evaluatedGroupCount": 0,
        "excluded": [{"measurementId": 5, "reason": "output unavailable"}], "components": []})
    decision = freeze_quality(revision, [{"recordId": 8, "component": "value", "rmseMaximum": 0.5}])["quality_assessment"]
    assert decision["status"] == "unassessed"
    with pytest.raises(HTTPException, match="record-unavailable"):
        require_quality(decision)


@pytest.mark.parametrize("requirements", [[], limits() * 2, limits(-1), limits(float("nan"))])
def test_hybrid_input_rejects_invalid_quality_requirements(requirements):
    with pytest.raises(ValidationError):
        HybridSettings(model_id=uuid4(), model_revision=1, replica_id=uuid4(), launcher_id=uuid4(),
                       quality_requirements=requirements)


class HybridQualityTests(IsolatedAsyncioTestCase):
    async def test_start_checks_quality_before_resource_admission_and_freezes_exact_report(self):
        revision = saved_revision()
        request = HybridSettings(model_id=uuid4(), model_revision=1, replica_id=uuid4(), launcher_id=uuid4(),
                                 quality_requirements=limits(), verification_policy={"id": "best_predicted_maximin"})
        model = SimpleNamespace(id=str(request.model_id), user_id="owner", experiment_id=3,
                                state="active", direction="forward")
        replica = SimpleNamespace(model_id=model.id, revision=1, state="present", manifest_sha256="checksum", storage_id="storage")
        db = SimpleNamespace(scalar=AsyncMock(return_value=model), get=AsyncMock(side_effect=[revision, replica]))
        experiment = SimpleNamespace(id=3, source_hash="source", result_contracts={})
        with patch("prediction.common.connected_storage", new_callable=AsyncMock), \
                patch("optimization.predictor_jobs.validate_hybrid_capacity", new_callable=AsyncMock, return_value={}) as capacity:
            frozen = await freeze_hybrid(db, request, "owner", experiment, [])
            assert frozen["model_revision"] == 1
            assert "verification_policy" not in frozen
            assert frozen["quality_report"] == revision.artifact["quality_report"]
            assert frozen["quality_assessment"]["status"] == "passed"
            capacity.assert_awaited_once()
            capacity.reset_mock()
            revision.artifact["quality_report"]["records"][0]["components"][0]["rmse"] = 2
            db.get.side_effect = [revision, replica]
            with pytest.raises(HTTPException, match="rmse-exceeded"):
                await freeze_hybrid(db, request, "owner", experiment, [])
            capacity.assert_not_awaited()

    async def test_legacy_hybrid_request_id_replays_with_unchanged_hash(self):
        request = OptimizationCreateRequest(request_id=uuid4(), experiment_id=3, source_hash="a" * 64,
            vars_schema={}, initial_vars={}, objective={"calculation_id": 1}, hybrid={
                "model_id": uuid4(), "model_revision": 1, "replica_id": uuid4(), "launcher_id": uuid4()})
        original = request.model_dump(mode="json")
        original.pop("algorithm")
        original["hybrid"].pop("quality_requirements")
        original["hybrid"].pop("verification_policy")
        original["hybrid"].pop("model_update_policy")
        fingerprint = hashlib.sha256(json.dumps(original, sort_keys=True, separators=(",", ":"),
                                                ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()
        existing = SimpleNamespace(request_hash=fingerprint)
        db = SimpleNamespace(scalar=AsyncMock(return_value=existing), commit=AsyncMock())
        with patch("optimization.service.serialize_events", new_callable=AsyncMock):
            assert await create_optimization(db, request, SimpleNamespace(id="owner"), None) is existing

    async def test_manual_successors_use_their_own_quality_and_reject_without_changing_active(self):
        for rmse, expected in ((0.25, "ready"), (2, "failed"), (None, "failed")):
            with self.subTest(rmse=rmse):
                original = saved_revision()
                initial = {"model_id": "model", "model_revision": 1, "quality_requirements": limits(),
                    "source_contracts": original.source_contracts, **freeze_quality(original, limits())}
                revision = saved_revision(rmse if rmse is not None else 0.5)
                revision.revision = 2
                revision.dataset_revision = 2
                revision.artifact["quality_report"]["dataset"]["revision"] = 2
                if rmse is None:
                    revision.artifact.pop("quality_report")
                optimization = SimpleNamespace(settings={}, definition={"hybrid": initial}, optimizer_state={"model_update": {
                    "initial_model": deepcopy(initial), "active_model": deepcopy(initial), "round_model": deepcopy(initial),
                    "pending_model": None, "updates": [{"model_id": "model", "revision": 2, "state": "running",
                        "operation_id": "operation", "version_name": "r2"}], "waiting": False}})
                operation = SimpleNamespace(state="completed", error=None, details={"result_replicas": {"model": "replica"}})
                objects = {Operation: operation, TrainingRun: SimpleNamespace(job_id=None), ModelRevision: revision,
                           Replica: SimpleNamespace(id="replica", state="present", manifest_sha256="checksum")}
                db = SimpleNamespace(get=AsyncMock(side_effect=lambda kind, identity: objects[kind]))
                with patch("optimization.model_updates.sync_pins", new_callable=AsyncMock):
                    assert not await reconcile_updates(db, optimization)
                state = optimization.optimizer_state["model_update"]
                assert state["active_model"] == initial
                assert state["initial_model"] == initial
                assert state["updates"][0]["state"] == expected
                if expected == "ready":
                    assert state["pending_model"]["model_revision"] == 2
                    assert state["pending_model"]["quality_report"]["dataset"]["revision"] == 2
                    assert state["pending_model"]["quality_assessment"]["items"][0]["rmse"] == 0.25
                else:
                    assert state["pending_model"] is None
                    assert state["updates"][0]["quality_assessment"]["status"] == ("unassessed" if rmse is None else "failed")
                    assert "Hybrid model quality" in state["updates"][0]["error"]["message"]
