import asyncio
import copy
import gc
import json
import sys

import numpy as np
import pytest
from sdk.protocol.messages import DataChannelAttachment, DataChannelMessage
from sdk.slave import SlaveContext

from app.errors import CaeError, ProtocolError
from app.handlers import cae_simulation_next, cae_simulation_start, cae_solver_manifests
from app.runtime import SimulationApi
from app.solver_framework.registry import registry


@pytest.mark.asyncio
async def test_solver_manifests_returns_sorted_full_manifests_as_json_attachment():
    modules_before = set(sys.modules)
    response = await cae_solver_manifests(
        DataChannelMessage(id="catalog", type="cae.solvers.manifests", payload={}),
        {"runs": {}},
        SlaveContext(session_id="session", ttl_seconds=10, call_id="catalog"),
    )

    assert response.type == "cae.solvers.manifests.result"
    assert response.payload == {
        "formatVersion": 1,
        "count": 2,
        "attachmentId": "solver-manifests",
    }
    assert len(response.attachments) == 1
    attachment = response.attachments[0]
    assert attachment.id == "solver-manifests"
    assert attachment.name == "solver-manifests.json"
    assert attachment.mimeType == "application/json; charset=utf-8"
    assert json.loads(attachment.data) == registry.manifests()
    assert [
        manifest["descriptor"]["name"]
        for manifest in json.loads(attachment.data)
    ] == ["dc-current-density", "steady-state-heat"]
    assert "implementation" in json.loads(attachment.data)[0]
    assert "app.solvers.dc_current_density.solver" not in set(sys.modules) - modules_before
    assert "app.solvers.steady_state_heat.solver" not in set(sys.modules) - modules_before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        DataChannelMessage(
            id="catalog",
            type="cae.solvers.manifests",
            payload={"unexpected": True},
        ),
        DataChannelMessage(
            id="catalog",
            type="cae.solvers.manifests",
            payload={},
            attachments=[
                DataChannelAttachment(
                    id="unexpected",
                    name="unexpected.bin",
                    data=b"x",
                )
            ],
        ),
    ],
)
async def test_solver_manifests_rejects_nonempty_requests(message):
    with pytest.raises(ProtocolError):
        await cae_solver_manifests(
            message,
            {"runs": {}},
            SlaveContext(session_id="session", ttl_seconds=10, call_id="catalog"),
        )


def task_config(kernel: str, output_method: str, output_key: str):
    prefix = "dc" if kernel == "dc-current-density" else "heat"
    boundary_conditions = (
        [
            {
                "methodId": "dc.source-potential",
                "target": ["experiment.surface.source"],
                "parameters": {
                    "voltage": {
                        "dtype": "float64",
                        "unit": "V",
                        "quantityKind": "electromagnetism.Voltage",
                        "value": 1,
                    }
                },
            },
            {
                "methodId": "dc.reference-potential",
                "target": ["experiment.surface.reference"],
                "parameters": {
                    "voltage": {
                        "dtype": "float64",
                        "unit": "V",
                        "quantityKind": "electromagnetism.Voltage",
                        "value": 0,
                    }
                },
            },
        ]
        if prefix == "dc"
        else [
            {
                "methodId": "heat.fixed-temperature",
                "target": ["experiment.surface.source"],
                "parameters": {
                    "temperature": {
                        "dtype": "float64",
                        "unit": "K",
                        "quantityKind": "thermodynamics.Temperature",
                        "value": 300,
                    }
                },
            },
            {
                "methodId": "heat.fixed-temperature",
                "target": ["experiment.surface.reference"],
                "parameters": {
                    "temperature": {
                        "dtype": "float64",
                        "unit": "K",
                        "quantityKind": "thermodynamics.Temperature",
                        "value": 300,
                    }
                },
            },
        ]
    )
    output_parameters = (
        {
            "crossSectionPosition": {
                "dtype": "float64",
                "unit": "{fraction}",
                "quantityKind": "DimensionlessRatio",
                "value": 0.5,
            }
        }
        if output_method in {"dc.current-density", "dc.total-current"}
        else {}
    )
    return {
        "parameters": {
            "relativeTolerance": {
                "dtype": "float64",
                "unit": "{fraction}",
                "quantityKind": "DimensionlessRatio",
                "value": 1e-6,
            },
            "maxIterations": 100,
        },
        "initializations": [
            {
                "methodId": f"{prefix}.voxel-grid",
                "target": ["experiment.geometry.conductor"],
                "parameters": {
                    "gridShape": {
                        "dtype": "int32",
                        "axes": [{"length": 3}],
                        "value": [3, 3, 3],
                    }
                },
            }
        ],
        "boundaryConditions": boundary_conditions,
        "outputs": [
            {
                "key": output_key,
                "methodId": output_method,
                "target": ["experiment.geometry.conductor"],
                "parameters": output_parameters,
            }
        ],
    }


def payload():
    total_current_schema = {
        "dtype": "float64",
        "unit": "A",
        "quantityKind": "electromagnetism.ElectricCurrent",
        "tensorOrder": 0,
    }
    recorded_data = {"totalCurrent": total_current_schema}
    source = (
        "async def simulate(*, sim, tasks, vars):\n"
        "    result = await sim.run(tasks[\"electric\"])\n"
        "    await sim.record(\"totalCurrent\", result[\"artifacts\"][\"totalCurrent\"])\n"
        "    return result[\"state\"]\n"
    )
    scene = {
        "sceneHash": "c" * 64,
        "lengthUnit": "m",
        "parts": [],
        "tree": {"key": "root", "label": "root", "children": []},
        "geometryGroups": [],
        "surfaceGroups": [],
    }
    return {
        "measurement": {
            "kind": "measurement",
            "materialParameters": {"schemaVersion": 1, "materials": {}},
            "materialWarnings": [],
            "experiment": {
                "kind": "experiment",
                "scene": scene,
                "taskScenes": {"electric": scene},
                "variables": {},
                "varsSchema": {},
                "sourceHash": "a" * 64,
                "simulationProgram": {
                    "formatVersion": 5,
                    "simulationApiVersion": 3,
                    "pythonSource": source,
                    "tasks": {
                        "electric": {
                            "kernel": {
                                "name": "dc-current-density",
                                "version": "0.1.0",
                            },
                            "config": task_config(
                                "dc-current-density",
                                "dc.total-current",
                                "totalCurrent",
                            ),
                        }
                    },
                    "recordedData": recorded_data,
                },
            },
            "taskMaterialParameters": {
                "electric": {"schemaVersion": 1, "materials": {}}
            },
            "taskMaterialWarnings": {"electric": []},
        },
    }


def artifact_chain_payload(
    artifact_expression,
    *,
    input_name="heatSource",
    producer_method="dc.joule-heating",
):
    request = payload()
    program = request["measurement"]["experiment"]["simulationProgram"]
    program["tasks"] = {
        "producer": {
            "kernel": {"name": "dc-current-density", "version": "0.1.0"},
            "config": task_config("dc-current-density", producer_method, "heatSource"),
        },
        "consumer": {
            "kernel": {"name": "steady-state-heat", "version": "0.1.0"},
            "config": task_config(
                "steady-state-heat",
                "heat.maximum-temperature",
                "maximumTemperature",
            ),
        },
    }
    experiment = request["measurement"]["experiment"]
    scene = experiment["taskScenes"]["electric"]
    experiment["taskScenes"] = {name: scene for name in program["tasks"]}
    request["measurement"]["taskMaterialParameters"] = {
        name: {"schemaVersion": 1, "materials": {}} for name in program["tasks"]
    }
    request["measurement"]["taskMaterialWarnings"] = {name: [] for name in program["tasks"]}
    source = (
        "async def simulate(*, sim, tasks, vars):\n"
        '    produced = await sim.run(tasks["producer"])\n'
        f'    await sim.run(tasks["consumer"], inputs={{"{input_name}": {artifact_expression}}})\n'
        "    return None\n"
    )
    program["pythonSource"] = source
    return request


def fake_artifacts(task):
    artifacts = {}
    for output in task["config"]["outputs"]:
        method_id = output["methodId"]
        if method_id == "dc.joule-heating":
            artifacts[output["key"]] = {
                "value": np.ones((1, 1, 1), dtype=np.float64),
                "axes": [{"ticks": [0.5]}, {"ticks": [0.5]}, {"ticks": [0.5]}],
            }
        elif method_id in {"heat.temperature"}:
            artifacts[output["key"]] = {
                "value": np.full((1, 1, 1), 300.0, dtype=np.float64),
                "axes": [{"ticks": [0.5]}, {"ticks": [0.5]}, {"ticks": [0.5]}],
            }
        else:
            artifacts[output["key"]] = {"value": 300.0 if method_id.startswith("heat.") else 14.9}
    return artifacts


@pytest.mark.asyncio
async def test_start_rejects_obsolete_contract_metadata_before_run_creation():
    request = payload()
    request["contract"] = {"version": "obsolete"}
    memory = {"runs": {}}

    response = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert response.payload["kind"] == "failed"
    assert response.payload["sequence"] == 0
    assert response.payload["error"]["code"] == "invalid_input"
    assert memory["runs"] == {}


@pytest.mark.asyncio
async def test_start_rejects_an_unregistered_kernel_version():
    request = payload()
    request["measurement"]["experiment"]["simulationProgram"]["tasks"]["electric"]["kernel"]["version"] = "9.9.9"

    response = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        {"runs": {}},
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert response.payload["kind"] == "failed"
    assert response.payload["error"]["code"] == "kernel_not_found"


@pytest.mark.parametrize(
    "field, value, code",
    [
        ("formatVersion", 3, "invalid_program"),
        ("simulationApiVersion", 1, "unsupported_program"),
    ],
)
@pytest.mark.asyncio
async def test_start_requires_manifest_v5_and_python_api_v3(field, value, code):
    request = payload()
    request["measurement"]["experiment"]["simulationProgram"][field] = value

    response = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        {"runs": {}},
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert response.payload["kind"] == "failed"
    assert response.payload["error"]["code"] == code


@pytest.mark.asyncio
async def test_sim_run_selects_only_the_current_task_scene_and_material_snapshot(monkeypatch):
    request = payload()
    experiment = request["measurement"]["experiment"]
    program = experiment["simulationProgram"]
    program["tasks"]["thermal"] = copy.deepcopy(program["tasks"]["electric"])
    electric_scene = experiment["taskScenes"]["electric"]
    electric_scene["tree"]["label"] = "electric-scene"
    thermal_scene = copy.deepcopy(electric_scene)
    thermal_scene["sceneHash"] = "e" * 64
    thermal_scene["tree"]["label"] = "thermal-scene"
    experiment["taskScenes"] = {
        "electric": electric_scene,
        "thermal": thermal_scene,
    }
    request["measurement"]["taskMaterialParameters"] = {
        "electric": {
            "schemaVersion": 1,
            "materials": {},
            "materialColors": {"Electric": {"color": "#111111", "materialId": 1}},
        },
        "thermal": {
            "schemaVersion": 1,
            "materials": {},
            "materialColors": {"Thermal": {"color": "#222222", "materialId": 2}},
        },
    }
    request["measurement"]["taskMaterialWarnings"] = {
        "electric": ["electric-warning"],
        "thermal": ["thermal-warning"],
    }
    program["recordedData"] = {}
    program["pythonSource"] = (
        "async def simulate(*, sim, tasks, vars):\n"
        '    await sim.run(tasks["electric"])\n'
        '    await sim.run(tasks["thermal"])\n'
        "    return None\n"
    )
    selected = []

    async def fake_kernel(task, state, inputs, world, progress):
        assert set(world) == {"experiment", "task", "materials"}
        assert set(world["materials"]) == {"experiment", "task"}
        assert set(world["materials"]["task"]) == {"parameters", "warnings"}
        selected.append(
            (
                world["task"]["tree"]["label"],
                tuple(world["materials"]["task"]["parameters"].get("materialColors", {})),
                tuple(world["materials"]["task"]["warnings"]),
            )
        )
        return {
            "state": None,
            "artifacts": {"totalCurrent": {"value": 14.9}},
            "observations": {},
        }

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert start.payload["kind"] == "started"
    run = memory["runs"][start.payload["runId"]]
    assert set(run.tasks["electric"]) == {"kernel", "config"}
    with pytest.raises(TypeError):
        run.tasks["electric"]["config"]["rogue"] = True

    response = await cae_simulation_next(
        DataChannelMessage(
            id="next",
            type="cae.simulation.next",
            payload={"runId": start.payload["runId"], "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next"),
    )

    assert response.payload["kind"] == "complete"
    assert selected == [
        ("electric-scene", ("Electric",), ("electric-warning",)),
        ("thermal-scene", ("Thermal",), ("thermal-warning",)),
    ]


@pytest.mark.asyncio
async def test_start_rejects_task_material_maps_that_do_not_match_task_scenes():
    request = payload()
    request["measurement"]["taskMaterialWarnings"]["unknown"] = []

    response = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        {"runs": {}},
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert response.payload["kind"] == "failed"
    assert response.payload["error"]["code"] == "invalid_input"
    assert "taskMaterialWarnings" in response.payload["error"]["message"]


@pytest.mark.asyncio
async def test_start_rejects_manifest_tasks_that_do_not_match_task_scenes():
    request = payload()
    tasks = request["measurement"]["experiment"]["simulationProgram"]["tasks"]
    tasks["unknown"] = tasks.pop("electric")

    response = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        {"runs": {}},
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert response.payload["kind"] == "failed"
    assert response.payload["error"]["code"] == "invalid_input"
    assert "Task scenes" in response.payload["error"]["message"]


@pytest.mark.asyncio
async def test_start_does_not_compute_and_next_applies_record_ack_backpressure(monkeypatch):
    calls = 0

    async def fake_kernel(task, state, inputs, world, progress):
        nonlocal calls
        calls += 1
        return {
            "state": {"done": True},
            "artifacts": {"totalCurrent": {"value": 14.9}},
            "observations": {},
        }

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=payload()),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert start.payload["kind"] == "started"
    assert calls == 0
    run_id = start.payload["runId"]

    first = await cae_simulation_next(
        DataChannelMessage(
            id="next-1",
            type="cae.simulation.next",
            payload={"runId": run_id, "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next-1"),
    )

    assert calls == 1
    assert first.payload == {
        "kind": "record",
        "sequence": 1,
        "name": "totalCurrent",
        "tensor": {
            "shape": [],
            "storage": {"kind": "inline", "value": 14.9},
        },
    }
    assert run_id in memory["runs"]
    run = memory["runs"][run_id]
    previous_heartbeat = run.heartbeat_task
    assert previous_heartbeat is not None
    assert not previous_heartbeat.done()
    assert run.active_context.call_id == "next-1"

    final = await cae_simulation_next(
        DataChannelMessage(
            id="next-2",
            type="cae.simulation.next",
            payload={"runId": run_id, "ackSequence": 1},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next-2"),
    )

    assert final.payload["kind"] == "complete"
    assert final.payload["recordSequences"] == [1]
    assert set(final.payload) == {"kind", "sequence", "recordSequences"}
    assert previous_heartbeat.cancelled()
    assert run.heartbeat_task is None
    assert run.active_context is None
    assert run_id not in memory["runs"]


@pytest.mark.asyncio
async def test_run_timeout_while_record_is_pending_remains_reachable_after_ack(monkeypatch):
    async def fake_kernel(task, state, inputs, world, progress):
        return {
            "state": {"done": True},
            "artifacts": {"totalCurrent": {"value": 14.9}},
            "observations": {},
        }

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=payload()),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )
    run_id = start.payload["runId"]
    memory["runs"][run_id].max_run_seconds = 0.01

    record = await cae_simulation_next(
        DataChannelMessage(
            id="next-1",
            type="cae.simulation.next",
            payload={"runId": run_id, "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next-1"),
    )
    assert record.payload["kind"] == "record"
    await asyncio.sleep(0.05)

    failed = await cae_simulation_next(
        DataChannelMessage(
            id="next-2",
            type="cae.simulation.next",
            payload={"runId": run_id, "ackSequence": record.payload["sequence"]},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next-2"),
    )

    assert failed.payload["kind"] == "failed"
    assert failed.payload["error"]["code"] == "run_timeout"
    assert run_id not in memory["runs"]


@pytest.mark.asyncio
async def test_record_ack_watchdog_cleans_up_after_outer_run_timeout(monkeypatch):
    async def fake_kernel(task, state, inputs, world, progress):
        return {
            "state": None,
            "artifacts": {"totalCurrent": {"value": 14.9}},
            "observations": {},
        }

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    monkeypatch.setattr("app.runtime.RECORD_ACK_TIMEOUT_SECONDS", 0.04)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=payload()),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )
    run_id = start.payload["runId"]
    run = memory["runs"][run_id]
    run.max_run_seconds = 0.01

    record = await cae_simulation_next(
        DataChannelMessage(
            id="next-1",
            type="cae.simulation.next",
            payload={"runId": run_id, "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next-1"),
    )
    assert record.payload["kind"] == "record"
    await asyncio.sleep(0.08)

    assert run.closed
    assert run.pending is None
    assert run.heartbeat_task is None
    assert run_id not in memory["runs"]


@pytest.mark.asyncio
async def test_sim_run_rejects_equal_but_unregistered_task(monkeypatch):
    request = payload()
    program = request["measurement"]["experiment"]["simulationProgram"]
    rogue_task = repr(program["tasks"]["electric"])
    source = (
        "async def simulate(*, sim, tasks, vars):\n"
        f"    task = {rogue_task}\n"
        "    return await sim.run(task)\n"
    )
    program["pythonSource"] = source
    calls = 0

    async def fake_kernel(task, state, inputs, world, progress):
        nonlocal calls
        calls += 1
        return {"state": None, "artifacts": {}, "observations": {}}

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    failed = await cae_simulation_next(
        DataChannelMessage(
            id="next",
            type="cae.simulation.next",
            payload={"runId": start.payload["runId"], "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next"),
    )

    assert failed.payload["kind"] == "failed"
    assert failed.payload["error"] == {
        "code": "invalid_input",
        "message": "sim.run only accepts a task registered by this BuiltMeasurement",
    }
    assert calls == 0


@pytest.mark.asyncio
async def test_sim_run_validates_actual_kernel_output_against_resolved_data_schema(monkeypatch):
    async def fake_kernel(task, state, inputs, world, progress):
        return {
            "state": None,
            "artifacts": {"totalCurrent": {"value": np.asarray([1.0, 2.0])}},
            "observations": {},
        }

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=payload()),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    failed = await cae_simulation_next(
        DataChannelMessage(
            id="next",
            type="cae.simulation.next",
            payload={"runId": start.payload["runId"], "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next"),
    )

    assert failed.payload["kind"] == "failed"
    assert failed.payload["error"]["code"] == "invalid_tensor"
    assert "tensor rank" in failed.payload["error"]["message"]


@pytest.mark.parametrize(
    "mutation",
    [
        'tasks["electric"] = tasks["electric"]',
        'tasks["electric"]["config"]["rogue"] = 1',
        'vars["rogue"] = 1',
    ],
)
@pytest.mark.asyncio
async def test_simulation_rejects_mutation_assignment_targets(mutation, monkeypatch):
    request = payload()
    program = request["measurement"]["experiment"]["simulationProgram"]
    source = (
        "async def simulate(*, sim, tasks, vars):\n"
        f"    {mutation}\n"
        '    return await sim.run(tasks["electric"])\n'
    )
    program["pythonSource"] = source
    calls = 0

    async def fake_kernel(task, state, inputs, world, progress):
        nonlocal calls
        calls += 1
        return {"state": None, "artifacts": {}, "observations": {}}

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert start.payload["kind"] == "failed"
    assert start.payload["error"]["code"] == "invalid_program"
    assert "local names" in start.payload["error"]["message"]
    assert calls == 0

@pytest.mark.parametrize(
    "second_arguments",
    [
        'state=coarse["state"], inputs={"heatSource": coarse["artifacts"]["heatSource"]}',
        '{"state": coarse["state"], "inputs": {"heatSource": coarse["artifacts"]["heatSource"]}}',
    ],
)
@pytest.mark.asyncio
async def test_sim_run_forwards_state_and_owned_artifact_to_registered_kernel(
    second_arguments,
    monkeypatch,
):
    request = payload()
    program = request["measurement"]["experiment"]["simulationProgram"]
    program["tasks"] = {
        "solveCoarse": {
            "kernel": {"name": "dc-current-density", "version": "0.1.0"},
            "config": task_config("dc-current-density", "dc.joule-heating", "heatSource"),
        },
        "solveFine": {
            "kernel": {"name": "steady-state-heat", "version": "0.1.0"},
            "config": task_config(
                "steady-state-heat",
                "heat.maximum-temperature",
                "maximumTemperature",
            ),
        },
    }
    experiment = request["measurement"]["experiment"]
    scene = experiment["taskScenes"]["electric"]
    experiment["taskScenes"] = {name: scene for name in program["tasks"]}
    request["measurement"]["taskMaterialParameters"] = {
        name: {"schemaVersion": 1, "materials": {}} for name in program["tasks"]
    }
    request["measurement"]["taskMaterialWarnings"] = {name: [] for name in program["tasks"]}
    program["recordedData"] = {
        "maximumTemperature": {
            "dtype": "float64",
            "unit": "K",
            "quantityKind": "thermodynamics.Temperature",
            "tensorOrder": 0,
        }
    }
    source = (
        "async def simulate(*, sim, tasks, vars):\n"
        '    coarse = await sim.run(tasks["solveCoarse"])\n'
        f'    fine = await sim.run(tasks["solveFine"], {second_arguments})\n'
        '    await sim.record("maximumTemperature", fine["artifacts"]["maximumTemperature"])\n'
        '    return fine["state"]\n'
    )
    program["pythonSource"] = source
    calls = []
    produced = []

    async def fake_kernel(task, state, inputs, world, progress):
        calls.append({"task": task, "state": state, "inputs": inputs})
        artifacts = fake_artifacts(task)
        produced.extend(artifacts.values())
        return {
            "state": {"step": len(calls)},
            "artifacts": artifacts,
            "observations": {},
        }

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )
    run_id = start.payload["runId"]

    record = await cae_simulation_next(
        DataChannelMessage(
            id="next-1",
            type="cae.simulation.next",
            payload={"runId": run_id, "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next-1"),
    )
    run = memory["runs"][run_id]
    complete = await cae_simulation_next(
        DataChannelMessage(
            id="next-2",
            type="cae.simulation.next",
            payload={"runId": run_id, "ackSequence": record.payload["sequence"]},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next-2"),
    )

    assert calls[0]["state"] is None
    assert calls[0]["inputs"] == {}
    assert calls[1]["state"] == {"step": 1}
    assert calls[1]["inputs"]["heatSource"] is produced[0]
    assert set(complete.payload) == {"kind", "sequence", "recordSequences"}
    assert [entry["task"] for entry in run.trace] == [
        "solveCoarse",
        "solveFine",
    ]
    assert run.trace[0]["inputStateRevision"] == 0
    assert run.trace[0]["outputStateRevision"] == 1
    assert run.trace[0]["inputArtifacts"] == {}
    assert run.trace[1]["inputStateRevision"] == 1
    assert run.trace[1]["outputStateRevision"] == 2
    assert run.trace[1]["inputArtifacts"] == {
        "heatSource": {
            "id": "artifact-1",
            "artifactType": "caemble.dc/joule-heating@1",
        }
    }


@pytest.mark.asyncio
async def test_sim_run_rejects_fabricated_state_before_kernel_execution(monkeypatch):
    request = payload()
    program = request["measurement"]["experiment"]["simulationProgram"]
    source = (
        "async def simulate(*, sim, tasks, vars):\n"
        '    return await sim.run(tasks["electric"], state={"forged": True})\n'
    )
    program["pythonSource"] = source
    calls = 0

    async def fake_kernel(task, state, inputs, world, progress):
        nonlocal calls
        calls += 1
        return {"state": None, "artifacts": {}, "observations": {}}

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    failed = await cae_simulation_next(
        DataChannelMessage(
            id="next",
            type="cae.simulation.next",
            payload={"runId": start.payload["runId"], "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next"),
    )

    assert failed.payload["kind"] == "failed"
    assert failed.payload["error"]["code"] == "invalid_state"
    assert calls == 0


@pytest.mark.parametrize(
    "case_payload, expected",
    [
        (
            artifact_chain_payload(
                '{"value": 14.9, "unit": "V"}',
            ),
            "live artifact returned by sim.run",
        ),
        (
            artifact_chain_payload(
                'produced["artifacts"]["heatSource"]',
                input_name="wrongPort",
            ),
            "is not declared",
        ),
        (
            artifact_chain_payload(
                'produced["artifacts"]["heatSource"]',
                producer_method="dc.total-current",
            ),
            "rejects artifact type",
        ),
    ],
)
@pytest.mark.asyncio
async def test_sim_run_rejects_unowned_or_incompatible_artifacts_before_consumer_kernel(
    case_payload,
    expected,
    monkeypatch,
):
    calls = 0

    async def fake_kernel(task, state, inputs, world, progress):
        nonlocal calls
        calls += 1
        return {
            "state": None,
            "artifacts": fake_artifacts(task),
            "observations": {},
        }

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=case_payload),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )
    failed = await cae_simulation_next(
        DataChannelMessage(
            id="next",
            type="cae.simulation.next",
            payload={"runId": start.payload["runId"], "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next"),
    )

    assert failed.payload["kind"] == "failed"
    assert failed.payload["error"]["code"] == "invalid_input"
    assert expected in failed.payload["error"]["message"]
    assert calls == 1


@pytest.mark.asyncio
async def test_sim_run_rejects_an_artifact_after_release(monkeypatch):
    request = artifact_chain_payload('produced["artifacts"]["heatSource"]')
    program = request["measurement"]["experiment"]["simulationProgram"]
    source = (
        "async def simulate(*, sim, tasks, vars):\n"
        '    produced = await sim.run(tasks["producer"])\n'
        '    artifact = produced["artifacts"]["heatSource"]\n'
        "    sim.release(artifact)\n"
        '    await sim.run(tasks["consumer"], inputs={"heatSource": artifact})\n'
        "    return None\n"
    )
    program["pythonSource"] = source
    calls = 0

    async def fake_kernel(task, state, inputs, world, progress):
        nonlocal calls
        calls += 1
        return {
            "state": None,
            "artifacts": fake_artifacts(task),
            "observations": {},
        }

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )
    failed = await cae_simulation_next(
        DataChannelMessage(
            id="next",
            type="cae.simulation.next",
            payload={"runId": start.payload["runId"], "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next"),
    )

    assert failed.payload["kind"] == "failed"
    assert failed.payload["error"]["code"] == "invalid_input"
    assert "live artifact returned by sim.run" in failed.payload["error"]["message"]
    assert calls == 1


@pytest.mark.asyncio
async def test_duplicate_record_name_returns_terminal_domain_failure(monkeypatch):
    request = payload()
    source = (
        "async def simulate(*, sim, tasks, vars):\n"
        "    result = await sim.run(tasks[\"electric\"])\n"
        "    await sim.record(\"totalCurrent\", result[\"artifacts\"][\"totalCurrent\"])\n"
        "    await sim.record(\"totalCurrent\", result[\"artifacts\"][\"totalCurrent\"])\n"
        "    return result[\"state\"]\n"
    )
    request["measurement"]["experiment"]["simulationProgram"]["pythonSource"] = source

    async def fake_kernel(task, state, inputs, world, progress):
        return {
            "state": {"done": True},
            "artifacts": {"totalCurrent": {"value": 1.0}},
            "observations": {},
        }

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )
    run_id = start.payload["runId"]

    first = await cae_simulation_next(
        DataChannelMessage(
            id="next-1",
            type="cae.simulation.next",
            payload={"runId": run_id, "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next-1"),
    )
    failed = await cae_simulation_next(
        DataChannelMessage(
            id="next-2",
            type="cae.simulation.next",
            payload={"runId": run_id, "ackSequence": first.payload["sequence"]},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next-2"),
    )

    assert failed.payload == {
        "kind": "failed",
        "sequence": 2,
        "error": {
            "code": "invalid_record",
            "message": "RecordedData 'totalCurrent' was already recorded",
        },
    }


@pytest.mark.asyncio
async def test_failed_record_encoding_does_not_consume_a_protocol_sequence(monkeypatch):
    request = payload()
    source = (
        "async def simulate(*, sim, tasks, vars):\n"
        '    await sim.record("totalCurrent", {"value": [1.0]})\n'
        "    return None\n"
    )
    program = request["measurement"]["experiment"]["simulationProgram"]
    program["pythonSource"] = source
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    failed = await cae_simulation_next(
        DataChannelMessage(
            id="next",
            type="cae.simulation.next",
            payload={"runId": start.payload["runId"], "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next"),
    )

    assert failed.payload["kind"] == "failed"
    assert failed.payload["sequence"] == 1
    assert failed.payload["error"]["code"] == "invalid_tensor"


@pytest.mark.asyncio
async def test_start_rejects_incomplete_built_measurement(monkeypatch):
    emitted = []
    monkeypatch.setattr("app.handlers.emit", emitted.append)
    memory = {"runs": {}}
    response = await cae_simulation_start(
        DataChannelMessage(
            id="start",
            type="cae.simulation.start",
            payload={"measurement": {"kind": "measurement"}},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert response.payload["kind"] == "failed"
    assert response.payload["sequence"] == 0
    assert response.payload["error"]["code"] == "invalid_input"
    assert emitted == [{"type": "cae.run.cleaned", "job_id": "session", "run_id": None}]


@pytest.mark.parametrize(
    "variables, schema",
    [
        ({"width": 11}, {"width": {"min": 1, "max": 10}}),
        ({"width": [4]}, {"width": {"min": 1, "max": 10}}),
        ({"width": 4, "extra": 1}, {"width": {"min": 1, "max": 10}}),
        ({"width": True}, {"width": {"min": 1, "max": 10}}),
    ],
)
@pytest.mark.asyncio
async def test_start_validates_variables_against_vars_schema(variables, schema):
    request = payload()
    request["measurement"]["experiment"]["variables"] = variables
    request["measurement"]["experiment"]["varsSchema"] = schema

    response = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        {"runs": {}},
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert response.payload["kind"] == "failed"
    assert response.payload["error"]["code"] == "invalid_input"


@pytest.mark.parametrize(
    "field, value",
    [
        ("source", 7),
        ("materialId", True),
        (
            "value",
            {"dtype": "float16", "value": [[70000, 0, 0], [0, 70000, 0], [0, 0, 70000]], "unit": "S.m-1"},
        ),
    ],
)
@pytest.mark.asyncio
async def test_start_validates_material_value_and_provenance(field, value):
    request = payload()
    entry = {
        "origin": "source",
        "value": {
            "dtype": "float64",
            "value": [[5.96e7, 0, 0], [0, 5.96e7, 0], [0, 0, 5.96e7]],
            "unit": "S.m-1",
        },
        "source": "reference",
        "version": "1",
        "materialId": None,
        "materialParameterId": None,
    }
    entry[field] = value
    request["measurement"]["materialParameters"]["materials"] = {
        "Copper": {"electrical.conductivity": entry}
    }

    response = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        {"runs": {}},
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert response.payload["kind"] == "failed"
    assert response.payload["error"]["code"] == "invalid_input"


@pytest.mark.asyncio
async def test_start_accepts_canonical_variables_and_material_snapshot(monkeypatch):
    request = payload()
    request["measurement"]["experiment"]["variables"] = {"width": [4, 5]}
    request["measurement"]["experiment"]["varsSchema"] = {
        "width": {"min": 1, "max": [10, 12]}
    }
    request["measurement"]["materialParameters"]["materials"] = {
        "Copper": {
            "electrical.conductivity": {
                "origin": "source",
                "value": {
                    "dtype": "float64",
                    "value": [[5.96e7, 0, 0], [0, 5.96e7, 0], [0, 0, 5.96e7]],
                    "unit": "S.m-1",
                },
                "source": "reference",
                "version": "1",
                "materialId": None,
                "materialParameterId": None,
            }
        }
    }
    request["measurement"]["materialParameters"]["materialColors"] = {
        "Copper": {"color": "#d97706", "materialId": 7}
    }
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}

    response = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    assert response.payload["kind"] == "started"
    memory["runs"][response.payload["runId"]].abort()


@pytest.mark.asyncio
async def test_sim_random_is_not_part_of_python_api_v3():
    request = payload()
    request["measurement"]["experiment"]["simulationProgram"]["pythonSource"] = (
        "async def simulate(*, sim, tasks, vars):\n"
        "    return sim.random()\n"
    )
    response = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        {"runs": {}},
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )
    assert response.payload["kind"] == "failed"
    assert response.payload["error"]["code"] == "invalid_program"


@pytest.mark.asyncio
async def test_sim_release_clears_owned_numpy_buffers_and_rejects_views(monkeypatch):
    monkeypatch.setattr("app.runtime.emit", lambda *_args: None)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=payload()),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )
    run = memory["runs"][start.payload["runId"]]
    owned = np.arange(12, dtype=np.float64)
    artifact = {"value": owned, "axes": [{"ticks": [0, 1, 2]}]}

    run.release(artifact)

    assert artifact == {}
    assert owned.shape == (0,)

    base = np.arange(8, dtype=np.float64)
    view = base[::2]
    with pytest.raises(CaeError, match="NumPy view") as error:
        run.release(view)
    assert error.value.code == "invalid_release"
    assert base.shape == (8,)
    assert view.shape == (4,)
    run.abort()


@pytest.mark.asyncio
async def test_sim_release_rejects_values_not_returned_by_sim_run(monkeypatch):
    request = payload()
    source = (
        "async def simulate(*, sim, tasks, vars):\n"
        "    sim.release(tasks[\"electric\"])\n"
        "    return None\n"
    )
    request["measurement"]["experiment"]["simulationProgram"]["pythonSource"] = source
    monkeypatch.setattr("app.runtime.emit", lambda *_args: None)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=request),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )

    response = await cae_simulation_next(
        DataChannelMessage(
            id="next",
            type="cae.simulation.next",
            payload={"runId": start.payload["runId"], "ackSequence": None},
        ),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="next"),
    )

    assert response.payload["kind"] == "failed"
    assert response.payload["error"]["code"] == "invalid_release"


@pytest.mark.asyncio
async def test_sim_release_keeps_owned_graphs_alive_and_rejects_injected_descendants(monkeypatch):
    monkeypatch.setattr("app.runtime.emit", lambda *_args: None)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=payload()),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )
    run = memory["runs"][start.payload["runId"]]
    sim = SimulationApi(run)
    owned = np.arange(4, dtype=np.float64)
    output = {"artifacts": {"value": owned}}
    output_id = id(output)
    sim._register_releasable(output)

    del output
    gc.collect()

    retained = sim._releasable[output_id]
    injected = np.arange(3, dtype=np.float64)
    retained["artifacts"]["injected"] = injected
    with pytest.raises(CaeError, match="not returned by sim.run") as error:
        sim.release(retained)

    assert error.value.code == "invalid_release"
    assert owned.shape == (4,)
    assert injected.shape == (3,)
    run.abort()


@pytest.mark.asyncio
async def test_rejects_duplicate_or_stale_ack(monkeypatch):
    gate = asyncio.Event()

    async def fake_kernel(task, state, inputs, world, progress):
        await gate.wait()
        return {"state": None, "artifacts": {}, "observations": {}}

    monkeypatch.setattr("app.runtime.run_kernel", fake_kernel)
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    start = await cae_simulation_start(
        DataChannelMessage(id="start", type="cae.simulation.start", payload=payload()),
        memory,
        SlaveContext(session_id="session", ttl_seconds=10, call_id="start"),
    )
    run_id = start.payload["runId"]

    with pytest.raises(ProtocolError, match="unexpected ACK"):
        await cae_simulation_next(
            DataChannelMessage(
                id="next",
                type="cae.simulation.next",
                payload={"runId": run_id, "ackSequence": 1},
            ),
            memory,
            SlaveContext(session_id="session", ttl_seconds=10, call_id="next"),
        )

    assert run_id not in memory["runs"]


@pytest.mark.asyncio
async def test_run_is_owned_by_one_job_and_new_job_cleans_stale_run(monkeypatch):
    monkeypatch.setattr("app.runtime.validate_kernel_tasks", lambda *_args: None)
    memory = {"runs": {}}
    first = await cae_simulation_start(
        DataChannelMessage(id="start-1", type="cae.simulation.start", payload=payload()),
        memory,
        SlaveContext(session_id="job-1", ttl_seconds=10, call_id="start-1"),
    )
    first_run_id = first.payload["runId"]

    with pytest.raises(ProtocolError, match="different Caemble job"):
        await cae_simulation_next(
            DataChannelMessage(
                id="next",
                type="cae.simulation.next",
                payload={"runId": first_run_id, "ackSequence": None},
            ),
            memory,
            SlaveContext(session_id="job-2", ttl_seconds=10, call_id="next"),
        )

    second = await cae_simulation_start(
        DataChannelMessage(id="start-2", type="cae.simulation.start", payload=payload()),
        memory,
        SlaveContext(session_id="job-2", ttl_seconds=10, call_id="start-2"),
    )

    assert first_run_id not in memory["runs"]
    assert second.payload["runId"] in memory["runs"]
    memory["runs"][second.payload["runId"]].abort()
