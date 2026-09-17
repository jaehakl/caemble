from __future__ import annotations

from types import SimpleNamespace
from caemble_catalog import open_catalog

import numpy as np
import pytest

from app.kernel.coordinator import SimulationApi
from app.kernel.api import FieldValue
from app.kernel.coordinator.plan import RunPlan
from app.kernel.resources import FileResourceCache
from tests.test_actual_solver_chain import parameter, world, output_box


@pytest.mark.asyncio
async def test_dc_heat_chain_uses_registered_tasks_ports_and_commit():
    dc_version, heat_version = "3.1.0", "2.0.0"
    dc_task = {
        "kernel": {"name": "dc-current-density", "version": dc_version},
        "config": {
            "parameters": {"relativeTolerance": {**parameter(1e-9), "unit": "{fraction}"}},
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
                    "parameters": {"name": "source", "voltage": {**parameter(1.0), "unit": "V"}},
                },
                {
                    "methodId": "dc.potential",
                    "target": ["experiment.surface.referenceTerminal"],
                    "parameters": {"name": "reference", "voltage": {**parameter(0.0), "unit": "V"}},
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
    heat_task = {
        "kernel": {"name": "heat-transfer", "version": heat_version},
        "config": {
            "parameters": {"relativeTolerance": {**parameter(1e-9), "unit": "{fraction}"}},
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
                    "parameters": {"temperature": {**parameter(300.0), "unit": "K"}},
                },
                {
                    "methodId": "heat.fixed-temperature",
                    "target": ["experiment.surface.referenceTerminal"],
                    "parameters": {"temperature": {**parameter(300.0), "unit": "K"}},
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
        "interactionSelections": {"electric": {}, "thermal": {"thermalInterface": []}},
    }, {"electric": dc_task, "thermal": heat_task}, {})
    progress = []

    async def report(value):
        progress.append(value)

    host = SimpleNamespace(plan=plan, run_id=f"dc-heat-{dc_version}", max_run_seconds=30, trace=[], progress=report)
    sim = SimulationApi(host)
    empty_state_resources = sim._resources.stats()
    try:
        electric = await sim.run(plan.tasks["electric"])
        joule = sim._artifacts.materialize(electric["artifacts"]["jouleHeating"])
        assert isinstance(joule, FieldValue)
        assert joule.values.shape == (len(joule.domain.cells["tet4"]),)
        assert sim._artifacts.materialize(electric["artifacts"]["totalCurrent"])["value"] > 0
        thermal = await sim.run(
            plan.tasks["thermal"], state=electric["state"],
            inputs={"heatSource": electric["artifacts"]["jouleHeating"]},
        )
        temperature = sim._artifacts.materialize(thermal["artifacts"]["temperature"])
        assert np.asarray(temperature["value"]).shape == (6, 4, 4, 1, 1, 1, 1)
        assert sim._artifacts.materialize(thermal["artifacts"]["maximumTemperature"])["value"] >= 300.0
        assert thermal["state"] is electric["state"]
        assert thermal["state"].revision == 0
        assert len(FileResourceCache(sim._geometry_cache.name).entry_paths()) == 2
        assert host.trace[1]["inputArtifacts"]["heatSource"]["id"] == electric["artifacts"]["jouleHeating"].artifact_id
        assert any(value.get("stage") == "heat-fem" for value in progress)
        sim.release(electric["artifacts"])
        sim.release(thermal["artifacts"])
        assert sim._resources.stats() == empty_state_resources
        assert sim._buffers.files() == ()
    finally:
        sim.close()
    assert sim._resources.stats().resource_count == 0
