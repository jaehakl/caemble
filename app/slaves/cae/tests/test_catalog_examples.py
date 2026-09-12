"""Compile selected official bundles and execute nominal Measurements in real children."""
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
def catalog_measurements(tmp_path_factory, request):
    repo = Path(__file__).resolve().parents[4]
    output = tmp_path_factory.mktemp("catalog-measurements")
    with open_catalog() as catalog:
        examples, _ = catalog.list_experiments(limit=100)
    required = {item.callspec.params["key"] for item in request.session.items
                if hasattr(item, "callspec") and "key" in item.callspec.params}
    if any(item.name.startswith("test_structural_child_") for item in request.session.items):
        required.add("structural-analysis-modes")
    measurements = {}
    for example in examples:
        if example["key"] not in required:
            continue
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


def decode_tensor_tree(schema, value, attachments):
    """Decode the actual packet before ACK releases its attachment buffers."""
    result = {}
    leaves = [("", schema, value)]
    while leaves:
        name, node, tensor = leaves.pop()
        if "dtype" not in node:
            leaves.extend((f"{name}.{member}".lstrip("."), child, tensor[member]) for member, child in node.items())
            continue
        storage = tensor["storage"]
        if storage["kind"] == "inline":
            values = np.asarray(storage["value"]).reshape(tensor["shape"])
        else:
            raw = b"".join(attachments[identifier] for identifier in storage["ids"])
            values = (np.asarray(json.loads(raw.decode("utf-8"))) if node["dtype"] == "string"
                      else np.frombuffer(raw, dtype=dtype_for(node["dtype"]))).reshape(tensor["shape"])
        assert list(values.shape) == tensor["shape"]
        if node["dtype"] != "string":
            assert np.all(np.isfinite(values)), name
        result[name] = values.copy()
    return result


def cylinder_segments(measurement):
    pending = [root["node"] for root in measurement["experiment"]["scene"]["roots"]]
    counts = set()
    while pending:
        node = pending.pop()
        if node["kind"] == "primitive" and node["primitive"] == "cylinder":
            counts.add(node["parameters"]["segments"])
        pending.extend(node.get("children", ()))
        if "child" in node:
            pending.append(node["child"])
    assert len(counts) == 1
    return counts.pop()


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
    program = measurement["experiment"]["simulationProgram"]
    run = CaeRun(measurement=measurement, max_run_seconds=240, job_id=f"catalog-{key}")
    run.start()
    recorded, metadata, visualizations, native = {}, {}, {}, {}
    sequences = []
    try:
        while True:
            packet = await asyncio.wait_for(run.queue.get(), timeout=250)
            if isinstance(packet, RecordPacket):
                assert not packet.ack.done() and packet.resource_hold is not None
                sequences.append(packet.sequence)
                attachments = {item.id: item.data for item in packet.attachments}
                if packet.kind == "visualization":
                    assert packet.name not in visualizations
                    visualizations[packet.name] = deepcopy(packet.value)
                    frozen = program["visualizationContracts"][packet.name]
                    assert set(packet.value).issubset(frozen)
                    for name, item in packet.value.items():
                        assert item["schema"] == frozen[name]["schema"]
                        assert item["contract"] == {k: v for k, v in frozen[name].items() if k != "schema"}
                        assert item["provenance"]["task"] == packet.name
                        assert item["provenance"]["solver"] == program["tasks"][packet.name]["kernel"]
                        leaves = decode_tensor_tree(item["schema"], item["data"], attachments)
                        native.update({f"{packet.name}.{name}.{member}": values for member, values in leaves.items()})
                else:
                    schema, tensor = run.schemas[packet.name], packet.value
                    assert schema["dtype"] in {"float32", "float64"}
                    assert [axis["name"] for axis in schema["axes"]] == ["x", "y", "z", "time", "frequency", "amplitudePhase", "component"]
                    values = decode_tensor_tree(schema, tensor, attachments)[""]
                    assert values.ndim == 7 and all(size > 0 for size in values.shape)
                    assert tensor["boxGrid"] == program["boxGrids"][packet.name]
                    assert list(values.shape[:3]) == tensor["boxGrid"]["gridShape"]
                    assert len(tensor["axes"]) == 7
                    assert values.shape[5:] == (len(schema["boxGrid"]["channels"]), len(schema["boxGrid"]["components"]))
                    for identity in ("task", "solver", "catalogRevision"):
                        assert tensor["provenance"][identity] == program["resultContracts"][packet.name][identity]
                    assert tensor["provenance"]["invocation"] > 0
                    for axis in range(3):
                        expected = (np.arange(values.shape[axis]) + .5) * tensor["boxGrid"]["size"][axis] / values.shape[axis]
                        np.testing.assert_allclose(tensor["axes"][axis]["ticks"], expected)
                    recorded[packet.name], metadata[packet.name] = values, deepcopy(tensor)
                run.pending = packet
                run.acknowledge(packet.sequence)
                assert packet.ack.done() and packet.attachments == []
                continue
            if packet["kind"] in {"complete", "failed"}:
                assert packet["kind"] == "complete", packet
                break
        await run.task
        assert set(run.recorded_names) == set(run.schemas)
        assert sequences == list(range(1, len(sequences) + 1))
        assert sorted(run.completed_sequences + run.visualization_sequences) == sequences
        assert len(run.completed_sequences) == len(run.schemas)
        assert len(run.visualization_sequences) == len(visualizations)
        assert set(visualizations) == {name for name, task in program["tasks"].items()
                                       if task["kernel"]["name"] in {"structural-mechanics", "ray-tracing"}}
        for task, items in visualizations.items():
            expected = {"paths"} if program["tasks"][task]["kernel"]["name"] == "ray-tracing" else {"displacement", "stress"}
            if program["tasks"][task]["config"]["parameters"].get("analysis") == "transient":
                expected.add("displacementHistory")
            assert set(items) == expected
            for name, item in items.items():
                if item["contract"]["visualization"]["kind"] == "polyline":
                    prefix, contract = f"{task}.{name}.", item["contract"]["visualization"]
                    offsets, vertices = native[prefix + contract["offsets"]], native[prefix + contract["vertices"]]
                    assert offsets[-1] == len(vertices) and np.all(np.diff(offsets) >= 2)
        task_count = len(program["tasks"])
        assert len(run.trace) > task_count if key == "structural-analysis-modes" else len(run.trace) == task_count
        if "totalCurrent" in recorded:
            assert recorded["totalCurrent"].item() > 0
        if "maximumTemperature" in recorded:
            assert recorded["maximumTemperature"].item() > measurement["experiment"]["variables"]["fixedTemperature"]
        for name, values in recorded.items():
            if name.endswith("FluenceRate") or name == "timeElectricField":
                assert np.max(np.abs(values)) > 0
        if key == "structural-optical-results":
            assert set(recorded) == {"displacement", "stress", "reaction", "traceFluenceRate", "traceRadiantFluxDensity", "secondaryFluenceRate", "secondaryRadiantFluxDensity"}
            assert np.max(np.abs(recorded["stress"])) > 0 and np.max(np.abs(recorded["displacement"])) > 0

        # Native visual snapshots still preserve physical topology, coordinates,
        # quality and CAD provenance, independently of numerical Box samples.
        meshes = {}
        for name, kind in native.items():
            if not name.endswith(".domain.kind") or kind.item() != "unstructured-mesh":
                continue
            prefix = name[:-len(".domain.kind")]
            points, cells = native[prefix + ".domain.points"], native[prefix + ".domain.cells.tet4"]
            faces = native[prefix + ".domain.metadata.boundaryFaces"]
            regions, region_ids = native[prefix + ".domain.metadata.cellRegions"], native[prefix + ".domain.metadata.regionIds"]
            assert points.ndim == 2 and points.shape[1] == 3
            assert cells.ndim == 2 and cells.shape[1] == 4
            assert faces.ndim == 2 and faces.shape[1] == 3
            assert np.all((cells >= 0) & (cells < len(points)))
            assert np.all((faces >= 0) & (faces < len(points)))
            vertices = points[cells]
            volumes = np.einsum("ij,ij->i", np.cross(vertices[:, 1] - vertices[:, 0], vertices[:, 2] - vertices[:, 0]), vertices[:, 3] - vertices[:, 0]) / 6
            assert np.all(volumes > 0)
            np.testing.assert_allclose(native[prefix + ".domain.metadata.quality.cellVolumes"], volumes, rtol=1e-10)
            ratios = native[prefix + ".domain.metadata.quality.meanRatios"]
            assert ratios.shape == (len(cells),) and np.all((ratios > 0) & (ratios <= 1))
            assert regions.shape == (len(cells),) and set(regions) == set(range(len(region_ids)))
            scene_ids = {"experiment:" + root["id"] for root in measurement["experiment"]["scene"]["roots"]}
            assert set(region_ids).issubset(scene_ids)
            aliases = {member: native[prefix + ".domain.metadata.boundaryProvenance." + member]
                       for member in ("offsets", "sources", "rootIds", "sourceNodeIds", "surfaceIndices")}
            assert aliases["offsets"].shape == (len(faces) + 1,) and aliases["offsets"][0] == 0
            assert np.all(np.diff(aliases["offsets"]) > 0)
            assert all(len(aliases[member]) == aliases["offsets"][-1] for member in aliases if member != "offsets")
            assert np.all(aliases["surfaceIndices"] >= 0)
            assert len(native[prefix + ".domain.identity"].item()) == 64
            assert native[prefix + ".domain.lengthUnit"].item() == "m"
            values = native[prefix + ".values"]
            assert values.shape == ((len(points), 3) if native[prefix + ".location"].item() == "node" else (len(cells), 6))
            supports = native[prefix + ".domain.metadata.supportNodes"]
            assert np.all((supports >= 0) & (supports < len(points)))
            assert native[prefix + ".domain.metadata.loadPoints"].shape == native[prefix + ".domain.metadata.loadVectors"].shape
            meshes[prefix] = (points, cells, volumes)
        if key == "structural-element-basics":
            for task, force in {"axial": [1000, 0, 0], "bending": [0, 0, -1000], "torsion": [0, 0, 0]}.items():
                prefix = task + ".displacement"
                points, _, volumes = meshes[prefix]
                displacement = native[prefix + ".values"]
                np.testing.assert_allclose(volumes.sum(), 1 * .3 * .3, rtol=1e-10)
                np.testing.assert_allclose(recorded[task + "_reaction"].reshape(3), -np.asarray(force), atol=1e-6)
                np.testing.assert_allclose(displacement[np.isclose(points[:, 0], 0)], 0, atol=1e-14)
                faces = native[prefix + ".domain.metadata.boundaryFaces"]
                tip_faces = faces[np.all(np.isclose(points[faces, 0], 1), axis=1)]
                triangles = points[tip_faces]
                areas = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1) / 2
                tip = np.einsum("n,ni->i", areas, displacement[tip_faces].mean(axis=1)) / areas.sum()
                if task == "axial":
                    free = 1000 / (210e9 * .3 * .3)
                    assert free * (1 + .3) * (1 - 2 * .3) / (1 - .3) < tip[0] < free
                elif task == "bending":
                    assert tip[2] < 0
                else:
                    nodes = np.unique(tip_faces)
                    assert (points[nodes, 1] * displacement[nodes, 2] - points[nodes, 2] * displacement[nodes, 1]).sum() > 0
        if key == "structural-analysis-modes":
            frequencies = metadata["modal"]["axes"][4]["ticks"]
            assert np.all(np.asarray(frequencies) > 0) and np.all(np.diff(frequencies) >= 0)
            assert np.all(recorded["bucklingFactor"] > 0)
            times = metadata["transient"]["axes"][3]["ticks"]
            assert np.all(np.diff(times) > 0) and times[-1] == pytest.approx(.002)
            assert np.max(recorded["harmonic"][:, :, :, :, :, 0, :]) > 0
            assert np.max(np.abs(recorded["transientMesh"])) > 0
            prefix = "transient.displacementHistory"
            animation = native[prefix + ".values"]
            np.testing.assert_array_equal(native[prefix + ".times"], times)
            assert animation.shape[1:] == native[prefix + ".field.domain.points"].shape
            np.testing.assert_allclose(animation[-1], native["transient.displacement.values"])
            assert visualizations["transient"]["displacementHistory"]["provenance"]["invocation"] == 3
        if key == "structural-nonlinear-materials":
            assert np.max(np.abs(recorded["plastic_stress"])) > 0
            for task, force in {"plastic": [35e6, 0, 0], "contact": [0, 0, -200], "laminate": [10000, 0, 0]}.items():
                assert np.linalg.norm(recorded[task + "_reaction"].reshape(3) + force) < 1e-6 * np.linalg.norm(force)
            points, cells, _ = meshes["contact.displacement"]
            displaced = points + native["contact.displacement.values"]
            bottom, top = np.isclose(points[:, 2], .1999), np.isclose(points[:, 2], .2)
            assert np.any(bottom) and np.any(top)
            assert 0 < displaced[top, 2].max() - displaced[bottom, 2].mean() < 2 * 200 / (1e9 * .4 * .4)
            regions = native["contact.displacement.domain.metadata.cellRegions"]
            assert len(np.intersect1d(cells[regions == 0], cells[regions == 1])) == 0
            points, cells, _ = meshes["laminate.displacement"]
            regions = native["laminate.displacement.domain.metadata.cellRegions"]
            shared = np.intersect1d(cells[regions == 0], cells[regions == 1])
            assert len(shared) > 0
            np.testing.assert_allclose(points[shared, 2], .2, atol=1e-10)
        if key in {"curved-tower-shell", "boolean-connection-solid"}:
            curved = key == "curved-tower-shell"
            points, cells, volumes = meshes["detail.displacement"]
            supports = native["detail.displacement.domain.metadata.supportNodes"]
            np.testing.assert_allclose(points[supports, 2 if curved else 0], 0, atol=1e-10)
            np.testing.assert_allclose(recorded["reaction"].reshape(3), [-1000 if curved else -10000, 0, 0], atol=1e-5)
            variables = measurement["experiment"]["variables"]
            radius, center = (.25, [0, 0]) if curved else (variables["holeRadius"], [variables["holePosition"], 0])
            segments = cylinder_segments(measurement)
            polygon_area = segments * np.sin(2 * np.pi / segments) / 2
            expected_volume = polygon_area * (.4 ** 2 - .25 ** 2) * 1.2 if curved else (1 * .6 - polygon_area * radius ** 2) * variables["thickness"]
            np.testing.assert_allclose(volumes.sum(), expected_volume, rtol=5e-4)
            assert np.all(np.linalg.norm(points[cells].mean(axis=1)[:, :2] - center, axis=1) > radius * np.cos(np.pi / segments) - 1e-10)
            prefix = "detail.displacement.domain.metadata.boundaryProvenance."
            aliases = set(zip(native[prefix + "rootIds"], native[prefix + "sourceNodeIds"], native[prefix + "surfaceIndices"]))
            for group in measurement["experiment"]["scene"]["surfaceGroups"]:
                for selector in group["selectors"]:
                    assert (selector["rootId"], selector["sourceNodeId"], selector["surfaceIndex"]) in aliases
        assert not run._record_packets
    finally:
        await run.close()
        await asyncio.gather(run.task, return_exceptions=True)


@pytest.mark.parametrize("key,task_name,expected", [
    ("folded-ray-tracing", "trace", {"paths"}),
    ("structural-element-basics", "axial", {"displacement", "stress"}),
])
@pytest.mark.asyncio
async def test_visualization_only_official_task_needs_no_outputs(key, task_name, expected, catalog_measurements):
    measurement = deepcopy(catalog_measurements[key])
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
    for field in ("taskMaterialSnapshots", "materialSelections"):
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
    motion = next((output for output in task["config"]["exports"] if output["methodId"] == "fea.motion"), None)
    if motion is None:
        motion = {"methodId": "fea.motion", "key": "motion", "target": [], "parameters": {}}
        task["config"]["exports"].append(motion)
    program["tasks"]["foreign"] = deepcopy(task)
    program["visualizationContracts"]["foreign"] = deepcopy(program["visualizationContracts"]["transient"])
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
