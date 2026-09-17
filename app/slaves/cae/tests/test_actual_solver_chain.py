from __future__ import annotations

from tests.solver_chain_fixtures import output_box, parameter, world

from pathlib import Path
from typing import Any

import numpy as np
import pytest

from app.kernel.coordinator.invocation import execute_solver
from app.kernel.coordinator.plan import TaskSpec
from app.kernel.catalog import SolverCatalog
from app.kernel.execution import SpawnSolverExecutor
from app.kernel.api import FieldValue, InputArtifact, SolverResourceServices
from app.kernel.resources import FileResourceCache


@pytest.mark.asyncio
async def test_dc_to_heat_runs_in_distinct_uncached_children(tmp_path: Path) -> None:
    dc_version, heat_version = "3.1.0", "2.0.0"
    catalog = SolverCatalog.discover()
    executor = SpawnSolverExecutor()
    progress: list[Any] = []
    resources = SolverResourceServices()

    async def report(value: Any) -> None:
        progress.append(value)

    dc_task = {
        "kernel": {"name": "dc-current-density", "version": dc_version},
        "config": {
            "parameters": {"relativeTolerance": parameter(1e-9)},
            "initializations": [
                {
                    "methodId": "dc.mesh",
                    "target": ["experiment.geometry.conductor"],
                    "parameters": {"maxElementSize": {"value": 0.15, "unit": "m"}},
                },
                {"methodId": "dc.conductor", "target": ["experiment.geometry.conductor"], "parameters": {}}
            ],
            "boundaryConditions": [
                {
                    "methodId": "dc.potential",
                    "target": ["experiment.surface.sourceTerminal"],
                    "parameters": {"name": "source", "voltage": parameter(1.0)},
                },
                {
                    "methodId": "dc.potential",
                    "target": ["experiment.surface.referenceTerminal"],
                    "parameters": {"name": "reference", "voltage": parameter(0.0)},
                },
            ],
            "exports": [{"methodId": "dc.joule-heating", "key": "jouleHeating", "target": [], "parameters": {}}],
            "outputs": [
                {
                    "methodId": "dc.total-current",
                    "key": "totalCurrent", "boxGrid": output_box(),
                    "target": [],
                    "parameters": {"gridShape": parameter([1, 1, 1]), "terminal": "source"},
                },
            ],
        },
    }
    dc_spec = TaskSpec(
        "electric", dc_task, catalog.descriptor("dc-current-density", dc_version),
        catalog.locator("dc-current-density", dc_version), 3, {}, {}, {},
    )
    electric_transaction = await execute_solver(
        dc_spec,
        {},
        {},
        world(),
        report,
        executor=executor,
        timeout=30,
        resources=resources,
    )
    electric = electric_transaction.value
    electric_transaction.commit()
    joule = electric.exports["jouleHeating"]
    assert isinstance(joule, FieldValue)
    assert joule.values.shape == (len(joule.domain.cells["tet4"]),)
    assert electric.artifacts["totalCurrent"]["value"] > 0
    np.testing.assert_allclose(electric.artifacts["totalCurrent"]["value"], 5.8e7 * .2 * .2, rtol=1e-9)

    heat_task = {
        "kernel": {"name": "heat-transfer", "version": heat_version},
        "config": {
            "parameters": {"relativeTolerance": parameter(1e-9)},
            "initializations": [
                {
                    "methodId": "heat.mesh",
                    "target": ["experiment.geometry.conductor"],
                    "parameters": {"maxElementSize": {"value": 0.15, "unit": "m"}},
                },
                {"methodId": "heat.body", "target": ["experiment.geometry.conductor"], "parameters": {}}
            ],
            "boundaryConditions": [
                {
                    "methodId": "heat.fixed-temperature",
                    "target": ["experiment.surface.sourceTerminal"],
                    "parameters": {"temperature": parameter(300.0)},
                },
                {
                    "methodId": "heat.fixed-temperature",
                    "target": ["experiment.surface.referenceTerminal"],
                    "parameters": {"temperature": parameter(300.0)},
                },
            ],
            "outputs": [
                {"methodId": "heat.temperature", "key": "temperature", "target": [], "boxGrid": output_box((6, 4, 4)), "parameters": {"gridShape": parameter([6, 4, 4])}},
                {
                    "methodId": "heat.maximum-temperature",
                    "key": "maximumTemperature", "boxGrid": output_box(),
                    "target": [],
                    "parameters": {"gridShape": parameter([1, 1, 1])},
                },
            ],
        },
    }
    source = InputArtifact(
        "joule",
        "caemble.dc/joule-heating@2",
        "electric",
        "dc-current-density",
        dc_version,
        "jouleHeating",
        0,
        None,
        joule,
    )
    heat_spec = TaskSpec(
        "thermal", heat_task, catalog.descriptor("heat-transfer", heat_version),
        catalog.locator("heat-transfer", heat_version), 3, {}, {}, {},
    )
    thermal_transaction = await execute_solver(
        heat_spec,
        {},
        {"heatSource": source},
        world(),
        report,
        executor=executor,
        timeout=30,
        resources=resources,
    )
    thermal = thermal_transaction.value
    thermal_transaction.commit()
    temperature = np.asarray(thermal.artifacts["temperature"]["value"])
    assert temperature.shape == (6, 4, 4, 1, 1, 1, 1)
    assert thermal.artifacts["maximumTemperature"]["value"] >= 300.0
    assert electric.state_patch.is_empty and thermal.state_patch.is_empty
    # Canonical surface and shared volume, reused by the thermal child.
    assert len(FileResourceCache(tmp_path).entry_paths()) == 0
    assert thermal.observations["sourcePower"] == pytest.approx(electric.observations["inputPower"], rel=1e-6)
    assert thermal.observations["outwardPower"] == pytest.approx(electric.observations["inputPower"], rel=1e-6)
    assert any(value.get("stage") == "heat-fem" for value in progress if isinstance(value, dict))


@pytest.mark.asyncio
async def test_heat_to_structure_native_temperature_cache_equivalence(tmp_path):
    """Two actual children share a canonical volume; caching changes no physics."""
    shared_world = world()
    models = shared_world["materials"]["experiment"]["Copper"]["models"]
    models["elastic"] = {"model": "mechanics.isotropic-elastic@1", "parameters": {"E": 2e9, "nu": .3, "density": 1000.}}
    models["expansion"] = {"model": "mechanics.isotropic-thermal-expansion@1", "parameters": {"alpha": 1e-5}}
    shared_world["materialSelections"].update({
        "bodyDomain": {"Copper": {"constitutive": "elastic"}},
        "thermalExpansionDomain": {"Copper": {"expansion": "expansion"}},
    })
    for name, index in (("yMinus", 2), ("zMinus", 4)):
        shared_world["experiment"]["surfaceGroups"].append({"name": name, "selectors": [
            {"rootId": "conductor-root", "sourceNodeId": "conductor-node", "surfaceIndex": index}]})
    target = ["experiment.geometry.conductor"]
    heat_config = {
        "parameters": {"relativeTolerance": parameter(1e-9)},
        "initializations": [
            {"methodId": "heat.mesh", "target": target, "parameters": {"maxElementSize": {"value": .15, "unit": "m"}}},
            {"methodId": "heat.body", "target": target, "parameters": {}},
        ],
        "boundaryConditions": [{"methodId": "heat.fixed-temperature", "target": ["experiment.surface.sourceTerminal"],
                                "parameters": {"temperature": parameter(310.)}}],
        "exports": [{"methodId": "heat.temperature", "key": "temperature", "target": [], "parameters": {}}],
        "outputs": [],
    }
    structure_config = {
        "parameters": {"analysis": "static", "geometricNonlinear": False,
                       "spatialResolution": {"value": .15, "unit": "m"}, "relativeTolerance": 1e-9, "maxIterations": 30},
        "initializations": [
            {"methodId": "fea.mesh", "target": target, "parameters": {}},
            {"methodId": "fea.body", "target": target, "parameters": {}},
            {"methodId": "fea.thermal-expansion", "target": target, "parameters": {"stressFreeTemperature": parameter(300.)}},
        ],
        "boundaryConditions": [{"methodId": "fea.fixed", "target": ["experiment.surface." + name],
                                "parameters": {"components": [component]}}
                               for name, component in (("sourceTerminal", "x"), ("yMinus", "y"), ("zMinus", "z"))],
        "outputs": [],
    }
    catalog, results = SolverCatalog.discover(), []
    for use_cache in (False, True):
        resources = SolverResourceServices(geometry_cache_path=str(tmp_path) if use_cache else None)
        exports = {}
        for name, version, config, inputs in (
            ("heat-transfer", "2.0.0", heat_config, {}),
            ("structural-mechanics", "8.0.0", structure_config, exports),
        ):
            task = {"kernel": {"name": name, "version": version}, "config": config}
            spec = TaskSpec(name, task, catalog.descriptor(name, version), catalog.locator(name, version), 3, {}, {}, {})
            transaction = await execute_solver(spec, {}, inputs, shared_world, None,
                                               executor=SpawnSolverExecutor(), timeout=30, resources=resources)
            result = transaction.value
            transaction.commit()
            if name == "heat-transfer":
                temperature = result.exports["temperature"]
                original = temperature.values.copy()
                exports["temperature"] = InputArtifact("temperature", "caemble.heat/temperature@3", name, name, version,
                                                       "temperature", 0, None, temperature)
            else:
                displacement = result.visualizations["displacement"]
                expected = 1e-4 * (displacement.domain.points + [.5, .1, .1])
                np.testing.assert_allclose(displacement.values, expected, rtol=1e-8, atol=1e-14)
                np.testing.assert_allclose(result.visualizations["stress"].values, 0., atol=2e9 * 1e-4 * 1e-8)
                assert result.observations["strainEnergy"] < 2e9 * 1e-8 * .04 * 1e-16
                assert displacement.domain.metadata["assemblyIdentity"] == temperature.domain.metadata["assemblyIdentity"]
                np.testing.assert_array_equal(original, temperature.values)
                results.append(displacement.values)
        assert len(FileResourceCache(tmp_path).entry_paths()) == (2 if use_cache else 0)
    np.testing.assert_array_equal(*results)
