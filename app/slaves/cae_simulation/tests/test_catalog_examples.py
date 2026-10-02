"""Compile selected official bundles and execute nominal Measurements in real children."""
from __future__ import annotations

from tests.recording_fixtures import decode_tensor_tree
from tests.catalog_example_fixtures import cylinder_segments, run_catalog_example

import asyncio
import json
import subprocess
from copy import deepcopy
from pathlib import Path

import numpy as np
import pytest
from caemble_catalog import open_catalog
from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.run import CaeRun
from app.kernel.execution import (
    MmapPayloadCodec,
    RemoteSolverError,
    SpawnSolverExecutor,
)
from app.kernel.transport import RecordPacket


with open_catalog() as catalog:
    CATALOG_EXAMPLE_KEYS = tuple(item["key"] for item in catalog.list_experiments(limit=100)[0])


@pytest.mark.parametrize("key", CATALOG_EXAMPLE_KEYS)
@pytest.mark.asyncio
async def test_official_catalog_measurement_runs_and_acknowledges_every_record(key, catalog_builds):
    await run_catalog_example(catalog_builds[key], key)


@pytest.mark.parametrize("key,task_name,expected", [
    ("folded-ray-tracing", "trace", {"paths"}),
    ("structural-element-basics", "axial", {"displacement", "stress"}),
])
@pytest.mark.asyncio
async def test_visualization_only_official_task_needs_no_outputs(key, task_name, expected, catalog_builds):
    measurement = deepcopy(catalog_builds[key])
    program = measurement["experiment"]["simulationProgram"]
    task = program["tasks"][task_name]
    task["config"]["outputs"] = []
    task["config"]["exports"] = []
    program["tasks"] = {task_name: task}
    program["recordedData"], program["resultContracts"], program["boxGrids"] = {}, {}, {}
    program["visualizationContracts"] = {task_name: program["visualizationContracts"][task_name]}
    program["pythonSource"] = f'''async def simulate(*, sim, tasks, vars):
    result = await sim.run(tasks["{task_name}"])
    sim.release(result["state"])
'''
    measurement["experiment"]["taskScenes"] = {task_name: measurement["experiment"]["taskScenes"][task_name]}
    for field in ("taskMaterialSnapshots", "materialSelections", "interactionSelections"):
        measurement[field] = {task_name: measurement[field][task_name]}
    run = CaeRun(measurement=measurement, max_run_seconds=120, job_id=f"visual-only-{key}")
    run.start()
    packets = []
    try:
        while True:
            packet = await asyncio.wait_for(run.queue.get(), timeout=130)
            if isinstance(packet, RecordPacket):
                assert packet.kind == "visualization" and packet.name == task_name
                assert set(packet.value) == expected
                assert not packet.ack.done() and packet.resource_hold is not None
                attachments = {part.id: part.data for part in packet.attachments}
                for item in packet.value.values():
                    leaves = decode_tensor_tree(item["schema"], item["data"], attachments)
                    assert leaves and any(value.size > 0 for value in leaves.values())
                    assert item["provenance"]["task"] == task_name
                    assert item["provenance"]["invocation"] == 1
                packets.append(packet)
                run.pending = packet
                run.acknowledge(packet.sequence)
                assert packet.ack.done() and packet.attachments == []
                continue
            if packet["kind"] in {"complete", "failed"}:
                assert packet["kind"] == "complete", packet
                break
        await run.task
        assert len(packets) == 1 and run.visualization_sequences == [1]
        assert run.completed_sequences == [] and run.recorded_names == []
        assert not run._record_packets
    finally:
        simulation = run.simulation_api
        await run.close()
        await asyncio.gather(run.task, return_exceptions=True)
    assert simulation._resources.stats().resource_count == 0
    assert not simulation._buffers.root.exists()


@pytest.mark.asyncio
async def test_boolean_vars_rebuild_mesh_and_preserve_semantic_boundaries(tmp_path):
    """The unchanged official source follows Vars through CLI, meshing and saved Fields."""
    repo = Path(__file__).resolve().parents[4]
    variants = [
        {"thickness": .18, "holeRadius": .09, "holePosition": .45},
        {"thickness": .22, "holeRadius": .11, "holePosition": .65},
    ]
    snapshots = []
    for index, variables in enumerate(variants):
        vars_path, artifact = tmp_path / f"vars-{index}.json", tmp_path / f"build-{index}"
        vars_path.write_text(json.dumps(variables), encoding="utf-8")
        subprocess.run([
            "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "--repo", str(repo),
            "experiment", "build", "--example", "boolean-connection-solid", "--mode", "candidate",
            "--vars", str(vars_path), "--out", str(artifact),
        ], cwd=repo, check=True, capture_output=True, text=True, encoding="utf-8")
        manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
        built = json.loads((artifact / manifest["items"][0]["file"]).read_text(encoding="utf-8"))
        measurement = built["measurement"]
        assert measurement["experiment"]["variables"] == variables
        run = CaeRun(measurement=measurement, max_run_seconds=240, job_id=f"bracket-vars-{index}")
        run.start()
        recorded = {}
        try:
            while True:
                packet = await asyncio.wait_for(run.queue.get(), timeout=250)
                if isinstance(packet, RecordPacket):
                    if packet.kind == "visualization" and packet.name == "detail":
                        item = packet.value["displacement"]
                        attachments = {item.id: item.data for item in packet.attachments}
                        recorded = decode_tensor_tree(item["schema"], item["data"], attachments)
                    run.pending = packet
                    run.acknowledge(packet.sequence)
                    assert packet.ack.done() and packet.attachments == []
                    continue
                if packet["kind"] in {"complete", "failed"}:
                    assert packet["kind"] == "complete", packet
                    break
            await run.task
            assert set(run.recorded_names) == set(run.schemas)
            assert not run._record_packets
        finally:
            await run.close()
            await asyncio.gather(run.task, return_exceptions=True)
        points, cells = recorded["domain.points"], recorded["domain.cells.tet4"]
        faces = recorded["domain.metadata.boundaryFaces"]
        volumes = recorded["domain.metadata.quality.cellVolumes"]
        segments = cylinder_segments(measurement)
        polygon_area = segments * np.sin(2 * np.pi / segments) / 2
        np.testing.assert_allclose(volumes.sum(), (.6 - polygon_area * variables["holeRadius"] ** 2) * variables["thickness"], rtol=5e-4)
        assert np.all(volumes > 0)
        assert recorded["values"].shape == points.shape
        assert np.max(np.abs(recorded["values"])) > 0
        np.testing.assert_allclose(np.ptp(points[:, 2]), variables["thickness"], atol=1e-10)
        hole_center = [variables["holePosition"], 0]
        assert np.all(np.linalg.norm(points[cells].mean(axis=1)[:, :2] - hole_center, axis=1)
                      > variables["holeRadius"] * np.cos(np.pi / segments) - 1e-10)
        offsets = recorded["domain.metadata.boundaryProvenance.offsets"]
        root_ids = recorded["domain.metadata.boundaryProvenance.rootIds"]
        node_ids = recorded["domain.metadata.boundaryProvenance.sourceNodeIds"]
        surface_indices = recorded["domain.metadata.boundaryProvenance.surfaceIndices"]
        aliases = set(zip(root_ids, node_ids, surface_indices))
        for group in measurement["experiment"]["scene"]["surfaceGroups"]:
            for selector in group["selectors"]:
                assert (selector["rootId"], selector["sourceNodeId"], selector["surfaceIndex"]) in aliases
        hole_faces = [face for face in range(len(faces)) if "body.hole" in node_ids[offsets[face]:offsets[face + 1]]]
        hole_points = points[np.unique(faces[hole_faces])]
        assert len(hole_points) > 0
        np.testing.assert_allclose((hole_points[:, :2].min(axis=0) + hole_points[:, :2].max(axis=0)) / 2, hole_center, atol=1e-8)
        radial_distances = np.linalg.norm(hole_points[:, :2] - hole_center, axis=1)
        assert np.all(radial_distances >= variables["holeRadius"] * np.cos(np.pi / segments) - 1e-8)
        assert np.all(radial_distances <= variables["holeRadius"] + 1e-8)
        supports = recorded["domain.metadata.supportNodes"]
        assert len(supports) > 0
        np.testing.assert_allclose(points[supports, 0], 0, atol=1e-10)
        np.testing.assert_allclose(recorded["values"][supports], 0, atol=1e-14)
        np.testing.assert_allclose(recorded["domain.metadata.loadPoints"][:, 0], 1, atol=1e-10)
        np.testing.assert_allclose(recorded["domain.metadata.loadVectors"].sum(axis=0), [10000, 0, 0], atol=1e-8)
        snapshots.append((manifest, measurement, recorded, aliases))
    before, after = snapshots
    assert before[0]["source_hash"] == after[0]["source_hash"]
    assert before[0]["source_bundle"] == after[0]["source_bundle"]
    assert before[1]["experiment"]["simulationProgram"] == after[1]["experiment"]["simulationProgram"]
    assert before[1]["experiment"]["scene"]["surfaceGroups"] == after[1]["experiment"]["scene"]["surfaceGroups"]
    assert before[1]["experiment"]["scene"]["geometryHash"] != after[1]["experiment"]["scene"]["geometryHash"]
    assert before[2]["domain.identity"].item() != after[2]["domain.identity"].item()
    assert before[3] == after[3]


@pytest.mark.asyncio
async def test_structural_child_cancellation_preserves_checkpoint_and_releases_buffers(catalog_builds, monkeypatch):
    """실제 구조 child의 시작 ACK 뒤 취소하고 확정 상태/파일 소유권을 검사한다."""
    measurement = deepcopy(catalog_builds["structural-analysis-modes"])
    config = measurement["experiment"]["simulationProgram"]["tasks"]["transient"]["config"]
    settings = next(item["parameters"] for item in config["initializations"] if item["methodId"] == "fea.time")
    # A hundred legitimate 3D steps leave a cancellable second invocation without
    # making checkpoint creation itself a 10,000-step performance benchmark.
    for key, value in {"dt": 1e-5, "windowSize": .001, "duration": .01, "outputInterval": .001}.items():
        settings[key]["value"] = value
    run = CaeRun(measurement=measurement, max_run_seconds=60, job_id="structural-cancel")
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=1), cancellation_grace=.1)
    buffer_root = sim._buffers.root
    pending = None
    try:
        initial = await sim.run(run.tasks["transient"])
        checkpoint = initial["state"]
        sim.release(initial["artifacts"])
        saved = checkpoint.to_mutable(copy_arrays=True)
        before = sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())
        started = asyncio.Event()
        from app.kernel.execution import executor as executor_module
        original_log = executor_module.log

        def observe_child_start(message, *args, **kwargs):
            original_log(message, *args, **kwargs)
            if "solver child started" in str(message):
                started.set()

        # Observe the real protocol; the executor, child target, and Solver are unchanged.
        monkeypatch.setattr(executor_module, "log", observe_child_start)
        pending = asyncio.create_task(sim.run(run.tasks["transient"], state=checkpoint))
        await asyncio.wait_for(started.wait(), timeout=20)
        assert not pending.done()
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert sim._states.is_live(checkpoint)
        np.testing.assert_equal(checkpoint.to_mutable(copy_arrays=True), saved)
        assert (sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())) == before
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await run.close()
    assert not buffer_root.exists()
    assert sim._resources.stats().resource_count == 0


@pytest.mark.parametrize("key", ["plate-driven-duct"])
@pytest.mark.asyncio
async def test_harmonic_surface_crosses_children_and_failed_frequency_call_rolls_back(key, catalog_builds):
    """Keep native complex motion alive across a rejected and then successful acoustic child."""
    measurement = deepcopy(catalog_builds[key])
    program = measurement["experiment"]["simulationProgram"]
    program["tasks"]["wrongFrequency"] = deepcopy(program["tasks"]["acoustics"])
    program["visualizationContracts"]["wrongFrequency"] = deepcopy(program["visualizationContracts"]["acoustics"])
    spectrum = next(rule for rule in program["tasks"]["wrongFrequency"]["config"]["initializations"]
                    if rule["methodId"] == "acoustics.spectrum")
    spectrum["parameters"]["frequencies"]["value"][-1] += 1
    measurement["experiment"]["taskScenes"]["wrongFrequency"] = deepcopy(measurement["experiment"]["taskScenes"]["acoustics"])
    for member in ("taskMaterialSnapshots", "materialSelections", "interactionSelections"):
        measurement[member]["wrongFrequency"] = deepcopy(measurement[member]["acoustics"])
    run = CaeRun(measurement=measurement, max_run_seconds=120, job_id="harmonic-native-lifecycle")
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=1))
    buffer_root = sim._buffers.root
    try:
        structure = await sim.run(run.tasks["structure"])
        motion_handle = structure["artifacts"]["surfaceMotion"]
        motion = sim._artifacts.resolve(motion_handle)
        velocity = motion.members["velocity"]
        frequencies = np.asarray(motion.members["frequencies"]["value"])
        displacement = sim._artifacts.resolve(sim._visualizations["structure"]["harmonicDisplacement"]).members["field"]
        assert velocity.domain.identity != displacement.domain.identity
        assert set(velocity.domain.cells) == {"tri3"}
        assert velocity.values.dtype == np.complex64
        assert velocity.values.shape == (len(velocity.domain.points), len(frequencies), 3)
        point_indices = {tuple(point): index for index, point in enumerate(displacement.domain.points)}
        selected = [point_indices[tuple(point)] for point in velocity.domain.points]
        np.testing.assert_allclose(velocity.values, 2j * np.pi * frequencies[None, :, None] * displacement.values[selected], rtol=3e-7, atol=1e-12)
        assert "structural_mechanics" not in structure["state"]
        sim.release(structure["artifacts"], keep=motion_handle)
        before = sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())
        with pytest.raises(RemoteSolverError, match="frequency coordinates must exactly match"):
            await sim.run(run.tasks["wrongFrequency"], state=structure["state"], inputs={"surfaceMotion": motion_handle})
        assert (sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())) == before
        assert sim._artifacts.is_live(motion_handle)
        sound = await sim.run(run.tasks["acoustics"], state=structure["state"], inputs={"surfaceMotion": motion_handle})
        pressure = sim._artifacts.resolve(sound["artifacts"]["pressure"])
        assert np.max(pressure["value"][..., 0, :]) > 0
        assert sound["state"] is structure["state"]
        sim.release(motion_handle)
        with pytest.raises(Exception, match="released|live"):
            await sim.run(run.tasks["acoustics"], state=sound["state"], inputs={"surfaceMotion": motion_handle})
        sim.release(sound["artifacts"])
        sim.release(sound["state"])
    finally:
        await run.close()
    assert not buffer_root.exists()
    assert sim._resources.stats().resource_count == 0


@pytest.mark.asyncio
async def test_structural_child_rejects_foreign_motion_without_committing_trial(catalog_builds):
    """다른 실제 구조 child의 운동 파형을 거부한 뒤 원래 checkpoint를 다시 계산한다."""
    measurement = deepcopy(catalog_builds["structural-analysis-modes"])
    program = measurement["experiment"]["simulationProgram"]
    task = program["tasks"]["transient"]
    motion = next((output for output in task["config"]["exports"] if output["methodId"] == "fea.motion"), None)
    if motion is None:
        motion = {"methodId": "fea.motion", "key": "motion", "target": [], "parameters": {}}
        task["config"]["exports"].append(motion)
    program["tasks"]["foreign"] = deepcopy(task)
    program["visualizationContracts"]["foreign"] = deepcopy(program["visualizationContracts"]["transient"])
    # Same CSG and physical conditions, a different solver-generated mesh profile.
    program["tasks"]["foreign"]["config"]["parameters"]["spatialResolution"]["value"] *= .8
    measurement["experiment"]["taskScenes"]["foreign"] = deepcopy(measurement["experiment"]["taskScenes"]["transient"])
    for field in ("taskMaterialSnapshots", "materialSelections", "interactionSelections"):
        measurement[field]["foreign"] = deepcopy(measurement[field]["transient"])
    run = CaeRun(measurement=measurement, max_run_seconds=60, job_id="structural-reject-trial")
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=1))
    buffer_root = sim._buffers.root
    try:
        initial = await sim.run(run.tasks["transient"])
        checkpoint = initial["state"]
        sim.release(initial["artifacts"])
        foreign = await sim.run(run.tasks["foreign"], state=checkpoint)
        foreign_motion = foreign["artifacts"][motion["key"]]
        sim.release(foreign["artifacts"], keep=foreign_motion)
        sim.release(foreign["state"], keep=checkpoint)
        saved = checkpoint.to_mutable(copy_arrays=True)
        before = sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())
        with pytest.raises(RemoteSolverError, match="motion waveform must start at this model's accepted checkpoint"):
            await sim.run(run.tasks["transient"], state=checkpoint, inputs={"previousMotion": foreign_motion})
        assert sim._states.is_live(checkpoint)
        np.testing.assert_equal(checkpoint.to_mutable(copy_arrays=True), saved)
        assert (sim._resources.stats(), sim._states.revisions(), set(sim._buffers.files())) == before
        sim.release(foreign_motion)
        resumed = await sim.run(run.tasks["transient"], state=checkpoint)
        assert resumed["observations"]["time"] > initial["observations"]["time"]
        assert resumed["state"]["structural_mechanics"]["transient"]["time"] > 0
        sim.release(resumed["artifacts"])
        sim.release(resumed["state"])
        sim.release(checkpoint)
    finally:
        await run.close()
    assert not buffer_root.exists()
    assert sim._resources.stats().resource_count == 0
