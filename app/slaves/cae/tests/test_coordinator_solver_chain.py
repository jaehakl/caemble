from __future__ import annotations

from types import SimpleNamespace
from caemble_catalog import open_catalog

import numpy as np
import pytest

from app.kernel.coordinator import SimulationApi
from app.kernel.api import FieldValue
from app.kernel.coordinator.plan import RunPlan
from app.kernel.resources import FileResourceCache
from tests.test_actual_solver_chain import parameter, world


@pytest.mark.asyncio
async def test_dc_heat_chain_uses_registered_tasks_ports_and_commit():
    dc_version, heat_version = "1.0.0", "1.0.0"
    dc_task = {
        "kernel": {"name": "dc-current-density", "version": dc_version},
        "config": {
            "parameters": {"relativeTolerance": {**parameter(1e-9), "unit": "{fraction}"}, "maxIterations": 500},
            "initializations": [
                {
                    "methodId": "dc.voxel-grid",
                    "target": ["experiment.geometry.conductor"],
                    "parameters": {"gridShape": parameter([6, 4, 4])},
                }
            ],
            "boundaryConditions": [
                {
                    "methodId": "dc.source-potential",
                    "target": ["experiment.surface.sourceTerminal"],
                    "parameters": {"voltage": {**parameter(1.0), "unit": "V"}},
                },
                {
                    "methodId": "dc.reference-potential",
                    "target": ["experiment.surface.referenceTerminal"],
                    "parameters": {"voltage": {**parameter(0.0), "unit": "V"}},
                },
            ],
            "outputs": [
                {"methodId": "dc.joule-heating", "key": "jouleHeating", "target": [], "parameters": {}},
                {
                    "methodId": "dc.total-current",
                    "key": "totalCurrent",
                    "target": [],
                    "parameters": {"crossSectionPosition": {**parameter(0.5), "unit": "{fraction}"}},
                },
            ],
        },
    }
    heat_task = {
        "kernel": {"name": "steady-state-heat", "version": heat_version},
        "config": {
            "parameters": {"relativeTolerance": {**parameter(1e-9), "unit": "{fraction}"}, "maxIterations": 500},
            "initializations": [
                {
                    "methodId": "heat.voxel-grid",
                    "target": ["experiment.geometry.conductor"],
                    "parameters": {"gridShape": parameter([6, 4, 4])},
                }
            ],
            "boundaryConditions": [
                {
                    "methodId": "heat.fixed-temperature",
                    "target": ["experiment.surface.sourceTerminal"],
                    "parameters": {"temperature": {**parameter(300.0), "unit": "K"}},
                },
                {
                    "methodId": "heat.fixed-temperature",
                    "target": ["experiment.surface.referenceTerminal"],
                    "parameters": {"temperature": {**parameter(300.0), "unit": "K"}},
                },
            ],
            "outputs": [
                {"methodId": "heat.temperature", "key": "temperature", "target": [], "parameters": {}},
                {
                    "methodId": "heat.maximum-temperature",
                    "key": "maximumTemperature",
                    "target": [],
                    "parameters": {},
                },
            ],
        },
    }
    scene = world()
    with open_catalog() as catalog:
        used_models = {model["model"] for materials in scene["materials"].values() for material in materials.values() for model in material["models"].values()}
        definitions = [model for model in catalog.material_models() if model["key"] in used_models]
    plan = RunPlan.prepare({
        "experiment": {"simulationProgram": {"resultContracts": {}}, "scene": scene["experiment"], "taskScenes": {"electric": scene["task"], "thermal": scene["task"]}},
        "materialSnapshot": {"materials": scene["materials"]["experiment"]},
        "taskMaterialSnapshots": {name: {"materials": scene["materials"]["task"]} for name in ("electric", "thermal")},
        "modelDefinitions": definitions,
        "materialSelections": {"electric": {}, "thermal": {}},
    }, {"electric": dc_task, "thermal": heat_task}, {})
    progress = []

    async def report(value):
        progress.append(value)

    host = SimpleNamespace(plan=plan, run_id=f"dc-heat-{dc_version}", max_run_seconds=30, trace=[], progress=report)
    sim = SimulationApi(host)
    try:
        electric = await sim.run(plan.tasks["electric"])
        joule = sim._artifacts.materialize(electric["artifacts"]["jouleHeating"])
        assert isinstance(joule, FieldValue)
        assert joule.domain.shape == (6, 4, 4)
        assert sim._artifacts.materialize(electric["artifacts"]["totalCurrent"])["value"] > 0
        thermal = await sim.run(
            plan.tasks["thermal"], state=electric["state"],
            inputs={"heatSource": electric["artifacts"]["jouleHeating"]},
        )
        temperature = sim._artifacts.materialize(thermal["artifacts"]["temperature"])
        assert np.asarray(temperature.values).shape == (6, 4, 4)
        assert sim._artifacts.materialize(thermal["artifacts"]["maximumTemperature"])["value"] >= 300.0
        assert thermal["state"] is electric["state"]
        assert thermal["state"].revision == 0
        assert len(FileResourceCache(sim._geometry_cache.name).entry_paths()) == 1
        assert host.trace[1]["inputArtifacts"]["heatSource"]["id"] == electric["artifacts"]["jouleHeating"].artifact_id
        assert any(value.get("stage") == "output" for value in progress)
        sim.release(electric["artifacts"])
        sim.release(thermal["artifacts"])
    finally:
        sim.close()
