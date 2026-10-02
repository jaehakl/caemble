from __future__ import annotations

import importlib
import copy
from dataclasses import replace
from typing import Any

import numpy as np
import pytest
import torch

from app.kernel.api import SolverImplementation, SolverInvocation
from app.kernel.catalog import SolverCatalog
from app.solvers.fdtd import entry, formulation
from app.solvers.fdtd.materials import build_update_coefficients


from tests.fdtd_fixtures import small_fdtd_invocation


@pytest.mark.asyncio
@pytest.mark.parametrize(("drude_method", "plasma_frequency"), [("RC", 5e7), ("RC", 0.0), ("TRC", 0.0)])
async def test_catalog_fdtd_abi3_runs_small_cpu_domain_with_mixed_drude_materials(
    monkeypatch: pytest.MonkeyPatch,
    drude_method: str,
    plasma_frequency: float,
) -> None:
    catalog = SolverCatalog.discover()
    descriptor = catalog.descriptor("fdtd", "5.0.0")
    locator = catalog.locator("fdtd", "5.0.0")
    assert catalog.abi_version("fdtd", "5.0.0") == 3
    assert locator == "app.solvers.fdtd.entry:implementation"

    module_name, attribute = locator.split(":", maxsplit=1)
    implementation = getattr(importlib.import_module(module_name), attribute)
    assert isinstance(implementation, SolverImplementation)
    assert implementation.abi_version == 3

    invocation = small_fdtd_invocation(drude_method, plasma_frequency)
    world = invocation.world
    config = invocation.config
    identity = np.eye(3).tolist()
    progress = invocation.progress

    captured: dict[str, Any] = {}
    original_prepare_domain = entry.prepare_domain

    async def capture_prepared_domain(value: SolverInvocation) -> Any:
        prepared = await original_prepare_domain(value)
        captured["prepared"] = prepared
        return prepared

    monkeypatch.setattr(entry, "prepare_domain", capture_prepared_domain)
    result = await implementation(invocation)
    events = [call.args[0] for call in progress.await_args_list]
    preparation = next(event for event in events if event["stage"] == "fdtd-material-preparation")
    particles = [event for event in events if "rasterSeconds" in event and "particleIndex" in event]
    assert preparation["completed"] == preparation["total"] == len(particles)
    assert preparation["meshSeconds"] == pytest.approx(sum(event["meshSeconds"] for event in particles))
    assert preparation["rasterSeconds"] == pytest.approx(sum(event["rasterSeconds"] for event in particles))
    assert [event["particleIndex"] for event in particles] == list(range(1, len(particles)+1))
    assert events[-1]["stage"] == "fdtd-propagation" and events[-1]["seconds"] >= 0
    prepared = captured["prepared"]

    x_ticks, y_ticks, z_ticks = (
        np.asarray(axis, dtype=np.float64) for axis in prepared.domain.cell_ticks
    )
    drude_index = (
        int(np.argmin(np.abs(z_ticks + 0.5))),
        int(np.argmin(np.abs(y_ticks + 0.5))),
        int(np.argmin(np.abs(x_ticks + 0.5))),
    )
    later_index = (
        int(np.argmin(np.abs(z_ticks - 0.5))),
        int(np.argmin(np.abs(y_ticks - 0.5))),
        int(np.argmin(np.abs(x_ticks - 0.5))),
    )
    background_index = (
        int(np.argmin(np.abs(z_ticks - 1.5))),
        int(np.argmin(np.abs(y_ticks - 1.5))),
        int(np.argmin(np.abs(x_ticks - 1.5))),
    )
    assert prepared.epsilon_instantaneous[drude_index] == pytest.approx(1.0)
    assert prepared.plasma_frequency[drude_index] == pytest.approx(plasma_frequency)
    assert prepared.epsilon_instantaneous[later_index] == pytest.approx(4.0)
    assert np.isnan(prepared.plasma_frequency[later_index])
    assert prepared.epsilon_instantaneous[background_index] == pytest.approx(1.0)

    assert result.state_patch.is_empty
    assert result.observations["device"] == "cpu"
    assert 0 < result.observations["totalCells"] < 100_000
    assert result.observations["timeSteps"] > 0
    assert "pmlCellSize exceeds pmlCenterWavelength/15" in result.observations[
        "pmlResolutionWarning"
    ]

    output_contracts = {
        method["methodId"]: method
        for method in descriptor["methods"]["outputs"]
    }
    time_field = result.artifacts["timeElectric"]
    time_steps = result.observations["timeSteps"]
    expected_time_samples = 1 + time_steps // 2 + int(time_steps % 2 != 0)
    assert time_field["value"].shape == (2, 2, 2, expected_time_samples, 1, 1, 3)
    assert time_field["value"].dtype == np.float32
    assert len(time_field["axes"][3]["ticks"]) == expected_time_samples
    assert np.all(np.isfinite(time_field["value"]))
    assert np.any(np.abs(time_field["value"]) > 0)
    member = result.artifacts["spectralMagnetic"]
    assert member["value"].shape == (2, 2, 2, 1, 1, 2, 3)
    assert member["value"].dtype == np.float32
    assert member["axes"][4]["ticks"] == pytest.approx([5e7])
    assert np.all(np.isfinite(member["value"]))
    assert np.any(member["value"][..., 0, :] > 0)
    assert any(
        block.kind == "buffer" for block in prepared.domain.blocks.values()
    )
    assert all(
        block.drude_method == prepared.domain.blocks[block.inherited_from].drude_method
        and block.background is prepared.domain.blocks[block.inherited_from].background
        for block in prepared.domain.blocks.values()
        if block.kind == "pml"
    )

    if plasma_frequency == 0:
        dielectric_world = copy.deepcopy(world)
        dielectric_model = dielectric_world["materials"]["experiment"]["Drude Medium"]["models"]["electric"]
        dielectric_model["model"] = "em.nondispersive-isotropic@1"
        dielectric_model["parameters"] = {"epsilon": dielectric_model["parameters"]["epsilonInfinity"]}
        reference = await original_prepare_domain(replace(invocation, world=dielectric_world))
        coefficients, reference_coefficients = [
            build_update_coefficients(
                domain.epsilon_instantaneous, domain.plasma_frequency, domain.damping_frequency,
                domain.model_codes, domain.dt, domain.domain.topology.periodic, torch.device("cpu"),
            )
            for domain in (prepared, reference)
        ]
        np.testing.assert_array_equal(prepared.epsilon_instantaneous, reference.epsilon_instantaneous)
        torch.testing.assert_close(coefficients.curl, reference_coefficients.curl)
        assert coefficients.previous is None
        assert coefficients.current is None
        assert coefficients.current_new is None
        assert coefficients.current_old is None

    unsupported_world = copy.deepcopy(world)
    unsupported_world["materials"]["experiment"]["Drude Medium"]["models"]["electric"]["parameters"]["dampingFrequency"]["value"] = 0
    with pytest.raises(ValueError, match="dampingFrequency must be positive and finite for FDTD RC/TRC"):
        await original_prepare_domain(replace(invocation, world=unsupported_world))

    incompatible = copy.deepcopy(config)
    incompatible["initializations"][0]["parameters"]["drudeMethod"] = "none"
    with pytest.raises(ValueError, match="Drude Material occupies a region"):
        await original_prepare_domain(replace(invocation, config=incompatible))

    vacuum_config = copy.deepcopy(config)
    vacuum_config["parameters"]["vacuumReference"] = True
    vacuum = await original_prepare_domain(replace(invocation, config=vacuum_config))
    assert vacuum.dt == prepared.dt
    assert vacuum.domain.cell_ticks == prepared.domain.cell_ticks
    assert np.all(np.isnan(vacuum.plasma_frequency))
    assert np.all(vacuum.model_codes == 0)
    assert np.max(vacuum.epsilon_instantaneous) == 2  # buffer background is retained
    vacuum_world = copy.deepcopy(world)
    vacuum_world["materials"]["task"]["Buffer Background"]["models"]["electric"]["parameters"]["epsilon"] = {"dtype": "float64", "value": identity, "unit": "{fraction}"}
    empty = await original_prepare_domain(replace(invocation, config=vacuum_config, world=vacuum_world))
    assert empty.dt == prepared.dt
    assert empty.domain.cell_ticks == prepared.domain.cell_ticks
    assert np.all(empty.epsilon_instantaneous == 1)
    assert np.all(np.isnan(empty.plasma_frequency))
