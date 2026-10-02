"""Execution metadata validates unknown measurements without inventing zero usage."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from pydantic import ValidationError
from fastapi import HTTPException

from prediction.models import complete_model
from prediction.schemas import ModelComplete
from sdk.process_metrics import ProcessMetrics


class PredictionQualityMetricsTests(unittest.TestCase):
    def test_execution_measurements_preserve_unavailability_and_reject_nonfinite_timings(self):
        metrics = {"version": 1, "scope": "process-tree", "elapsedSeconds": 2., "peakRssBytes": None,
            "rssStatus": "unavailable", "peakVramBytes": {"gpu-id": None}, "gpuStatus": "unavailable",
            "rssSamples": 0, "gpuSamples": 0, "rssIntervalSeconds": .1, "gpuIntervalSeconds": .5,
            "sampledCpuSeconds": 0., "samplingShutdownSeconds": 0.,
            "warnings": ["Sampler unavailable."], "phases": {"training": 1.}}
        body = {"request_id": uuid4(), "manifest_sha256": "a" * 64,
            "files": [{"name": "model.json", "sha256": "b" * 64, "byteLength": 1}],
            "profile": {}, "input_layouts": [], "output_layouts": [], "execution_metrics": metrics}
        self.assertEqual(ModelComplete(**body).execution_metrics, metrics)
        for change in ({"elapsedSeconds": float("nan")}, {"peakRssBytes": -1}, {"phases": {"training": float("inf")}},
                       {"rssSamples": True}, {"peakVramBytes": {"gpu-id": -1}}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                ModelComplete(**{**body, "execution_metrics": {**metrics, **change}})

    def test_actual_sdk_sampler_report_is_accepted_without_renaming_fields(self):
        with ProcessMetrics() as metrics:
            snapshot = metrics.snapshot()
        body = ModelComplete(request_id=uuid4(), manifest_sha256="a" * 64,
            files=[{"name": "model.json", "sha256": "b" * 64, "byteLength": 1}],
            profile={}, input_layouts=[], output_layouts=[],
            training_metrics={**snapshot, "phases": {"training": 0.}},
            execution_metrics={**metrics.result, "phases": {"training": 0.}})
        self.assertEqual(body.training_metrics["scope"], "process-tree")
        self.assertEqual(body.execution_metrics["gpuStatus"], "not-requested")
        self.assertGreaterEqual(body.execution_metrics["elapsedSeconds"], snapshot["elapsedSeconds"])


class PredictionCompletionRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_recovery_keeps_first_attempt_metrics_and_immutable_training_evidence(self):
        metrics = {"version": 1, "scope": "process-tree", "elapsedSeconds": 2., "peakRssBytes": None,
            "rssStatus": "unavailable", "peakVramBytes": {}, "gpuStatus": "not-requested",
            "rssSamples": 0, "gpuSamples": 0, "rssIntervalSeconds": .1, "gpuIntervalSeconds": .5,
            "sampledCpuSeconds": 0., "samplingShutdownSeconds": 0., "warnings": [], "phases": {}}
        request_id = uuid4()
        body = ModelComplete(request_id=request_id, manifest_sha256="a" * 64,
            files=[{"name": "model.json", "sha256": "b" * 64, "byteLength": 1}],
            profile={}, input_layouts=[], output_layouts=[], training_metrics=metrics, execution_metrics=metrics)
        artifact = body.model_dump(mode="json", exclude={"request_id", "verified"}, exclude_none=True)
        model = SimpleNamespace(id=str(uuid4()), direction="forward")
        revision = SimpleNamespace(request_id=str(request_id), state="ready", artifact=artifact)
        db = SimpleNamespace(get=AsyncMock(return_value=revision), commit=AsyncMock())
        with patch("prediction.models.owned", AsyncMock(return_value=model)), \
                patch("prediction.models.model_view", AsyncMock(return_value={"id": model.id})):
            replay = body.model_copy(update={"execution_metrics": {**metrics, "elapsedSeconds": 9.}})
            self.assertEqual(await complete_model(db, model.id, 1, replay, "owner"), {"id": model.id})
            changed = body.model_copy(update={"training_metrics": {**metrics, "elapsedSeconds": 9.}})
            with self.assertRaises(HTTPException) as rejected:
                await complete_model(db, model.id, 1, changed, "owner")
            self.assertEqual(rejected.exception.status_code, 409)
        self.assertEqual(revision.artifact["execution_metrics"]["elapsedSeconds"], 2.)
        db.commit.assert_not_awaited()
