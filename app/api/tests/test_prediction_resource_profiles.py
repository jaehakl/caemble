"""Model resource profiles are admitted together with the Hybrid parent."""
from copy import deepcopy
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from optimization.predictor_jobs import resources_fit_together, validate_hybrid_capacity


def test_combined_resources_include_each_cpu_ram_and_gpu():
    resources = {"evaluation": {"cpu_cores": 1, "startup_ram_bytes": 100, "gpu_count": 0},
                 "predictor": {"cpu_cores": 3, "startup_ram_bytes": 500, "gpu_count": 1, "vram_budget_gb": 4}}
    report = {"cpu_total": 4, "ram_budget_bytes": 600, "gpu_devices": [{"total_bytes": 8 * 1024**3, "vram_reserved_bytes": 0, "admission_open": True, "free_bytes": 6 * 1024**3}]}
    assert resources_fit_together(resources, report)
    assert resources_fit_together(resources, report, available=True)
    for changes in ({"cpu_reserved": 1}, {"ram_used_bytes": 1}, {"ram_startup_reserved_bytes": 1},
                    {"admission_open": False}, {"gpu_devices": [{"total_bytes": 8 * 1024**3, "vram_reserved_bytes": 0, "admission_open": True, "free_bytes": 0}]},
                    {"gpu_devices": [{"total_bytes": 8 * 1024**3, "vram_reserved_bytes": 0, "admission_open": True, "free_bytes": 6 * 1024**3, "vram_reserved_bytes": 8 * 1024**3}]}):
        assert not resources_fit_together(resources, {**report, **changes}, available=True)
    assert not resources_fit_together(resources, {**report, "gpu_devices": []})


class ResourceProfileTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_inference_requirements_override_defaults_without_changing_evaluation(self):
        definition = {"algorithm": {"kind": "test-forward"}}
        launcher = SimpleNamespace(user_id="owner", slave_app_ids=["evaluation", "predictor"],
            job_modes={"evaluation": "websocket", "predictor": "webrtc"}, resources={
                "cpu_total": 4, "ram_budget_bytes": 600, "gpu_devices": [{"total_bytes": 8 * 1024**3, "vram_reserved_bytes": 0, "admission_open": True}],
                "defaults": {"evaluation": {"startup_ram_bytes": 100}, "predictor": {"startup_ram_bytes": 200}}})
        db = SimpleNamespace(get=AsyncMock(return_value=launcher))
        original = deepcopy(launcher.resources)
        with patch("optimization.predictor_jobs.resource_requirements", return_value={
                "cpu_cores": 3, "gpu_count": 1, "vram_budget_gb": 4, "startup_ram_bytes": 500}) as requirements:
            resources = await validate_hybrid_capacity(db, "launcher", "owner", definition)
            requirements.assert_called_once_with(definition, "inference")
            assert resources["predictor"] == {"cpu_cores": 3, "gpu_count": 1, "vram_budget_gb": 4, "startup_ram_bytes": 500}
            assert resources["evaluation"]["cpu_cores"] == 1 and resources["evaluation"]["gpu_count"] == 0
            assert launcher.resources == original
            launcher.resources = {**original, "cpu_total": 3}
            with pytest.raises(HTTPException) as denied:
                await validate_hybrid_capacity(db, "launcher", "owner", definition)
            assert denied.value.status_code == 422
