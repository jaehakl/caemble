"""Compile every official bundle and execute its nominal Measurement in real children."""
from __future__ import annotations

import asyncio
import json
import subprocess
from copy import deepcopy
from pathlib import Path

import numpy as np
import pytest
from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.run import CaeRun
from app.kernel.execution import (
    MmapPayloadCodec,
    RemoteSolverError,
    SpawnSolverExecutor,
)
from app.kernel.transport import RecordPacket
from app.kernel.transport.tensor import dtype_for
from caemble_catalog import open_catalog


@pytest.fixture(scope="module")
def catalog_measurements(tmp_path_factory):
    repo = Path(__file__).resolve().parents[4]
    output = tmp_path_factory.mktemp("catalog-measurements")
    with open_catalog() as catalog:
        examples, _ = catalog.list_experiments(limit=100)
    measurements = {}
    for example in examples:
        artifact = output / example["key"]
        subprocess.run([
            "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "--repo", str(repo),
            "experiment", "build", "--example", example["coordinate"],
            "--vars-mode", "nominal", "--out", str(artifact),
        ], cwd=repo, check=True, capture_output=True, text=True, encoding="utf-8")
        manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
        assert len(manifest["items"]) == 1
        item = json.loads((artifact / manifest["items"][0]["file"]).read_text(encoding="utf-8"))
        measurements[example["key"]] = item["measurement"]
    return measurements


@pytest.mark.parametrize("key", [
    "fiber-bundle", "shell-cutaways", "random-curved-edge-cylinder-array",
    "random-curved-surface-sphere-hcp-array", "two-material-wheel-assembly",
    "czerny-turner-spectrometer", "electro-thermal-notched-bar",
    "fdtd-drude-slab", "folded-ray-tracing",
    "structural-element-basics", "structural-analysis-modes",
    "curved-tower-shell", "boolean-connection-solid", "nrel5mw-oc3-operating",
    "structural-nonlinear-materials",
])
@pytest.mark.asyncio
async def test_official_catalog_measurement_runs_and_acknowledges_every_record(key, catalog_measurements):
    measurement = catalog_measurements[key]
    run = CaeRun(measurement=measurement, max_run_seconds=240, job_id=f"catalog-{key}")
    run.start()
    recorded = {}
    try:
        while True:
            packet = await asyncio.wait_for(run.queue.get(), timeout=250)
            if isinstance(packet, RecordPacket):
                assert not packet.ack.done()
                assert packet.resource_hold is not None
                leaves = [(packet.name, run.schemas[packet.name], packet.value)]
                attachments = {item.id: item.data for item in packet.attachments}
                while leaves:
                    name, schema, value = leaves.pop()
                    if "dtype" not in schema:
                        leaves.extend((f"{name}.{member}", member_schema, value[member]) for member, member_schema in schema.items())
                        continue
                    storage = value["storage"]
                    if storage["kind"] == "inline":
                        array = np.asarray(storage["value"])
                    else:
                        raw = b"".join(attachments[identifier] for identifier in storage["ids"])
                        array = np.frombuffer(raw, dtype=dtype_for(schema["dtype"])).reshape(value["shape"])
                    assert list(array.shape) == value["shape"]
                    assert array.size > 0
                    if schema["dtype"] != "string":
                        assert np.all(np.isfinite(array)), name
                    if key in {"nrel5mw-oc3-operating", "structural-analysis-modes"} and name.startswith(("history.", "modal.", "harmonic.", "buckling.", "transient.")):
                        # Calculation requires stored axis metadata in addition to tensor shape.
                        assert len(value.get("axes", ())) == len(schema.get("axes", ())), name
                        if name in {"history.rotorSpeed", "transient.rotorSpeed"}:
                            assert value["axes"][0]["unit"] == "s"
                    recorded[name] = array.copy()
                run.pending = packet
                run.acknowledge(packet.sequence)
                assert packet.ack.done()
                assert packet.attachments == []
                continue
            if packet["kind"] in {"complete", "failed"}:
                assert packet["kind"] == "complete", packet
                break
        await run.task
        assert set(run.recorded_names) == set(run.schemas)
        assert run.completed_sequences == list(range(1, len(run.schemas) + 1))
        for name, values in recorded.items():
            if name.endswith(".stress"):
                # A saved stress row must retain its coordinate basis in every example.
                assert recorded[name[:-len("stress")] + "stressBasis"].shape == (len(values), 3, 3)
        task_count = len(measurement["experiment"]["simulationProgram"]["tasks"])
        if key in {"structural-analysis-modes", "nrel5mw-oc3-operating"}:
            assert len(run.trace) > task_count
        else:
            assert len(run.trace) == task_count
        if "totalCurrent" in recorded:
            assert recorded["totalCurrent"] > 0
        if "maximumTemperature" in recorded:
            assert recorded["maximumTemperature"] > measurement["experiment"]["variables"]["fixedTemperature"]
        if "detectorPower" in recorded:
            assert recorded["detectorPower"] > 0
            assert 0 < recorded["detectorEfficiency"] <= 1
        if "rayPaths.pathOffsets" in recorded:
            offsets = recorded["rayPaths.pathOffsets"]
            assert offsets[-1] == len(recorded["rayPaths.vertices"])
            assert len(offsets) == len(recorded["rayPaths.pathWavelength"]) + 1
        if "timeElectricField.field" in recorded:
            assert np.max(np.abs(recorded["timeElectricField.field"])) > 0
        if key == "structural-element-basics":
            # Axial bar: u = FL/(EA). The reaction balances the applied load.
            np.testing.assert_allclose(recorded["truss_displacement"][1, 0], 1000 / (210e9 * .01), rtol=1e-8)
            np.testing.assert_allclose(recorded["truss_reaction"].sum(axis=0), [-1000, 0, 0], atol=1e-6)
            # Timoshenko bending includes both bending and transverse shear compliance.
            expected_tip = -1000 / (3 * 210e9 * 8.333333333e-6) - 1000 / ((210e9 / 2.6) * .008333333333)
            # Sixteen linear elements resolve the bending field; one reduced-shear element is not exact.
            np.testing.assert_allclose(recorded["beam_displacement"][-1, 2], expected_tip, rtol=.01)
        if key == "structural-analysis-modes":
            assert np.all(recorded["modal.frequencies"] > 0)
            assert np.all(recorded["buckling.factors"] > 0)
            assert np.all(np.diff(recorded["transient.times"]) > 0)
            np.testing.assert_array_equal(recorded["transient.nodeIds"], np.arange(9))
        if key == "nrel5mw-oc3-operating":
            assert np.all(np.diff(recorded["history.times"]) > 0)
            # Recorded node rows are selected channels, not the full structural mesh.
            np.testing.assert_array_equal(recorded["history.nodeIds"], [0, 16, 38, 57, 76])
            assert recorded["history.displacement"].shape[1:] == (5, 3)
            assert recorded["history.times"][-1] == pytest.approx(measurement["experiment"]["variables"]["duration"])
            assert np.all(recorded["history.rotorSpeed"] > 0)
            assert np.max(recorded["history.power"]) > 0
            assert np.max(np.abs(recorded["towerDetail.displacement"])) > 0
            assert np.max(np.abs(recorded["foundationDetail.displacement"])) > 0
        if key == "structural-nonlinear-materials":
            assert np.max(recorded["plastic_stress.equivalentPlasticStrain"]) > 0
            # The contact penalty admits a small, bounded penetration under the 200 N load.
            penetration = -(0.01 + recorded["contact_displacement"][3, 2])
            assert 0 < penetration < 200 / 1e6
        if key in {"curved-tower-shell", "boolean-connection-solid"}:
            # These are real child outputs after the Record transport projection.
            # Named global IDs and CAD provenance must survive, not just live meshes.
            curved = key == "curved-tower-shell"
            node_name, face_name = ("topRing", "topBand") if curved else ("loadedNodes", "loadedFaces")
            expected_ids = np.arange(64, 80) if curved else np.array([3, 7, 11, 15, 19, 23])
            prefix = "displacement.domain.metadata."
            np.testing.assert_array_equal(recorded[prefix + f"nodeSets.{node_name}.nodeIds"], expected_ids)
            expected_faces = (
                [[48 + i, 48 + (i + 1) % 16, 64 + (i + 1) % 16, 64 + i] for i in range(16)]
                if curved else [[3, 7, 19, 15], [7, 11, 23, 19]]
            )
            np.testing.assert_array_equal(recorded[prefix + f"faceSets.{face_name}.faces"], expected_faces)
            for path in [f"nodeSets.{node_name}", f"faceSets.{face_name}"]:
                np.testing.assert_array_equal(recorded[prefix + path + ".target"], ["experiment.geometry.body"])
                assert recorded[prefix + path + ".source"].item() == "experiment"
                assert recorded[prefix + path + ".rootId"].item()
                assert len(recorded[prefix + path + ".geometryHash"].item()) == 64
            bases = recorded["stress.stressBasis"]
            assert bases.shape == (len(recorded["stress.elementIds"]), 3, 3)
            np.testing.assert_allclose(bases.transpose(0, 2, 1) @ bases, np.broadcast_to(np.eye(3), bases.shape), atol=1e-12)
            np.testing.assert_allclose(np.linalg.det(bases), 1, atol=1e-12)
            if curved:
                assert not np.allclose(bases, np.eye(3))
                # Reconstruct a world tensor independently; pressure trace is basis invariant.
                stress = recorded["stress.stress"]
                local = np.zeros_like(bases)
                local[:, 0, 0], local[:, 1, 1], local[:, 2, 2] = stress[:, 0], stress[:, 1], stress[:, 2]
                local[:, 0, 1] = local[:, 1, 0] = stress[:, 3]
                world = bases @ local @ bases.transpose(0, 2, 1)
                np.testing.assert_allclose(np.trace(world, axis1=1, axis2=2), stress[:, :3].sum(axis=1), rtol=1e-12)
            else:
                np.testing.assert_array_equal(bases, np.broadcast_to(np.eye(3), bases.shape))
        assert run._record_packets == {}
    finally:
        await run.close()
        await asyncio.gather(run.task, return_exceptions=True)


@pytest.mark.asyncio
async def test_structural_child_cancellation_preserves_checkpoint_and_releases_buffers(catalog_measurements, monkeypatch):
    """실제 구조 child의 시작 ACK 뒤 취소하고 확정 상태/파일 소유권을 검사한다."""
    measurement = deepcopy(catalog_measurements["structural-analysis-modes"])
    config = measurement["experiment"]["simulationProgram"]["tasks"]["transient"]["config"]
    settings = next(item["parameters"] for item in config["initializations"] if item["methodId"] == "fea.time")
    # Many legitimate internal steps keep the second invocation pending for cancellation.
    for key, value in {"dt": 1e-6, "windowSize": .01, "duration": .01, "outputInterval": .01}.items():
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


@pytest.mark.asyncio
async def test_structural_child_rejects_foreign_motion_without_committing_trial(catalog_measurements):
    """다른 실제 구조 child의 운동 파형을 거부한 뒤 원래 checkpoint를 다시 계산한다."""
    measurement = deepcopy(catalog_measurements["structural-analysis-modes"])
    program = measurement["experiment"]["simulationProgram"]
    task = program["tasks"]["transient"]
    task["config"]["outputs"].append({"methodId": "fea.motion", "key": "motion", "target": [], "parameters": {}})
    program["tasks"]["foreign"] = deepcopy(task)
    foreign_nodes = next(item["parameters"] for item in program["tasks"]["foreign"]["config"]["initializations"] if item["methodId"] == "fea.nodes")
    for point in foreign_nodes["positions"]["value"]:
        point[1] += .125
    measurement["experiment"]["taskScenes"]["foreign"] = deepcopy(measurement["experiment"]["taskScenes"]["transient"])
    for field in ("taskMaterialSnapshots", "materialSelections"):
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
        foreign_motion = foreign["artifacts"]["motion"]
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
