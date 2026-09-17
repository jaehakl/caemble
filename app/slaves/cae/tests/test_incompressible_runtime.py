"""CLI-built flow through child transactions, recording, ACK and checkpoint cleanup."""

import asyncio
import gc
import json
import multiprocessing
import os
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from app.kernel.api import ContentKey
from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.invocation import execute_solver
from app.kernel.coordinator.plan import detached
from app.kernel.coordinator.run import CaeRun
from app.kernel.execution import MmapPayloadCodec, RemoteSolverError, SolverProcessExitedError, SpawnSolverExecutor
from app.kernel.transport import RecordPacket
from sdk.protocol.packets import receive_packet, send_packet
from tests.test_catalog_examples import decode_tensor_tree


@pytest.mark.asyncio
async def test_periodic_checkpoint_branches_keep_topology_and_observers_passive(catalog_builds):
    measurement = catalog_builds["incompressible-sph-periodic-channel"]
    groups = measurement["experiment"]["scene"]["surfaceGroups"]
    selector = next(group for group in groups if group["name"] == "xMinus")["selectors"][0]
    groups.append({"name": "yWalls", "selectors": [{**selector, "surfaceIndex": index} for index in (2, 3)]})
    config = measurement["experiment"]["simulationProgram"]["tasks"]["flow"]["config"]
    clock = next(rule["parameters"] for rule in config["initializations"] if rule["methodId"] == "flow.time")
    for name, value in (("dt", .005), ("duration", .03), ("windowSize", .01), ("outputInterval", .007)):
        clock[name]["value"] = value
    run = CaeRun(measurement=measurement, max_run_seconds=180, job_id="periodic-checkpoint")
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=64))
    baseline = sim._resources.stats().resource_count
    children = {child.pid for child in multiprocessing.active_children()}
    buffers, cache = sim._buffers.root, Path(sim._geometry_cache.name)
    pending = None
    try:
        first = await sim.run(run.tasks["flow"])
        original = first["state"].to_mutable(copy_arrays=True)
        fingerprint = ContentKey.from_parts("periodic-checkpoint", original)
        saved = original["incompressible_flow"]["flow"]
        assert saved["model"]["periodicTopology"] is not None
        assert len(saved["boundaryInterfaceIndices"]) < len(saved["faceVolumeFlux"])
        np.testing.assert_allclose(np.concatenate(saved["history"]["times"]), [0., .007])
        second = await sim.run(run.tasks["flow"], state=first["state"])
        expected = second["state"].to_mutable(copy_arrays=True)["incompressible_flow"]["flow"]
        spec = run.plan.task_specs["flow"]
        changed = detached(spec.task)
        observer = next(rule for rule in changed["config"]["initializations"] if rule["methodId"] == "flow.observe-surface")
        observer["target"] = ["experiment.surface.yWalls"]
        observer["parameters"]["name"] = "walls"
        changed_clock = next(rule["parameters"] for rule in changed["config"]["initializations"] if rule["methodId"] == "flow.time")
        changed_clock["outputInterval"]["value"] = .004
        flow_output = next(output for output in changed["config"]["outputs"] if output["key"] == "flowRate")
        flow_output["parameters"]["surface"] = "walls"
        flow_output["parameters"]["scope"] = "final"
        run.plan = replace(run.plan, task_specs={**run.plan.task_specs, "flow": replace(spec, task=changed)})
        branch = await sim.run(run.plan.tasks["flow"], state=first["state"])
        actual = branch["state"].to_mutable(copy_arrays=True)["incompressible_flow"]["flow"]
        assert actual["model"]["identity"] == expected["model"]["identity"]
        for name in ("pressure", "velocity", "faceVolumeFlux", "boundaryInterfaceIndices"):
            np.testing.assert_array_equal(actual[name], expected[name], err_msg=name)
        assert ContentKey.from_parts("topology", actual["model"]["periodicTopology"]) == ContentKey.from_parts(
            "topology", saved["model"]["periodicTopology"])
        np.testing.assert_allclose(np.concatenate(actual["history"]["times"]), [0., .007, .012, .016, .02])
        np.testing.assert_array_equal(np.concatenate(actual["history"]["boundaryFlux"])[:2],
                                      np.concatenate(saved["history"]["boundaryFlux"]))
        observed = sim._artifacts.materialize(branch["artifacts"]["flowRate"])
        np.testing.assert_array_equal(observed["value"], 0.)
        np.testing.assert_array_equal(observed["axes"][3]["ticks"], [.02])
        assert observed["metadata"]["surfaceTargets"] == ["experiment.surface.yWalls"]
        del observed
        assert ContentKey.from_parts("periodic-checkpoint", first["state"].to_mutable(copy_arrays=True)) == fingerprint
        bad = detached(spec.task)
        bad["config"]["boundaryConditions"][0]["parameters"]["translation"]["value"][0] *= 1.01
        before = sim._resources.stats(), sim._states.revisions(), sim._buffers.files()
        with pytest.raises(RemoteSolverError, match="different geometry, material, boundary or integration model"):
            await execute_solver(replace(spec, task=bad), first["state"].to_mutable(copy_arrays=False), {},
                                 run.plan.world(spec), run.progress, executor=sim._executor, timeout=120)
        assert (sim._resources.stats(), sim._states.revisions(), sim._buffers.files()) == before
        for result in (first, second, branch):
            sim.release((result["state"], result["artifacts"]))
        pending = asyncio.create_task(sim._flush_visualizations())
        packet = await asyncio.wait_for(run.queue.get(), timeout=30)
        assert isinstance(packet, RecordPacket)
        run.pending = packet
        run.acknowledge(packet.sequence)
        await pending
        gc.collect()
        assert sim._resources.stats().resource_count == baseline
        assert sim._buffers.files() == ()
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await run.close()
    assert not buffers.exists() and not cache.exists()
    assert {child.pid for child in multiprocessing.active_children()} == children


@pytest.mark.asyncio
@pytest.mark.parametrize("attachments,closed,transient", [
    (False, False, False), (True, False, False), (False, True, False), (True, False, True),
], ids=["inline", "attachments", "hydrostatic", "startup"])
async def test_flow_records_survive_wire_storage_requery_and_ack(catalog_builds, tmp_path, monkeypatch, attachments, closed, transient):
    if attachments:
        monkeypatch.setattr("app.kernel.transport.tensor.INLINE_LIMIT_BYTES", 64)
    measurement = catalog_builds["incompressible-startup-channel" if transient else "incompressible-stokes-duct"]
    endpoint = .05 if transient else 0.
    expected_times = np.arange(26) * .002 if transient else np.array([0.])
    if closed:
        config = measurement["experiment"]["simulationProgram"]["tasks"]["flow"]["config"]
        config["boundaryConditions"] = []
        config["parameters"]["gravity"] = {"value": [0., 0., -9.81], "unit": "m.s-2"}
    async def retain_progress(value):
        if isinstance(value, dict):
            with (tmp_path / "progress.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(value, ensure_ascii=False) + "\n")

    run = CaeRun(measurement=measurement, max_run_seconds=480, job_id="flow-recording",
                 on_progress=retain_progress if transient else None)
    run.start()
    records, displays, geometries, sequences = {}, {}, {}, []
    try:
        while True:
            packet = await asyncio.wait_for(run.queue.get(), timeout=490)
            if not isinstance(packet, RecordPacket):
                if packet["kind"] in {"complete", "failed"}:
                    assert packet["kind"] == "complete", (packet, f"Progress: {tmp_path / 'progress.jsonl'}")
                    break
                continue
            frames = asyncio.Queue()
            await send_packet(frames.put, frames.put, {"kind": packet.kind, "name": packet.name, "data": packet.value}, packet.attachments)
            payload, received = await receive_packet(frames.get)
            stored = tmp_path / f"{packet.sequence}.json"
            stored.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            for attachment in received:
                (tmp_path / attachment.id).write_bytes(bytes(attachment.data))
            queried = json.loads(stored.read_text(encoding="utf-8"))
            blobs = {attachment.id: (tmp_path / attachment.id).read_bytes() for attachment in received}
            if packet.kind == "record":
                tensor = queried["data"]
                records[packet.name] = decode_tensor_tree(run.schemas[packet.name], tensor, blobs)[""]
                geometries[packet.name] = tensor["boxGrid"]
                assert tensor["storage"]["kind"] == ("attachments" if attachments else "inline")
                assert tensor["provenance"]["solver"] == {"name": "incompressible-flow", "version": "3.0.0"}
                assert tensor["metadata"]["pressureKind"] == "gauge"
                assert tensor["metadata"]["pressureReference"] == ("volume-mean-zero" if closed else "pressure-boundaries")
                assert set(tensor["metadata"]) == set(run.schemas[packet.name]["metadata"])
                assert tensor["metadata"]["coordinateFrame"] == "world"
                assert records[packet.name].shape[3:6] == (len(expected_times), 1, 1)
                np.testing.assert_allclose(tensor["axes"][3]["ticks"], expected_times, rtol=0, atol=1e-14)
            else:
                for name, entry in queried["data"].items():
                    displays[name] = decode_tensor_tree(entry["schema"], entry["data"], blobs)
                    assert entry["contract"]["visualization"]["kind"] == "mesh-field"
                    assert entry["data"]["values"]["axes"][1] == {"name": "time", "unit": "s", "ticks": [endpoint]}
                    assert displays[name]["values"].shape[1:] == ((1,) if name == "pressure" else (1, 3))
                    assert displays[name]["metadata.pressureKind"] == "gauge"
                    assert displays[name]["metadata.pressureReference"] == ("volume-mean-zero" if closed else "pressure-boundaries")
                    if name == "traction":
                        assert displays[name]["domain.cells.tri3"].shape[1] == 3
                        assert displays[name]["metadata.actionTarget"] == "fluid-on-solid"
                        assert displays[name]["metadata.pressureOffset"] == 0
                        assert displays[name]["metadata.contribution"] == "total"
            sequences.append(packet.sequence)
            assert packet.resource_hold is not None and not packet.ack.done()
            run.pending = packet
            run.acknowledge(packet.sequence)
            assert packet.ack.done()
        assert set(records) == {"pressure", "velocity", "density"}
        assert set(displays) == {"pressure", "velocity", "traction"}
        observations = run.trace[-1]["observations"]
        assert observations["pressureReference"] == ("volume-mean-zero" if closed else "pressure-boundaries")
        assert max(observations[name] for name in ("massResidual", "momentumResidual", "pressureResidual")) <= 1e-8
        assert all(value.ndim == 7 for value in records.values())
        assert run.schemas["pressure"]["unit"] == "Pa"
        for key in ("origin", "size", "rotation", "gridShape", "lengthUnit", "source", "rootId"):
            assert geometries["pressure"][key] == geometries["density"][key] == geometries["velocity"][key]
        assert geometries["pressure"]["weighting"] == geometries["velocity"]["weighting"] == "material-volume"
        assert "weighting" not in geometries["density"]
        assert np.all(records["density"] > 0)
        np.testing.assert_allclose(records["density"], 1000., rtol=1e-9)
        if closed:
            assert np.min(records["pressure"]) < 0 < np.max(records["pressure"])
            assert records["pressure"][:, :, 0].mean() > records["pressure"][:, :, -1].mean()
            np.testing.assert_array_equal(records["velocity"], 0.)
        else:
            assert records["pressure"][0].mean() > records["pressure"][-1].mean()
            assert records["velocity"][..., 0].mean() > 0
        if transient:
            progress_events = [json.loads(line) for line in (tmp_path / "progress.jsonl").read_text(encoding="utf-8").splitlines()]
            physical = [event["physicalTime"] for event in progress_events if "physicalTime" in event]
            assert physical
            assert all(value["total"] == endpoint and 0 <= value["completed"] <= endpoint and value["dt"] > 0
                       for value in physical)
            assert np.all(np.diff([value["completed"] for value in physical]) >= 0)
            assert all("physicalTime" in event for event in progress_events
                       if event.get("stage") in {"flow-pressure-iteration", "flow-nonlinear-iteration", "flow-time", "flow-retry"})
            np.testing.assert_array_equal(records["velocity"][:, :, :, 0], 0.)
            assert records["velocity"][:, :, :, -1, 0, 0, 0].mean() > records["velocity"][:, :, :, 1, 0, 0, 0].mean()
            # Integrate the double odd sine series over the complete rectangular
            # cross section. This reference includes the physical startup time;
            # the 15% allowance covers this example's spatial mesh and Euler dt.
            length, width, height = geometries["velocity"]["size"]
            odd = np.arange(1, 256, 2, dtype=float)
            decay = (1. / 1000.) * np.pi**2 * ((odd[:, None] / width)**2 + (odd[None, :] / height)**2)
            reference = (64 * (.1 / (1000. * length)) / np.pi**4
                         * np.sum(-np.expm1(-decay * endpoint) / (odd[:, None]**2 * odd[None, :]**2 * decay)))
            observed = float(records["velocity"][:, :, :, -1, 0, 0, 0].mean())
            assert observed == pytest.approx(reference, rel=.15)
            native = displays["velocity"]
            vertices = native["domain.points"][native["domain.cells.tet4"]]
            volumes = np.abs(np.linalg.det(vertices[:, 1:] - vertices[:, :1])) / 6
            native_mean = float(np.average(native["values"][:, 0, 0], weights=volumes))
            assert native_mean == pytest.approx(observed, rel=1e-12)
            assert len(run.trace) == 5
        assert sequences == list(range(1, len(sequences) + 1))
    finally:
        await run.close()


@pytest.mark.asyncio
async def test_stokes_child_empty_patch_failure_cancel_and_release(catalog_builds, tmp_path, monkeypatch):
    child_temp = tmp_path / "child-temp"
    child_temp.mkdir()
    for name in ("TMPDIR", "TEMP", "TMP"):
        monkeypatch.setenv(name, str(child_temp))
    run = CaeRun(measurement=catalog_builds["incompressible-stokes-duct"], max_run_seconds=180, job_id="stokes-lifecycle")
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=64))
    spec = run.plan.task_specs["flow"]
    children = {child.pid for child in multiprocessing.active_children()}
    buffers, cache = sim._buffers.root, Path(sim._geometry_cache.name)
    baseline = sim._resources.stats().resource_count
    pending = None
    try:
        first = await sim.run(run.tasks["flow"])
        state = first["state"]
        fingerprint = ContentKey.from_parts("steady-state", state.to_mutable(copy_arrays=True))
        second = await sim.run(run.tasks["flow"], state=state)
        assert second["state"] is state
        assert ContentKey.from_parts("steady-state", state.to_mutable(copy_arrays=True)) == fingerprint
        for name in first["artifacts"]:
            a = sim._artifacts.materialize(first["artifacts"][name])["value"]
            b = sim._artifacts.materialize(second["artifacts"][name])["value"]
            np.testing.assert_array_equal(a, b)
        del a, b
        before = sim._resources.stats(), sim._states.revisions(), sim._buffers.files()
        failed = detached(spec.task)
        failed["config"]["parameters"]["maxIterations"] = {"value": 1}
        with pytest.raises(RemoteSolverError, match="converg|iteration"):
            await execute_solver(replace(spec, task=failed), state.to_mutable(copy_arrays=False), {}, run.plan.world(spec),
                                 run.progress, executor=sim._executor, timeout=120)
        assert (sim._resources.stats(), sim._states.revisions(), sim._buffers.files()) == before
        reached_iteration = asyncio.Event()

        async def progress(value):
            if value.get("stage") == "stokes-iteration":
                reached_iteration.set()

        pending = asyncio.create_task(execute_solver(spec, state.to_mutable(copy_arrays=False), {}, run.plan.world(spec),
                                     progress, executor=sim._executor, timeout=120))
        await asyncio.wait_for(reached_iteration.wait(), timeout=120)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        await sim._executor.wait_for_cleanup()
        gc.collect()
        assert (sim._resources.stats(), sim._states.revisions(), sim._buffers.files()) == before
        assert {child.pid for child in multiprocessing.active_children()} == children
        sim.release((first["artifacts"], second["artifacts"], state))
        pending = asyncio.create_task(sim._flush_visualizations())
        packet = await asyncio.wait_for(run.queue.get(), timeout=20)
        assert isinstance(packet, RecordPacket) and packet.kind == "visualization"
        run.pending = packet
        run.acknowledge(packet.sequence)
        await pending
        gc.collect()
        assert sim._resources.stats().resource_count == baseline
        assert sim._buffers.files() == ()
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await run.close()
    assert not buffers.exists() and not cache.exists() and not list(child_temp.iterdir())
    assert {child.pid for child in multiprocessing.active_children()} == children


@pytest.mark.asyncio
async def test_flow_checkpoint_branches_reject_changes_cancel_and_release(catalog_builds, tmp_path, monkeypatch):
    child_temp = tmp_path / "transient-child-temp"
    child_temp.mkdir()
    for name in ("TMPDIR", "TEMP", "TMP"):
        monkeypatch.setenv(name, str(child_temp))
    measurement = catalog_builds["incompressible-startup-channel"]
    config = measurement["experiment"]["simulationProgram"]["tasks"]["flow"]["config"]
    clock = next(rule["parameters"] for rule in config["initializations"] if rule["methodId"] == "flow.time")
    clock["outputInterval"]["value"] = .03
    next(output for output in config["outputs"] if output["key"] == "velocity")["parameters"]["scope"] = {"value": "final"}
    run = CaeRun(measurement=measurement, max_run_seconds=180, job_id="flow-checkpoint")
    continuous_measurement = catalog_builds["incompressible-startup-channel"]
    continuous_config = continuous_measurement["experiment"]["simulationProgram"]["tasks"]["flow"]["config"]
    continuous_clock = next(rule["parameters"] for rule in continuous_config["initializations"]
                            if rule["methodId"] == "flow.time")
    continuous_clock["windowSize"]["value"] = .02
    for output in continuous_config["outputs"]:
        output["parameters"]["gridShape"] = [8, 2, 2]
        output["boxGrid"]["gridShape"] = [8, 2, 2]
    continuous_run = CaeRun(measurement=continuous_measurement, max_run_seconds=180, job_id="flow-continuous")
    continuous = SimulationApi(continuous_run)
    continuous_run.simulation_api = continuous
    sim = SimulationApi(run)
    run.simulation_api = sim
    sim._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(sim._buffers, array_threshold=64))
    spec = run.plan.task_specs["flow"]
    children = {child.pid for child in multiprocessing.active_children()}
    buffers, cache = sim._buffers.root, Path(sim._geometry_cache.name)
    baseline = sim._resources.stats().resource_count
    pending = None
    try:
        first = await sim.run(run.tasks["flow"])
        checkpoint = first["state"]
        original = checkpoint.to_mutable(copy_arrays=True)
        fingerprint = ContentKey.from_parts("flow-checkpoint", original)
        saved = original["incompressible_flow"]["flow"]
        assert saved["time"] == .01 and saved["windows"] == 1 and saved["steps"] >= 10
        assert saved["pressure"].shape == saved["velocity"].shape[:1]
        assert saved["faceVolumeFlux"].ndim == 1
        assert saved["model"]["cells"].shape == (len(saved["pressure"]), 4)
        assert len(saved["history"]["times"]) == 1
        for name, handle in first["artifacts"].items():
            output = sim._artifacts.materialize(handle)
            np.testing.assert_array_equal(output["axes"][3]["ticks"], [.01] if name == "velocity" else [0., .01])
        del output

        before = sim._resources.stats(), sim._states.revisions(), sim._buffers.files()
        for change in ("clock", "model", "analysis"):
            altered = detached(spec.task)
            if change == "clock":
                clock = next(rule["parameters"] for rule in altered["config"]["initializations"]
                             if rule["methodId"] == "flow.time")
                clock["dt"]["value"] *= 2
            elif change == "model":
                altered["config"]["parameters"]["gravity"] = {"value": [0., 0., -1.], "unit": "m.s-2"}
            else:
                altered["config"]["parameters"]["analysis"] = "steady-stokes"
                altered["config"]["initializations"] = [rule for rule in altered["config"]["initializations"]
                                                        if rule["methodId"] != "flow.time"]
            with pytest.raises(RemoteSolverError, match="checkpoint|physical time|integration model"):
                await execute_solver(replace(spec, task=altered), checkpoint.to_mutable(copy_arrays=False),
                                     {}, run.plan.world(spec), run.progress, executor=sim._executor, timeout=120)
            assert (sim._resources.stats(), sim._states.revisions(), sim._buffers.files()) == before

        reached_step = asyncio.Event()
        previous_progress = run.progress

        async def progress(value):
            if value.get("stage") == "flow-time":
                reached_step.set()
            await previous_progress(value)

        monkeypatch.setattr(run, "progress", progress)
        pending = asyncio.create_task(sim.run(run.tasks["flow"], state=checkpoint))
        await asyncio.wait_for(reached_step.wait(), timeout=120)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        await sim._executor.wait_for_cleanup()
        gc.collect()
        assert (sim._resources.stats(), sim._states.revisions(), sim._buffers.files()) == before
        assert {child.pid for child in multiprocessing.active_children()} == children
        for handle in sim._visualizations["flow"].values():
            assert sim._artifacts.materialize(handle).metadata["sampleAxes"][0]["ticks"] == [.01]
        assert ContentKey.from_parts("flow-checkpoint", checkpoint.to_mutable(copy_arrays=True)) == fingerprint

        reached_step.clear()
        previous_visualizations = dict(sim._visualizations["flow"])
        pending = asyncio.create_task(sim.run(run.tasks["flow"], state=checkpoint))
        await asyncio.wait_for(reached_step.wait(), timeout=120)
        owned_children = [child for child in multiprocessing.active_children() if child.pid not in children]
        assert len(owned_children) == 1
        child = owned_children[0]
        assert child._parent_pid == os.getpid() and child.name == f"caemble-solver:{spec.locator}"
        assert child.is_alive()
        child_pid = child.pid
        child.terminate()
        with pytest.raises(SolverProcessExitedError) as failed:
            await pending
        assert failed.value.child_pid == child_pid and failed.value.exit_code != 0
        # ExceptionInfo retains invocation frames and their borrowed mmap arrays.
        # Finish examining the crash before checking that released buffers vanish.
        del failed
        pending = None
        await sim._executor.wait_for_cleanup()
        gc.collect()
        assert (sim._resources.stats(), sim._states.revisions(), sim._buffers.files()) == before
        assert {child.pid for child in multiprocessing.active_children()} == children
        assert sim._visualizations["flow"] == previous_visualizations
        assert ContentKey.from_parts("flow-checkpoint", checkpoint.to_mutable(copy_arrays=True)) == fingerprint
        assert run.trace[-1]["status"] == "failed" and run.trace[-1]["error"] == "SolverProcessExitedError"
        assert not list(child_temp.iterdir())

        second = await sim.run(run.tasks["flow"], state=checkpoint)
        branch = await sim.run(run.tasks["flow"], state=checkpoint)
        actual, repeated = (result["state"].to_mutable(copy_arrays=True) for result in (second, branch))
        assert ContentKey.from_parts("branch", actual) == ContentKey.from_parts("branch", repeated)
        assert actual["incompressible_flow"]["flow"]["time"] == .02
        assert ContentKey.from_parts("flow-checkpoint", checkpoint.to_mutable(copy_arrays=True)) == fingerprint
        whole = await continuous.run(continuous_run.tasks["flow"])
        whole_saved = whole["state"].to_mutable(copy_arrays=True)["incompressible_flow"]["flow"]
        split_saved = actual["incompressible_flow"]["flow"]
        assert whole_saved["time"] == split_saved["time"] == .02
        assert whole_saved["steps"] == split_saved["steps"]
        assert whole_saved["nextDt"] == split_saved["nextDt"]
        assert whole_saved["nextDtTick"] == split_saved["nextDtTick"]
        assert whole_saved["model"]["identity"] == split_saved["model"]["identity"]
        for name in ("points", "cells"):
            np.testing.assert_array_equal(split_saved["model"][name], whole_saved["model"][name])
        for name in ("pressure", "velocity", "faceVolumeFlux"):
            np.testing.assert_array_equal(split_saved[name], whole_saved[name], err_msg=name)
        np.testing.assert_array_equal(np.concatenate(split_saved["history"]["times"]), [0.])
        np.testing.assert_allclose(np.concatenate(whole_saved["history"]["times"]), np.arange(11) * .002,
                                   rtol=0, atol=1e-14)
        for name, handle in continuous._visualizations["flow"].items():
            expected = (split_saved[name] if name in {"pressure", "velocity"}
                        else sim._artifacts.materialize(sim._visualizations["flow"][name]).values[:, 0])
            np.testing.assert_array_equal(continuous._artifacts.materialize(handle).values[:, 0], expected)
            assert continuous._artifacts.materialize(handle).metadata["sampleAxes"][0]["ticks"] == [.02]
        del expected
        continuous.release((whole["artifacts"], whole["state"]))
        for name in second["artifacts"]:
            a = sim._artifacts.materialize(second["artifacts"][name])
            b = sim._artifacts.materialize(branch["artifacts"][name])
            np.testing.assert_array_equal(a["value"], b["value"])
            np.testing.assert_array_equal(a["axes"][3]["ticks"], b["axes"][3]["ticks"])
            np.testing.assert_array_equal(a["axes"][3]["ticks"], [.02] if name == "velocity" else [0., .02])
        del a, b
        for result in (first, second, branch):
            sim.release((result["artifacts"], result["state"]))
        pending = asyncio.create_task(sim._flush_visualizations())
        while True:
            packet = await asyncio.wait_for(run.queue.get(), timeout=20)
            if isinstance(packet, RecordPacket):
                break
        assert packet.kind == "visualization" and packet.resource_hold is not None and not packet.ack.done()
        for entry in packet.value.values():
            assert entry["data"]["values"]["axes"][1]["ticks"] == [.02]
        run.pending = packet
        run.acknowledge(packet.sequence)
        await pending
        gc.collect()
        assert sim._resources.stats().resource_count == baseline
        assert sim._buffers.files() == ()
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await run.close()
        await continuous_run.close()
    assert not buffers.exists() and not cache.exists() and not list(child_temp.iterdir())
    assert {child.pid for child in multiprocessing.active_children()} == children
