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
    "curved-tower-shell", "boolean-connection-solid",
    "structural-nonlinear-materials", "structural-optical-results",
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
                        array = np.asarray(storage["value"]).reshape(value["shape"])
                    else:
                        raw = b"".join(attachments[identifier] for identifier in storage["ids"])
                        array = (np.asarray(json.loads(raw.decode("utf-8"))) if schema["dtype"] == "string"
                                 else np.frombuffer(raw, dtype=dtype_for(schema["dtype"]))).reshape(value["shape"])
                    assert list(array.shape) == value["shape"]
                    assert array.size > 0 or name.endswith((
                        ".domain.metadata.loadPoints", ".domain.metadata.loadVectors",
                        ".domain.metadata.supportNodes",
                    )), name
                    if schema["dtype"] != "string":
                        assert np.all(np.isfinite(array)), name
                    if key == "structural-analysis-modes" and name.startswith(("modal.", "harmonic.", "buckling.", "transient.")):
                        # Calculation requires stored axis metadata in addition to tensor shape.
                        assert len(value.get("axes", ())) == len(schema.get("axes", ())), name
                        if name == "transient.rotorSpeed":
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
        if key == "structural-analysis-modes":
            assert len(run.trace) > task_count
        else:
            assert len(run.trace) == task_count
        if "totalCurrent" in recorded:
            assert recorded["totalCurrent"] > 0
        if "maximumTemperature" in recorded:
            assert recorded["maximumTemperature"] > measurement["experiment"]["variables"]["fixedTemperature"]
        if "detectorPower" in recorded:
            assert recorded["detectorPower"] > 0
            if "detectorEfficiency" in recorded:
                assert 0 < recorded["detectorEfficiency"] <= 1
        for name, contract in measurement["experiment"]["simulationProgram"]["resultContracts"].items():
            if contract["visualization"]["kind"] == "polyline":
                offsets = recorded[name + "." + contract["visualization"]["offsets"]]
                vertices = recorded[name + "." + contract["visualization"]["vertices"]]
                assert offsets[-1] == len(vertices)
                assert np.all(np.diff(offsets) >= 2)
        if key == "structural-optical-results":
            assert set(run.recorded_names) == {"displacement", "stress", "reaction", "opticalTrajectories", "secondaryTrajectories", "detectorPower"}
            assert np.max(np.abs(recorded["stress.values"])) > 0
            assert np.max(np.abs(recorded["displacement.values"])) > 0
        if "timeElectricField.field" in recorded:
            assert np.max(np.abs(recorded["timeElectricField.field"])) > 0
        # Recorded mesh topology, physical locations and CAD region provenance are
        # checked independently of the mesher's generated numbering.
        meshes = {}
        for name in recorded:
            if not name.endswith(".domain.kind") or recorded[name].item() != "unstructured-mesh":
                continue
            prefix = name[:-len(".domain.kind")]
            points = recorded[prefix + ".domain.points"]
            cells = recorded[prefix + ".domain.cells.tet4"]
            faces = recorded[prefix + ".domain.metadata.boundaryFaces"]
            regions = recorded[prefix + ".domain.metadata.cellRegions"]
            region_ids = recorded[prefix + ".domain.metadata.regionIds"]
            assert points.ndim == 2 and points.shape[1] == 3
            assert cells.ndim == 2 and cells.shape[1] == 4
            assert faces.ndim == 2 and faces.shape[1] == 3
            assert np.all((cells >= 0) & (cells < len(points)))
            assert np.all((faces >= 0) & (faces < len(points)))
            vertices = points[cells]
            volumes = np.einsum("ij,ij->i", np.cross(vertices[:, 1] - vertices[:, 0], vertices[:, 2] - vertices[:, 0]), vertices[:, 3] - vertices[:, 0]) / 6
            assert np.all(volumes > 0), prefix
            np.testing.assert_allclose(recorded[prefix + ".domain.metadata.quality.cellVolumes"], volumes, rtol=1e-10)
            ratios = recorded[prefix + ".domain.metadata.quality.meanRatios"]
            assert ratios.shape == (len(cells),)
            assert np.all((ratios > 0) & (ratios <= 1))
            assert regions.shape == (len(cells),)
            assert set(regions) == set(range(len(region_ids)))
            scene_ids = {"experiment:" + root["id"] for root in measurement["experiment"]["scene"]["roots"]}
            assert set(region_ids).issubset(scene_ids)
            aliases = {member: recorded[prefix + ".domain.metadata.boundaryProvenance." + member]
                       for member in ("offsets", "sources", "rootIds", "sourceNodeIds", "surfaceIndices")}
            assert aliases["offsets"].shape == (len(faces) + 1,)
            assert aliases["offsets"][0] == 0
            assert np.all(np.diff(aliases["offsets"]) > 0)
            assert all(len(aliases[member]) == aliases["offsets"][-1] for member in aliases if member != "offsets")
            assert np.all(aliases["surfaceIndices"] >= 0)
            primitive_ids = set()
            for root in measurement["experiment"]["scene"]["roots"]:
                pending_nodes = [root["node"]]
                while pending_nodes:
                    node = pending_nodes.pop()
                    if node["kind"] == "primitive":
                        primitive_ids.add(("experiment", root["id"], node["nodeId"]))
                    pending_nodes.extend(node.get("children", ()))
                    if "child" in node:
                        pending_nodes.append(node["child"])
            assert set(zip(aliases["sources"], aliases["rootIds"], aliases["sourceNodeIds"])).issubset(primitive_ids)
            assert len(recorded[prefix + ".domain.identity"].item()) == 64
            assert recorded[prefix + ".domain.lengthUnit"].item() == "m"
            values = recorded[prefix + ".values"]
            if recorded[prefix + ".location"].item() == "node":
                assert values.shape == (len(points), 3)
            else:
                assert recorded[prefix + ".location"].item() == "cell"
                assert values.shape == (len(cells), 6)
            supports = recorded[prefix + ".domain.metadata.supportNodes"]
            assert np.all((supports >= 0) & (supports < len(points)))
            assert recorded[prefix + ".domain.metadata.loadPoints"].shape == recorded[prefix + ".domain.metadata.loadVectors"].shape
            meshes[prefix] = (points, cells, volumes)
        if key == "structural-element-basics":
            loads = {
                "axial": ([1000, 0, 0], [0, 0, 0]),
                "bending": ([0, 0, -1000], [0, 0, 0]),
                "torsion": ([0, 0, 0], [100, 0, 0]),
            }
            for task, (force, moment) in loads.items():
                prefix = task + "_displacement"
                points, _, volumes = meshes[prefix]
                displacement = recorded[prefix + ".values"]
                reactions = recorded[task + "_reaction.values"]
                np.testing.assert_allclose(volumes.sum(), 1 * .3 * .3, rtol=1e-10)
                np.testing.assert_array_equal(recorded[prefix + ".domain.identity"], recorded[task + "_reaction.domain.identity"])
                np.testing.assert_allclose(reactions.sum(axis=0), -np.asarray(force), atol=1e-6)
                np.testing.assert_allclose(np.cross(points - [1, 0, 0], reactions).sum(axis=0), -np.asarray(moment), atol=1e-6)
                support = np.isclose(points[:, 0], 0)
                np.testing.assert_allclose(displacement[support], 0, atol=1e-14)
                faces = recorded[prefix + ".domain.metadata.boundaryFaces"]
                tip_faces = faces[np.all(np.isclose(points[faces, 0], 1), axis=1)]
                tip_triangles = points[tip_faces]
                areas = np.linalg.norm(np.cross(tip_triangles[:, 1] - tip_triangles[:, 0], tip_triangles[:, 2] - tip_triangles[:, 0]), axis=1) / 2
                tip = np.einsum("n,ni->i", areas, displacement[tip_faces].mean(axis=1)) / areas.sum()
                if task == "axial":
                    # A fully clamped 3D end restrains Poisson contraction. The
                    # compliance lies between fully constrained and uniaxial bars.
                    free_extension = 1000 / (210e9 * .3 * .3)
                    constrained_extension = free_extension * (1 + .3) * (1 - 2 * .3) / (1 - .3)
                    assert constrained_extension < tip[0] < free_extension
                elif task == "bending":
                    assert tip[2] < 0
                else:
                    tip_nodes = np.unique(tip_faces)
                    twist_work = points[tip_nodes, 1] * displacement[tip_nodes, 2] - points[tip_nodes, 2] * displacement[tip_nodes, 1]
                    assert twist_work.sum() > 0
        if key == "structural-analysis-modes":
            assert np.all(recorded["modal.frequencies"] > 0)
            assert np.all(np.diff(recorded["modal.frequencies"]) >= 0)
            assert np.all(recorded["buckling.factors"] > 0)
            assert np.all(np.diff(recorded["transient.times"]) > 0)
            np.testing.assert_array_equal(recorded["transient.regionIds"], ["experiment.surface.loaded"])
            assert recorded["transient.displacement"].shape[1:] == (1, 3)
            assert recorded["transient.times"][-1] == pytest.approx(.002)
            assert np.max(np.abs(recorded["harmonic.displacementReal"])) > 0
            assert np.max(np.abs(recorded["transientMesh.values"])) > 0
        if key == "structural-nonlinear-materials":
            assert np.max(recorded["plastic_stress.equivalentPlasticStrain"]) > 0
            for task, force in {"plastic": [35e6, 0, 0], "contact": [0, 0, -200], "laminate": [10000, 0, 0]}.items():
                residual = recorded[task + "_reaction.values"].sum(axis=0) + force
                assert np.linalg.norm(residual) < 1e-6 * np.linalg.norm(force)
            points, cells, _ = meshes["contact_displacement"]
            displaced = points + recorded["contact_displacement.values"]
            slider_bottom = np.isclose(points[:, 2], .1999)
            base_top = np.isclose(points[:, 2], .2)
            assert np.any(slider_bottom) and np.any(base_top)
            penetration = displaced[base_top, 2].max() - displaced[slider_bottom, 2].mean()
            # Contact pressure = penalty * penetration on the 0.4 × 0.4 face.
            assert 0 < penetration < 2 * 200 / (1e9 * .4 * .4)
            contact_regions = recorded["contact_displacement.domain.metadata.cellRegions"]
            assert len(np.intersect1d(cells[contact_regions == 0], cells[contact_regions == 1])) == 0
            points, cells, _ = meshes["laminate_displacement"]
            regions = recorded["laminate_displacement.domain.metadata.cellRegions"]
            shared_nodes = np.intersect1d(cells[regions == 0], cells[regions == 1])
            assert len(shared_nodes) > 0
            np.testing.assert_allclose(points[shared_nodes, 2], .2, atol=1e-10)
            laminate_group = next(group for group in measurement["experiment"]["scene"]["geometryGroups"]
                                  if group["name"] == "laminate")
            assert set(recorded["laminate_displacement.domain.metadata.regionIds"]) == {
                "experiment:" + root_id for root_id in laminate_group["rootIds"]
            }
        if key in {"curved-tower-shell", "boolean-connection-solid"}:
            curved = key == "curved-tower-shell"
            points, cells, volumes = meshes["displacement"]
            supports = recorded["displacement.domain.metadata.supportNodes"]
            np.testing.assert_allclose(points[supports, 2 if curved else 0], 0, atol=1e-10)
            np.testing.assert_array_equal(recorded["displacement.domain.metadata.regionIds"], ["experiment:body"])
            np.testing.assert_allclose(recorded["reaction.values"].sum(axis=0), [-1000 if curved else -10000, 0, 0], atol=1e-5)
            centers = points[cells].mean(axis=1)
            if curved:
                radius, center, expected_volume = .25, [0, 0], np.pi * (.4 ** 2 - .25 ** 2) * 1.2
            else:
                variables = measurement["experiment"]["variables"]
                radius, center = variables["holeRadius"], [variables["holePosition"], 0]
                expected_volume = (1 * .6 - np.pi * radius ** 2) * variables["thickness"]
            np.testing.assert_allclose(volumes.sum(), expected_volume, rtol=5e-4)
            assert np.all(np.linalg.norm(centers[:, :2] - center, axis=1) > radius * np.cos(np.pi / 128) - 1e-10)
            bases = recorded["stress.stressBasis"]
            assert bases.shape == (len(recorded["stress.elementIds"]), 3, 3)
            np.testing.assert_allclose(bases.transpose(0, 2, 1) @ bases, np.broadcast_to(np.eye(3), bases.shape), atol=1e-12)
            np.testing.assert_allclose(np.linalg.det(bases), 1, atol=1e-12)
            assert recorded["stressField.values"].shape == (len(cells), 6)
            provenance_prefix = "displacement.domain.metadata.boundaryProvenance."
            surface_aliases = set(zip(recorded[provenance_prefix + "rootIds"],
                                      recorded[provenance_prefix + "sourceNodeIds"],
                                      recorded[provenance_prefix + "surfaceIndices"]))
            # Selected support/load/hole surfaces survive Boolean evaluation and recording.
            for group in measurement["experiment"]["scene"]["surfaceGroups"]:
                for selector in group["selectors"]:
                    assert (selector["rootId"], selector["sourceNodeId"], selector["surfaceIndex"]) in surface_aliases
        assert run._record_packets == {}
    finally:
        await run.close()
        await asyncio.gather(run.task, return_exceptions=True)


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
                    if packet.name == "displacement":
                        leaves = [("", run.schemas[packet.name], packet.value)]
                        attachments = {item.id: item.data for item in packet.attachments}
                        while leaves:
                            name, schema, value = leaves.pop()
                            if "dtype" not in schema:
                                leaves.extend((f"{name}.{member}".lstrip("."), member_schema, value[member])
                                              for member, member_schema in schema.items())
                                continue
                            storage = value["storage"]
                            if storage["kind"] == "inline":
                                values = np.asarray(storage["value"]).reshape(value["shape"])
                            else:
                                raw = b"".join(attachments[identifier] for identifier in storage["ids"])
                                values = (np.asarray(json.loads(raw.decode("utf-8"))) if schema["dtype"] == "string"
                                          else np.frombuffer(raw, dtype=dtype_for(schema["dtype"]))).reshape(value["shape"])
                            recorded[name] = values.copy()
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
        np.testing.assert_allclose(volumes.sum(), (.6 - np.pi * variables["holeRadius"] ** 2) * variables["thickness"], rtol=5e-4)
        assert np.all(volumes > 0)
        assert recorded["values"].shape == points.shape
        assert np.max(np.abs(recorded["values"])) > 0
        np.testing.assert_allclose(np.ptp(points[:, 2]), variables["thickness"], atol=1e-10)
        hole_center = [variables["holePosition"], 0]
        assert np.all(np.linalg.norm(points[cells].mean(axis=1)[:, :2] - hole_center, axis=1)
                      > variables["holeRadius"] * np.cos(np.pi / 128) - 1e-10)
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
        assert np.all(radial_distances >= variables["holeRadius"] * np.cos(np.pi / 128) - 1e-8)
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
async def test_structural_child_cancellation_preserves_checkpoint_and_releases_buffers(catalog_measurements, monkeypatch):
    """실제 구조 child의 시작 ACK 뒤 취소하고 확정 상태/파일 소유권을 검사한다."""
    measurement = deepcopy(catalog_measurements["structural-analysis-modes"])
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


@pytest.mark.asyncio
async def test_structural_child_rejects_foreign_motion_without_committing_trial(catalog_measurements):
    """다른 실제 구조 child의 운동 파형을 거부한 뒤 원래 checkpoint를 다시 계산한다."""
    measurement = deepcopy(catalog_measurements["structural-analysis-modes"])
    program = measurement["experiment"]["simulationProgram"]
    task = program["tasks"]["transient"]
    motion = next((output for output in task["config"]["outputs"] if output["methodId"] == "fea.motion"), None)
    if motion is None:
        motion = {"methodId": "fea.motion", "key": "motion", "target": [], "parameters": {}}
        task["config"]["outputs"].append(motion)
    program["tasks"]["foreign"] = deepcopy(task)
    # Same CSG and physical conditions, a different solver-generated mesh profile.
    program["tasks"]["foreign"]["config"]["parameters"]["spatialResolution"]["value"] *= .8
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
