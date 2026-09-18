"""One nominal Catalog execution for both runtime assertions and example budgets."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import multiprocessing
from pathlib import Path
from time import perf_counter

import numpy as np
import pytest

from app.kernel.coordinator.run import CaeRun
from app.kernel.transport import RecordPacket
from tests.recording_fixtures import decode_tensor_tree


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



async def run_catalog_example(measurement, key, *, run_timeout=180, timings=None):
    started = perf_counter()
    children = {child.pid for child in multiprocessing.active_children()}
    program = measurement["experiment"]["simulationProgram"]
    run = CaeRun(measurement=measurement, max_run_seconds=run_timeout, job_id=f"catalog-{key}")
    run.start()
    recorded, metadata, visualizations, native = {}, {}, {}, {}
    sequences = []
    try:
        while True:
            packet = await asyncio.wait_for(run.queue.get(), timeout=run_timeout + 10)
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
        if key == 'pixel-monochromatic-response':
            power = recorded['detectorPower']
            launched = recorded['launchedPower']
            assert power.shape == (96, 32, 1, 1, 1, 1, 1)
            assert launched.shape == (1, 1, 1, 1, 1, 1, 1)
            assert .55 < power.sum() < .7
            assert launched.item() == 1
            assert metadata['detectorPower']['boxGrid']['sampling'] == 'surface-integral'
            assert metadata['detectorPower']['boxGrid']['frequencyKind'] == 'source-sampled'
        if key in {"steady-microheater", "feedback-microheater"}:
            # simulate.py must retire all numeric/native artifacts before the
            # host closes the run, leaving only its retained empty State root.
            sim = run.simulation_api
            assert dict(sim._states.empty) == {}
            assert sim._resources.stats().resource_count == 1
            assert sim._resources.stats().lease_count == 1
            assert run.simulation_api._buffers.files() == ()
        assert set(run.recorded_names) == set(run.schemas)
        assert sequences == list(range(1, len(sequences) + 1))
        assert sorted(run.completed_sequences + run.visualization_sequences) == sequences
        assert len(run.completed_sequences) == len(run.schemas)
        assert len(run.visualization_sequences) == len(visualizations)
        assert set(visualizations) == {name for name, contracts in program["visualizationContracts"].items() if contracts}
        for task, items in visualizations.items():
            solver = program["tasks"][task]["kernel"]["name"]
            analysis = program["tasks"][task]["config"]["parameters"].get("analysis")
            expected = ({"paths"} if solver == "ray-tracing" else
                        {"motion"} if solver == "rigid_body" else
                        (set() if analysis == "transient" else {"pressure"}) if solver == "pressure-acoustics"
                        else {"harmonicDisplacement", "harmonicStress"} if analysis == "harmonic" else {"displacement", "stress"})
            if solver == "structural-mechanics" and (analysis == "transient" or key == "pulsed-microheater"):
                expected.add("displacementHistory")
            if key.startswith(("hyperelastic-", "mixed-mini-")):
                expected.update(("volumeRatio", "meanPressure"))
            if solver in {"ray-tracing", "rigid_body", "pressure-acoustics", "structural-mechanics"}:
                assert set(items) == expected
            else:
                assert set(items).issubset(program["visualizationContracts"][task])
            for name, item in items.items():
                if item["contract"]["visualization"]["kind"] == "polyline":
                    prefix, contract = f"{task}.{name}.", item["contract"]["visualization"]
                    offsets, vertices = native[prefix + contract["offsets"]], native[prefix + contract["vertices"]]
                    assert offsets[-1] == len(vertices) and np.all(np.diff(offsets) >= 2)
        task_count = len(program["tasks"])
        multiwindow = key in {"feedback-microheater", "pulsed-microheater", "structural-analysis-modes", "transient-matched-impedance-duct", "transient-plate-driven-duct", "asymmetric-rigid-bodies", "sliding-contact"}
        assert len(run.trace) > task_count if multiwindow else len(run.trace) >= task_count
        if "totalCurrent" in recorded:
            assert recorded["totalCurrent"].item() > 0
        if "maximumTemperature" in recorded:
            from app.kernel.api.world import scalar_parameter
            fixed_temperatures = [scalar_parameter(rule["parameters"]["temperature"])
                                  for task in program["tasks"].values()
                                  for rule in task["config"]["boundaryConditions"]
                                  if rule["methodId"] == "heat.fixed-temperature"]
            assert recorded["maximumTemperature"].max() > min(fixed_temperatures)
        if key == "pulsed-microheater":
            temperature = recorded["meanTemperature"].ravel()
            energy = recorded["storedEnergy"].ravel()
            power = recorded["power"].ravel()
            assert temperature.max() > temperature[0]
            assert temperature[-1] < temperature.max()
            assert 0 < energy[-1] < energy.max()
            assert power.max() > 0 and power[-1] == 0
            assert recorded["maximumNormalDisplacement"].max() > 0
            source = recorded["sourcePower"].ravel()[1:]
            loss = recorded["outwardPower"].ravel()[1:]
            storage = recorded["storagePower"].ravel()[1:]
            np.testing.assert_allclose(source, power, rtol=1e-6)
            np.testing.assert_allclose(storage + loss, source, atol=max(abs(source).max(), 1e-30) * 1e-8)
        if key == "incompressible-boolean-channel":
            inlet, outlet = recorded["inletFlowRate"].ravel(), recorded["outletFlowRate"].ravel()
            assert outlet[-1] > 0 and inlet[-1] < 0
            np.testing.assert_allclose(inlet + outlet, 0, atol=outlet.max() * 1e-8)
            np.testing.assert_allclose(recorded["outletMassFlowRate"].ravel(), 1000 * outlet, rtol=1e-12)
            assert recorded["obstacleForce"].reshape(-1, 3)[-1, 0] > 0
            assert np.max(np.abs(native["flow.traction.values"])) > 0
            assert all(np.all(np.isfinite(values)) for values in recorded.values())
        if key.startswith("mixed-mini-"):
            assert recorded["energy"].item() > 0
            assert 0 < recorded["equilibriumEnergy"].item() <= recorded["energy"].item() + 1e-7
            for prefix in ("", "current"):
                stress_name = "stress" if not prefix else "currentStress"
                pressure_name = "meanPressure" if not prefix else "currentMeanPressure"
                stress = recorded[stress_name].reshape(-1, 6)
                np.testing.assert_allclose(recorded[pressure_name].ravel(), -stress[:, :3].sum(axis=1)/3, atol=1e-9)
            assert np.any(recorded["volumeRatio"] > 0)
            assert not np.array_equal(recorded["displacement"], recorded["currentDisplacement"])
            if key == 'mixed-mini-cylinder-inflation':
                # The subtracted cylinder's retained wall has the solid's
                # inward radial normal; positive cavity pressure expands it.
                load_points = native['solid.displacement.domain.metadata.loadPoints']
                load_vectors = native['solid.displacement.domain.metadata.loadVectors']
                assert np.all(np.sum(load_points[:, :2]*load_vectors[:, :2], axis=1) > 0)
        if key.startswith("hyperelastic-"):
            from scipy.optimize import brentq

            stretch = 1 + measurement["experiment"]["variables"]["strain"]
            shear, lame = 10000 / 2.4, 10000 * .2 / (1.2 * .6)
            lateral = brentq(lambda value: shear * (value**2 - 1) + lame * np.log(stretch * value**2), .1, 3)
            jacobian = stretch * lateral**2
            nominal_stress = shear * (stretch - 1 / stretch) + lame * np.log(jacobian) / stretch
            energy = .5 * shear * (stretch**2 + 2 * lateral**2 - 3) - shear * np.log(jacobian) + .5 * lame * np.log(jacobian)**2
            np.testing.assert_allclose(recorded["energy"].item(), .001 * energy, rtol=1e-7)
            np.testing.assert_allclose(recorded["reaction"].reshape(3), [.01 * nominal_stress, 0, 0], rtol=1e-7, atol=1e-8)
            for name, configuration in (("volumeRatio", "reference"), ("currentVolumeRatio", "current")):
                values = recorded[name].ravel()
                assert np.any(values > 0)
                np.testing.assert_allclose(values[values > 0], jacobian, rtol=1e-7)
                assert metadata[name]["boxGrid"]["configuration"] == configuration
                assert metadata[name]["axes"][3]["ticks"] == [0]
            stress = recorded["stress"].reshape(-1, 6)
            np.testing.assert_allclose(stress[:, 0], nominal_stress * stretch / jacobian, rtol=1e-7)
            np.testing.assert_allclose(stress[:, 1:], 0, atol=1e-7)
            assert not np.array_equal(recorded["displacement"], recorded["currentDisplacement"])
        if key == "asymmetric-rigid-bodies":
            masses = native["motion.motion.masses"]
            times = native["motion.motion.times"]
            position = native["motion.motion.positions"]
            speed = native["motion.motion.velocities"]
            assert len(masses) == 3 and len(set(native["motion.motion.bodyIds"])) == 3
            assert times[0] == 0 and times[-1] == .4 and np.all(np.diff(times) > 0)
            np.testing.assert_allclose(position, position[0] + times[:, None, None] * speed[0]
                                       + .5 * times[:, None, None]**2 * [0, 0, -9.81], atol=1e-12)
            geometry = metadata["massDensity"]["boxGrid"]
            volume = np.prod(geometry["size"]) / np.prod(geometry["gridShape"])
            grid_mass = recorded["massDensity"].sum(axis=(0, 1, 2)).ravel() * volume
            np.testing.assert_allclose(grid_mass, masses.sum(), rtol=.01)
            grid_momentum = recorded["momentumDensity"].sum(axis=(0, 1, 2)).reshape(-1, 3) * volume
            expected_momentum = np.einsum("b,tbi->ti", masses, speed)
            momentum_error = np.linalg.norm(grid_momentum - expected_momentum, axis=1)
            assert np.all(momentum_error / np.linalg.norm(expected_momentum, axis=1) <= .01)
            np.testing.assert_allclose(recorded["momentumDensity"],
                                       recorded["massDensity"] * recorded["velocity"], atol=1e-10)
            empty = np.broadcast_to(recorded["massDensity"] == 0, recorded["velocity"].shape)
            assert np.all(recorded["velocity"][empty] == 0)
        if key == "sliding-contact":
            times = native["motion.motion.times"]
            ids = list(native["motion.motion.bodyIds"])
            moving = next(i for i, name in enumerate(ids) if "block" in name)
            fixed = next(i for i, name in enumerate(ids) if "floor" in name)
            velocity = native["motion.motion.velocities"]
            position = native["motion.motion.positions"]
            expected = 2.-measurement["experiment"]["variables"]["friction"]*9.81*times
            np.testing.assert_allclose(velocity[:, moving, 0], expected, atol=1e-7)
            np.testing.assert_allclose(velocity[:, fixed], 0, atol=0)
            np.testing.assert_allclose(position[:, moving, 2], .5, atol=1e-7)
            assert measurement["interactions"]["FloorBlock"]["between"] == ["Floor", "Block"]
            assert len(run.trace) == 2
        if key in {"transient-matched-impedance-duct", "transient-plate-driven-duct"}:
            settings = next(rule["parameters"] for rule in program["tasks"]["acoustics"]["config"]["initializations"]
                            if rule["methodId"] == "acoustics.time")
            step = settings["dt"]["value"]
            total = settings["totalSteps"]
            samples = recorded["pressureProbe"].reshape(-1)
            times = np.asarray(metadata["pressureProbe"]["axes"][3]["ticks"])
            np.testing.assert_allclose(times, np.arange(total + 1) * step, rtol=0, atol=1e-14)
            assert samples[0] == 0 and np.min(samples) < 0 < np.max(samples)
            assert len(np.unique(times)) == len(times)
            assert recorded["pressureProbe"].shape == (1, 1, 1, total + 1, 1, 1, 1)
            field_times = np.asarray(metadata["pressure"]["axes"][3]["ticks"])
            np.testing.assert_allclose(field_times, np.arange(0, total + 1, 20) * step, rtol=0, atol=1e-14)
            assert visualizations.get("acoustics", {}) == {}
            if key == "transient-matched-impedance-duct":
                position = .8 * measurement["experiment"]["variables"]["length"]
                local = times - position / 343
                expected = np.where((local >= 0) & (local <= .008),
                                    1.2 * 343 * .001 * np.sin(2 * np.pi * 250 * local) * np.sin(np.pi * local / .008) ** 2, 0)
                assert np.linalg.norm(samples - expected) / np.linalg.norm(expected) < .02
            else:
                assert np.max(np.abs(recorded["velocity"])) > 0
                assert 0 < np.max(np.abs(recorded["displacement"])) < 1e-5
                for name in ("displacement", "velocity"):
                    np.testing.assert_allclose(metadata[name]["axes"][3]["ticks"], times, rtol=0, atol=1e-14)
                    assert recorded[name].shape[3] == total + 1
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
            if prefix + ".domain.cells.tri3" in native:
                # The fluid's portable traction lives on a surface mesh, with
                # its own compact node numbering and boundary provenance.
                points = native[prefix + ".domain.points"]
                cells = native[prefix + ".domain.cells.tri3"]
                assert cells.ndim == 2 and cells.shape[1] == 3
                assert np.all((cells >= 0) & (cells < len(points)))
                triangles = points[cells]
                assert np.all(np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1) > 0)
                values = native[prefix + ".values"]
                assert values.shape == (len(cells), 1, 3) and np.all(np.isfinite(values))
                offsets = native[prefix + ".domain.metadata.boundaryProvenance.offsets"]
                assert offsets.shape == (len(cells) + 1,) and np.all(np.diff(offsets) > 0)
                continue
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
            identity = native[prefix + ".domain.identity"].item()
            if program["tasks"][prefix.split(".")[0]]["kernel"]["name"] == "incompressible-flow":
                namespace, separator, digest = identity.partition(":")
                assert namespace == "incompressible-flow.model.v3" and separator == ":"
                assert len(digest) == 64 and all(character in "0123456789abcdef" for character in digest)
            else:
                assert len(identity) == 64
            assert native[prefix + ".domain.lengthUnit"].item() == "m"
            values = native[prefix + ".values"]
            count = len(points) if native[prefix + ".location"].item() == "node" else len(cells)
            if values.dtype.kind == "c":
                frequencies = native[prefix.removesuffix("field") + "frequencies"]
                components = 1 if native[prefix + ".quantity"].item() == "acoustics.SoundPressure" else 3 if native[prefix + ".location"].item() == "node" else 6
                assert values.shape == (count, len(frequencies), components)
                assert np.all(frequencies > 0) and np.all(np.diff(frequencies) > 0)
                assert np.max(np.abs(values)) > 0
            else:
                if program["tasks"][prefix.split(".")[0]]["kernel"]["name"] == "incompressible-flow":
                    expected_shape = (count, 1) if prefix.endswith(".pressure") else (count, 1, 3)
                else:
                    expected_shape = ((count,) if native[prefix + ".quantity"].item() == "mechanics.VolumeRatio" or prefix.endswith(".meanPressure")
                                      else (count, 3 if native[prefix + ".location"].item() == "node" else 6))
                assert values.shape == expected_shape
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
        if key in {"matched-impedance-duct", "plate-driven-duct"}:
            frequencies = np.asarray(metadata["pressureProbe"]["axes"][4]["ticks"])
            probe = recorded["pressureProbe"].reshape(len(frequencies), 2)
            complex_pressure = probe[:, 0] * np.exp(1j * probe[:, 1])
            assert np.all(probe[:, 0] > 0)
            assert visualizations["acoustics"]["pressure"]["contract"]["visualization"]["phasor"]["amplitude"] == "peak"
            if key == "matched-impedance-duct":
                position = .8 * measurement["experiment"]["variables"]["length"]
                exact = 1.2 * 343 * np.exp(-2j * np.pi * frequencies * position / 343)
                assert np.max(np.abs(complex_pressure - exact) / np.abs(exact)) < .01
            else:
                source = native["structure.harmonicDisplacement.field.domain.points"]
                target = native["acoustics.pressure.field.domain.points"]
                assert len(source) != len(target)
                assert native["structure.harmonicDisplacement.field.domain.identity"].item() != native["acoustics.pressure.field.domain.identity"].item()
                np.testing.assert_array_equal(native["structure.harmonicDisplacement.frequencies"], frequencies)
                assert np.max(recorded["displacement"][..., 0, :]) > 0
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
        if timings is not None:
            timings["executionAndRecords"] = perf_counter() - started
        cleanup_started = perf_counter()
        simulation = run.simulation_api
        owned_paths = ([] if simulation is None else
                       [simulation._buffers.root, Path(simulation._geometry_cache.name)])
        try:
            await run.close()
            await asyncio.gather(run.task, return_exceptions=True)
            leftovers = [str(path) for path in owned_paths if path.exists()]
            assert not leftovers, f"example cleanup retained buffers/cache: {leftovers}"
            assert not run._record_packets and run.pending is None
            if simulation is not None:
                stats = simulation._resources.stats()
                assert stats.resource_count == 0 and stats.lease_count == 0, stats
            assert {child.pid for child in multiprocessing.active_children()} == children, "example left a Solver child running"
        finally:
            if timings is not None:
                timings["cleanup"] = perf_counter() - cleanup_started

    return {"records": len(recorded), "visualizations": len(visualizations)}
