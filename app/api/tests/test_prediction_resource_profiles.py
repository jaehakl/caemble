"""Model resource profiles are admitted together with the Hybrid parent."""
from copy import deepcopy
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from optimization.predictor_jobs import resources_fit_together, validate_hybrid_capacity
from prediction.resources import resolve_resources
from prediction.router import algorithms
from prediction_contracts import algorithm_descriptor


@pytest.mark.parametrize("report", [{}, {"gpu_devices": []}, {"admission_open": False},
    {"gpu_devices": [{"admission_open": False, "free_bytes": 0}]},
    {"defaults": {"predictor": {"gpu_count": 2}}}])
def test_mlp_requires_one_gpu_regardless_of_availability(report):
    assert resolve_resources("mlp", "inference", report)["gpu_count"] == 1


def test_mlp_uses_only_configured_cpu_override_and_preserves_vram_budget():
    report = {"defaults": {
        "predictor": {"cpu_cores": 2, "gpu_count": 1, "vram_budget_gb": 0.5},
        "predictor-training": {"cpu_cores": 3, "gpu_count": 1, "vram_budget_gb": 1.25},
        "predictor.hello": {"gpu_count": 0},
    }}
    assert resolve_resources("mlp", "inference", report) == {"cpu_cores": 2, "gpu_count": 0}
    assert resolve_resources("mlp", "training", report) == {
        "cpu_cores": 3, "gpu_count": 1, "vram_budget_gb": 1.25}
    report["defaults"]["predictor.hello"] = {"gpu_count": 1, "vram_budget_gb": 0.75}
    report["defaults"]["predictor"]["gpu_count"] = 0
    assert resolve_resources("mlp", "inference", report)["vram_budget_gb"] == 0.75
    assert resolve_resources("mlp", "inference", report)["gpu_count"] == 1
    assert resolve_resources("mlp", "training", {"defaults": {"gpu_count": 0}}) == {"gpu_count": 0}
    assert resolve_resources("knn", "inference", report) == {"cpu_cores": 2, "gpu_count": 0}
    assert "vram_budget_gb" not in resolve_resources("mlp", "training", {})
    assert algorithm_descriptor("mlp")["resources"]["inference"] == {"gpu_count": 1}


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
        with patch("prediction.resources.resource_requirements", return_value={
                "cpu_cores": 3, "gpu_count": 1, "vram_budget_gb": 4, "startup_ram_bytes": 500}) as requirements:
            resources = await validate_hybrid_capacity(db, "launcher", "owner", definition)
            requirements.assert_called_once_with(definition, "inference", configured_gpu_count=None)
            assert resources["predictor"] == {"cpu_cores": 3, "gpu_count": 1, "vram_budget_gb": 4, "startup_ram_bytes": 500}
            assert resources["evaluation"]["cpu_cores"] == 1 and resources["evaluation"]["gpu_count"] == 0
            assert launcher.resources == original
            launcher.resources = {**original, "cpu_total": 3}
            with pytest.raises(HTTPException) as denied:
                await validate_hybrid_capacity(db, "launcher", "owner", definition)
            assert denied.value.status_code == 422

    async def test_algorithm_listing_resolves_both_executables_and_protects_launcher_ownership(self):
        launcher = SimpleNamespace(user_id="owner", resources={"defaults": {
            "predictor": {"gpu_count": 1, "vram_budget_gb": 0.5},
            "predictor-training": {"gpu_count": 0},
        }})
        db = SimpleNamespace(get=AsyncMock(return_value=launcher))
        user = SimpleNamespace(id="owner")
        items = (await algorithms(launcher_id="launcher", db=db, user=user))["items"]
        mlp = next(item for item in items if item["kind"] == "mlp")
        assert mlp["resources"] == {"training": {"gpu_count": 0},
                                    "inference": {"gpu_count": 1, "vram_budget_gb": 0.5}}
        canonical = (await algorithms(launcher_id=None, db=db, user=user))["items"]
        assert next(item for item in canonical if item["kind"] == "mlp")["resources"]["training"]["gpu_count"] == 1
        with pytest.raises(HTTPException) as denied:
            await algorithms(launcher_id="launcher", db=db, user=SimpleNamespace(id="other"))
        assert denied.value.status_code == 404

    async def test_hybrid_cpu_override_does_not_turn_gpu_unavailability_into_fallback(self):
        definition = {"algorithm": {"kind": "mlp"}, "implementationVersion": "mlp-v1",
                      "preprocessingVersion": "box-relative-v2"}
        launcher = SimpleNamespace(user_id="owner", slave_app_ids=["evaluation", "predictor"],
            job_modes={"evaluation": "websocket", "predictor": "webrtc"}, resources={
                "cpu_total": 4, "ram_budget_bytes": 1000, "gpu_devices": [],
                "defaults": {"predictor": {"cpu_cores": 2, "startup_ram_bytes": 100, "gpu_count": 1}}})
        db = SimpleNamespace(get=AsyncMock(return_value=launcher))
        with pytest.raises(HTTPException) as denied:
            await validate_hybrid_capacity(db, "launcher", "owner", definition)
        assert denied.value.status_code == 422
        launcher.resources["defaults"]["predictor"]["gpu_count"] = 0
        resolved = await validate_hybrid_capacity(db, "launcher", "owner", definition)
        assert resolved["predictor"] == {"cpu_cores": 1, "startup_ram_bytes": 100, "gpu_count": 0}

    async def test_hybrid_knn_retains_one_core_on_a_four_core_launcher(self):
        definition = {"algorithm": {"kind": "knn"}, "implementationVersion": "knn-v1",
                      "preprocessingVersion": "box-relative-v2"}
        launcher = SimpleNamespace(user_id="owner", slave_app_ids=["evaluation", "predictor"],
            job_modes={"evaluation": "websocket", "predictor": "webrtc"}, resources={
                "cpu_total": 4, "ram_budget_bytes": 1000, "gpu_devices": [],
                "defaults": {"predictor": {"cpu_cores": 4, "startup_ram_bytes": 100, "gpu_count": 1}}})
        resources = await validate_hybrid_capacity(SimpleNamespace(get=AsyncMock(return_value=launcher)),
                                                   "launcher", "owner", definition)
        assert resources["predictor"]["cpu_cores"] == resources["evaluation"]["cpu_cores"] == 1
