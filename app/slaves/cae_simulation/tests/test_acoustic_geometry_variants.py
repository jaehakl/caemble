"""Public candidate builds remesh the same semantic plate/fluid interface as vars change."""

import json
from pathlib import Path
import re
import subprocess
import time

import numpy as np
import pytest

from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.run import CaeRun
from app.kernel.execution import MmapPayloadCodec, SpawnSolverExecutor
from caemble_catalog import open_catalog


@pytest.fixture(scope="module")
def geometry_variants(tmp_path_factory):
    repo = Path(__file__).resolve().parents[4]
    output = tmp_path_factory.mktemp("acoustic-geometry-variants")
    with open_catalog() as catalog:
        example = catalog.experiment("transient-plate-driven-duct")
    source = output / "source"
    for name, content in example["sourceBundle"]["files"].items():
        if name == "experiment.tsx":
            # Preserve the original geometry variants independently of the
            # interactive example's narrower current authoring range.
            for field, low, high in (("width", .06, .1), ("height", .05, .09)):
                content, replacements = re.subn(
                    rf"\b{field}:\s*\{{\s*min:\s*[^,]+,\s*max:\s*[^}}]+\}}",
                    f"{field}: {{ min: {low}, max: {high} }}", content)
                assert replacements == 1
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    candidates = [
        {"width": .08, "height": .07, "thickness": .008, "length": .5},
        {"width": .09, "height": .08, "thickness": .008, "length": .5},
    ]
    built = []
    for index, values in enumerate(candidates):
        variables = output / f"vars-{index}.json"
        variables.write_text(json.dumps(values), encoding="utf-8")
        artifact = output / f"candidate-{index}"
        completed = subprocess.run([
            "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "--repo", str(repo),
            "experiment", "build", str(source),
            "--mode", "candidate", "--vars", str(variables), "--out", str(artifact),
        ], cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=90)
        assert completed.returncode == 0, completed.stdout + completed.stderr
        manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
        assert manifest["mode"] == "candidate" and len(manifest["items"]) == 1
        item = json.loads((artifact / manifest["items"][0]["file"]).read_text(encoding="utf-8"))
        measurement = item["measurement"]
        for task in measurement["experiment"]["simulationProgram"]["tasks"].values():
            config = task["config"]
            config["parameters"]["spatialResolution"].update(value=.02, unit="m")
            if task["kernel"]["name"] == "structural-mechanics":
                config["parameters"]["relativeTolerance"]["value"] = 1e-8
                config["parameters"]["maxIterations"] = 40
                clock = next(rule["parameters"] for rule in config["initializations"] if rule["methodId"] == "fea.time")
                for name, value in {"dt": 1 / 65536, "windowSize": 1 / 2048,
                                    "duration": 1 / 64, "outputInterval": 1 / 65536}.items():
                    clock[name].update(value=value, unit="s")
            else:
                clock = next(rule["parameters"] for rule in config["initializations"] if rule["methodId"] == "acoustics.time")
                clock["dt"].update(value=1 / 65536, unit="s")
                clock.update(totalSteps=1024, windowSteps=32)
                for item in config["outputs"]:
                    item["parameters"]["sampleEvery"] = 1 if item["boxGrid"]["gridShape"] == [1, 1, 1] else 20
        built.append((values, measurement))
    assert built[0][1]["varsHash"] != built[1][1]["varsHash"]
    return built


@pytest.mark.asyncio
async def test_geometry_vars_preserve_semantic_surface_and_actual_waveform_handoff(geometry_variants, record_property):
    identities, mesh_sizes, elapsed = [], [], []
    for index, (variables, measurement) in enumerate(geometry_variants):
        started = time.perf_counter()
        program = measurement["experiment"]["simulationProgram"]
        structure_name = next(name for name, task in program["tasks"].items() if task["kernel"]["name"] == "structural-mechanics")
        sound_name = next(name for name, task in program["tasks"].items() if task["kernel"]["name"] == "pressure-acoustics")
        structure_config = program["tasks"][structure_name]["config"]
        sound_config = program["tasks"][sound_name]["config"]
        export = next(item for item in structure_config["exports"] if item["methodId"] == "fea.transient-surface-motion")
        pressure_key = next(item["key"] for item in sound_config["outputs"] if item["boxGrid"]["gridShape"] != [1, 1, 1])
        # Each candidate retains the canonical primitive geometry; no
        # nodal IDs, connectivity or transfer matrices are supplied to a task.
        assert {rule["methodId"] for rule in structure_config["initializations"]} == {"fea.body", "fea.initial-motion", "fea.time"}
        assert export["target"] == ["experiment.surface.plateFront"]
        run = CaeRun(measurement=measurement, max_run_seconds=240, job_id=f"acoustic-geometry-{index}")
        sim = SimulationApi(run)
        run.simulation_api = sim
        sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=1024))
        buffers = sim._buffers.root
        try:
            initial = await sim.run(run.tasks[structure_name])
            assert sim._artifacts.resolve(initial["artifacts"][export["key"]]).metadata["frameKind"] == "initial"
            sim.release(initial["artifacts"])
            structure = await sim.run(run.tasks[structure_name], state=initial["state"])
            handle = structure["artifacts"][export["key"]]
            actual = sim._artifacts.resolve(handle)
            velocity = actual.members["velocity"]
            points = np.asarray(velocity.domain.points)
            faces = np.asarray(velocity.domain.cells["tri3"])
            times = np.asarray(actual.members["times"]["value"])
            assert actual.metadata["surfaceTargets"] == ("experiment.surface.plateFront",)
            assert actual.metadata["frameKind"] == "solved-window" and actual.metadata["couplingConverged"] is True
            assert actual.metadata["configuration"] == "reference" and actual.metadata["timeOrigin"] == 0.
            np.testing.assert_allclose(points[:, 0], 0., atol=1e-14, rtol=0.)
            np.testing.assert_allclose(np.ptp(points[:, 1:], axis=0), [variables["width"], variables["height"]], atol=1e-14, rtol=0.)
            normals = np.cross(points[faces[:, 1]] - points[faces[:, 0]], points[faces[:, 2]] - points[faces[:, 0]]) / 2
            assert np.all(normals[:, 0] > 0)
            assert np.sum(np.linalg.norm(normals, axis=1)) == pytest.approx(variables["width"] * variables["height"], rel=1e-12)
            provenance = velocity.domain.metadata["boundaryProvenance"]
            surface = next(group for group in measurement["experiment"]["scene"]["surfaceGroups"] if group["name"] == "plateFront")
            expected_aliases = {(selector["rootId"], selector["sourceNodeId"], selector["surfaceIndex"]) for selector in surface["selectors"]}
            assert set(zip(provenance["rootIds"], provenance["sourceNodeIds"], provenance["surfaceIndices"])) == expected_aliases
            assert set(provenance["sources"]) == {"experiment"}
            assert velocity.values.shape == (len(points), len(times), 3) and velocity.values.dtype == np.float64
            assert times[0] == 0. and times[-1] == structure["observations"]["time"]
            assert np.all(np.diff(times) > 0)
            saved_structure = structure["state"].to_mutable()["structural_mechanics"][structure_name]
            assert len(points) < len(saved_structure["velocity"])

            sound = await sim.run(run.tasks[sound_name], state=structure["state"], inputs={"transientSurfaceMotion": handle})
            restart = sound["state"].to_mutable()["pressure_acoustics"][sound_name]["restart"]
            assert restart["step"] * restart["dt"] == pytest.approx(times[-1], rel=0., abs=1e-15)
            assert sound["observations"]["time"] == pytest.approx(times[-1], rel=0., abs=1e-15)
            size = np.array([variables["length"], variables["width"], variables["height"]])
            expected_shape = np.ceil(size / .02).astype(int)
            np.testing.assert_array_equal(restart["gridShape"], expected_shape)
            np.testing.assert_allclose(restart["gridSpacing"], size / expected_shape, rtol=0., atol=1e-15)
            np.testing.assert_allclose(restart["gridOrigin"], [0., -variables["width"] / 2, -variables["height"] / 2], rtol=0., atol=1e-15)
            assert restart["pressure"].shape == tuple(expected_shape)
            assert np.all(np.isfinite(restart["pressure"])) and np.max(abs(restart["pressure"])) > 0.
            pressure = sim._artifacts.resolve(sound["artifacts"][pressure_key])
            assert pressure["value"].ndim == 7 and pressure["value"].dtype == np.float64
            np.testing.assert_allclose(pressure["boxGrid"]["size"], size, rtol=0., atol=1e-15)
            np.testing.assert_array_equal(pressure["value"][:, :, :, 0], 0.)
            recorded_times = np.asarray(pressure["axes"][3]["ticks"])
            assert np.all(np.diff(recorded_times) > 0) and recorded_times[-1] <= times[-1]
            assert np.max(abs(pressure["value"])) > 0.
            identities.append((velocity.domain.identity, restart["gridIdentity"]))
            mesh_sizes.append((len(saved_structure["velocity"]), len(points), len(faces), tuple(map(int, expected_shape))))
            assert len(run.trace) == 3 and all(call["status"] == "succeeded" for call in run.trace)
            sim.release(sound["artifacts"])
            sim.release(structure["artifacts"])
            sim.release(initial["state"], keep=sound["state"])
            sim.release(structure["state"], keep=sound["state"])
            sim.release(sound["state"])
        finally:
            await run.close()
        assert not buffers.exists() and sim._resources.stats().resource_count == 0
        elapsed.append(time.perf_counter() - started)
    assert identities[0][0] != identities[1][0] and identities[0][1] != identities[1][1]
    record_property("geometry_variant_mesh_sizes", mesh_sizes)
    record_property("geometry_variant_elapsed_seconds", elapsed)
