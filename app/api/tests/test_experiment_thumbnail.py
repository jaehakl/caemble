from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from db import Experiment
from models import ExperimentBase, SaveExperimentRequest
from service.demo_experiment import _summary, available_experiments
from service.experiment import experiment_versions


class ExperimentThumbnailTests(unittest.IsolatedAsyncioTestCase):
    def row(self):
        return Experiment(id=1, user_id="owner", namespace="owner", repository_slug="repo",
                          experiment_key="key", name="Test", version_major=1, version_minor=0,
                          version_patch=0, source_bundle={"files": {}}, source_hash="hash",
                          thumbnail_url="/images/test.webp")

    def test_nullable_read_contract_does_not_change_save_inputs(self):
        self.assertTrue(Experiment.__table__.c.thumbnail_url.nullable)
        self.assertIsNone(ExperimentBase.model_fields["thumbnail_url"].default)
        self.assertNotIn("thumbnail_url", SaveExperimentRequest.model_fields)
        row = self.row()
        summary = _summary(row, {"recordedMeasurements": 2, "readyCalculations": 0, "calculationData": 0}, demo=None)
        self.assertEqual(summary["thumbnail_url"], "/images/test.webp")
        row.thumbnail_url = None
        self.assertIsNone(_summary(row, {"recordedMeasurements": 0}, demo=None)["thumbnail_url"])

    async def test_available_includes_actual_derived_counts_and_thumbnail(self):
        row = self.row()
        demo = SimpleNamespace(experiment_id=1, display_order=0, is_default=True)
        database = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(all=lambda: [(demo, row)])))
        derived = {1: {"measurements": 7, "recordedData": 2, "calculations": 1}}
        with patch("service.demo_experiment._prediction_counts", AsyncMock(return_value={1: {"recordedMeasurements": 2}})), patch("service.experiment._derived_counts", AsyncMock(return_value=derived)):
            result = await available_experiments(database, user=None)
        self.assertEqual(result["mine"], [])
        self.assertEqual(result["demos"][0]["derivedCounts"]["measurements"], 7)
        self.assertEqual(result["demos"][0]["thumbnail_url"], "/images/test.webp")

    async def test_versions_include_thumbnail_after_read_authorization(self):
        row = self.row()
        database = SimpleNamespace(get=AsyncMock(return_value=row), scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: [row])))
        with patch("service.experiment.require_experiment_read", AsyncMock()) as authorize, patch("service.experiment._derived_counts", AsyncMock(return_value={1: {"measurements": 0, "recordedData": 0, "calculations": 0}})):
            result = await experiment_versions(database, 1, user=None)
        authorize.assert_awaited_once_with(database, 1, user=None)
        self.assertEqual(result["items"][0]["thumbnail_url"], "/images/test.webp")
