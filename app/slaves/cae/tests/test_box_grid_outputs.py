import asyncio

import numpy as np
import pytest

from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.coordinator.run import CaeRun
from app.kernel.transport.records import RecordResourceHold
from app.kernel.transport.tensor import encode_tensor
from app.methods.fields.box_grid import BoxGrid, RectilinearSampler, TetrahedralSampler, pack_box_grid
from app.solvers.ray_tracing.outputs import PathCollector, VolumeTally


def grid(shape=(2, 2, 2), origin=(0, 0, 0), size=(1, 1, 1), rotation=None):
    return BoxGrid({"origin": list(origin), "size": list(size),
                    "rotation": np.eye(3).tolist() if rotation is None else rotation,
                    "lengthUnit": "m", "gridShape": list(shape), "source": "task", "rootId": "probe"})


def data(components=("scalar",), polar=False, sampling="point"):
    channels = ["amplitude", "phase"] if polar else ["value"]
    return {"dtype": "float64", "tensorOrder": 0, "axes": [{}] * 7,
            "boxGrid": {"version": 1, "sampling": sampling, "components": list(components),
                        "channels": channels, "channelUnits": ["1", "rad"] if polar else ["1"]}}


def test_rotated_probe_preserves_linear_field_and_outside_zero():
    probe = grid(origin=(1, 0, 0), rotation=[[0, -1, 0], [1, 0, 0], [0, 0, 1]])
    points = probe.points()
    axes = (np.array([0.25, 0.75]),) * 3
    coordinates = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1)
    values = coordinates @ np.array([1., 2., 3.])
    sampler = RectilinearSampler.prepare(axes, points, ((0, 1),) * 3)
    np.testing.assert_allclose(sampler.sample(values), points @ np.array([1., 2., 3.]))
    outside = RectilinearSampler.prepare(axes, grid(origin=(2, 0, 0)).points(), ((0, 1),) * 3)
    assert not outside.sample(values).any()


def test_tetra_probe_with_no_contained_nodes_interpolates_enclosing_element():
    nodes = np.array([[0., 0., 0.], [2., 0., 0.], [0., 2., 0.], [0., 0., 2.]])
    probe = grid(origin=(0.1, 0.1, 0.1), size=(0.1, 0.1, 0.1))
    assert not probe.contains(nodes).any()
    sampler = TetrahedralSampler.prepare(nodes, [[0, 1, 2, 3]], probe.points())
    np.testing.assert_allclose(sampler.sample(nodes @ np.array([2., 3., 4.])), probe.points() @ np.array([2., 3., 4.]))
    far = TetrahedralSampler.prepare(nodes, [[0, 1, 2, 3]], grid(origin=(5, 5, 5)).points())
    assert not far.sample(nodes).any()


def test_polar_packing_fixed_axes_phase_wrap_and_zero():
    probe = grid(shape=(3, 1, 1))
    result = pack_box_grid(probe, data(polar=True), np.array([-1 + 0j, 1j, 0j]))
    assert result["value"].shape == (3, 1, 1, 1, 1, 2, 1)
    np.testing.assert_allclose(result["value"][:, 0, 0, 0, 0, :, 0], [[1, -np.pi], [1, np.pi / 2], [0, 0]])
    validate_artifact_payload(result, data(polar=True), "result")
    result["axes"][4]["ticks"] = [1, 2]
    with pytest.raises(ValueError, match="coordinate length"):
        validate_artifact_payload(result, data(polar=True), "result")


@pytest.mark.parametrize("shape", [(2, 1, 1), (20000, 1, 1)])
def test_tensor_transport_preserves_box_geometry_for_inline_and_binary(shape):
    profile = data()
    result = pack_box_grid(grid(shape=shape), profile, -np.ones(shape))
    encoded, attachments, _ = encode_tensor("field", profile, result, 1)
    assert encoded["boxGrid"] == result["boxGrid"]
    assert encoded["shape"] == [*shape, 1, 1, 1, 1]
    assert bool(attachments) == (shape[0] == 20000)


def test_ray_track_length_opposite_directions_and_attenuation():
    probe = grid(shape=(1, 1, 1))
    scalar = VolumeTally("scalar", probe, data(sampling="cell-average"), np.array([299792458.0]))
    vector = VolumeTally("vector", probe, data(("x", "y", "z"), sampling="cell-average"), np.array([299792458.0]))
    collector = PathCollector(0, tallies=[scalar, vector])
    collector.score([0, .5, .5], [1, 0, 0], 1, 2., 0., 1.)
    collector.score([1, .5, .5], [-1, 0, 0], 1, 2., 0., 1.)
    assert scalar.values.item() == 4.
    np.testing.assert_allclose(vector.values, 0)
    assert collector.paths == []
    attenuated = VolumeTally("attenuated", probe, data(sampling="cell-average"), np.array([299792458.0]))
    attenuated.score([0, .5, .5], [1, 0, 0], 1, 2., 3., 1.)
    assert attenuated.values.item() == pytest.approx(2 * (1 - np.exp(-3)) / 3)


@pytest.mark.asyncio
async def test_visualization_uses_separate_sequences_and_releases_after_ack():
    run = object.__new__(CaeRun)
    run.sequence, run.pending = 0, None
    run.visualization_sequences, run.completed_sequences = [], []
    run._record_packets, run.queue = {}, asyncio.Queue()
    async def flush():
        return None
    run._flush_progress = flush
    released = []
    hold = RecordResourceHold(lambda: released.append(True))
    task = asyncio.create_task(run.visualization("task", {}, resource_hold=hold))
    packet = await run.queue.get()
    assert packet.kind == "visualization" and packet.name == "task"
    assert hold.handed_off and not released
    run.pending = packet
    run.acknowledge(packet.sequence)
    await task
    assert released == [True]
    assert run.visualization_sequences == [1] and run.completed_sequences == []


@pytest.mark.parametrize("dtype", ["float32", "float64"])
def test_polar_storage_keeps_pi_boundaries_and_underflow_canonical(dtype):
    profile = {**data(polar=True), "dtype": dtype}
    raw = np.array([-1.+0j, -1.+1e-20j, -1.-1e-20j, 1e-50j])
    result = pack_box_grid(grid(shape=(4,1,1)), profile, raw)
    values = result["value"]
    phase = values[...,1,:].astype(np.float64)
    assert np.all(phase >= -np.pi) and np.all(phase < np.pi)
    assert np.all(phase[values[...,0,:] == 0] == 0)
    validate_artifact_payload(result, profile, "polar")
    invalid = {**result, "value": values.copy()}
    invalid["value"][0,0,0,0,0,0,0] = -1
    with pytest.raises(ValueError, match="nonnegative amplitude"):
        validate_artifact_payload(invalid, profile, "polar")


@pytest.mark.asyncio
async def test_recording_old_artifact_after_second_call_retains_original_provenance(monkeypatch):
    from dataclasses import replace
    from tests.test_simulation_coordinator import FakeRun
    from app.kernel.api import SolverResult, StatePatch
    from app.kernel.catalog import solver_catalog
    from app.kernel.coordinator import SimulationApi
    from app.kernel.execution import SolverExecutionTransaction

    run = FakeRun()
    profile = data()
    run.configure_task("producer", outputs={"field": {"data": profile, "category": "outputs"}})
    run.plan = replace(run.plan, schemas={"field": profile})
    async def invoke(*args, **kwargs):
        return SolverExecutionTransaction(SolverResult(StatePatch(), {"field": pack_box_grid(grid(), profile, np.ones((2,2,2)))}))
    monkeypatch.setattr("app.kernel.coordinator.simulation.execute_solver", invoke)
    sim = SimulationApi(run)
    try:
        first = await sim.run(run.producer)
        second = await sim.run(run.producer, state=first["state"])
        assert first["state"] is second["state"]
        for produced, ordinal in ((second, 2), (first, 1)):
            await sim.record("field", produced["artifacts"]["field"])
            provenance = run.recorded[1]["provenance"]
            assert provenance == {"task": "producer", "solver": {"name": "producer", "version": "1.0.0"},
                                  "stateRevision": 0, "invocation": ordinal,
                                  "catalogRevision": solver_catalog.catalog_revision}
            encoded, _, _ = encode_tensor("field", profile, run.recorded[1], ordinal)
            assert encoded["provenance"] == provenance
    finally:
        sim.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("empty_latest", [False, True])
async def test_visualization_final_flush_releases_superseded_and_preserves_latest_success(monkeypatch, empty_latest):
    from dataclasses import replace
    from tests.test_simulation_coordinator import FakeRun
    from app.kernel.api import SolverResult, StatePatch
    from app.kernel.coordinator import SimulationApi
    from app.kernel.execution import SolverExecutionTransaction

    run = FakeRun()
    spec = run.plan.task_specs["producer"]
    visual = {"artifactType": "test/preview@1", "data": {"dtype": "float64"}}
    specs = dict(run.plan.task_specs)
    specs["producer"] = replace(spec, descriptor={"inputPorts": {}, "visualizations": {"preview": visual}})
    run.plan = replace(run.plan, task_specs=specs, visualization_contracts={"producer": {
        "preview": {"artifactType": "test/preview@1", "schema": {"dtype": "float64"}, "visualization": {"kind": "none"}}}})
    emitted = []
    async def visual_host(task, entries, *, resource_hold):
        emitted.append((task, entries))
        resource_hold.hand_off()
        resource_hold.release()
    run.visualization = visual_host
    calls = 0
    async def invoke(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 3:
            raise ValueError("failed invocation")
        return SolverExecutionTransaction(SolverResult(StatePatch(), {"field": np.ones(2)},
            visualizations={} if calls == 2 and empty_latest else {"preview": np.asarray(float(calls))}))
    monkeypatch.setattr("app.kernel.coordinator.simulation.execute_solver", invoke)
    sim = SimulationApi(run)
    try:
        await sim.run(run.producer)
        previous = sim._visualizations["producer"]["preview"]
        await sim.run(run.producer)
        assert not sim._artifacts.is_live(previous)
        assert emitted == []
        with pytest.raises(ValueError, match="failed invocation"):
            await sim.run(run.producer)
        await sim._flush_visualizations()
        assert len(emitted) == 1 and emitted[0][0] == "producer"
        if empty_latest:
            assert emitted[0][1] == {}
        else:
            assert emitted[0][1]["preview"]["data"] == 2.
            assert emitted[0][1]["preview"]["provenance"]["invocation"] == 2
        assert sim._visualizations == {}
        assert not any(handle.provenance.output_name == "preview" for handle in sim._artifacts.handles())
    finally:
        sim.close()


@pytest.mark.asyncio
async def test_closing_unfinished_simulation_releases_unpublished_visualizations(monkeypatch):
    from dataclasses import replace
    from tests.test_simulation_coordinator import FakeRun
    from app.kernel.api import SolverResult, StatePatch
    from app.kernel.coordinator import SimulationApi
    from app.kernel.execution import SolverExecutionTransaction
    run = FakeRun()
    specs = dict(run.plan.task_specs)
    specs["producer"] = replace(specs["producer"], descriptor={"inputPorts": {}, "visualizations": {
        "preview": {"artifactType": "test/preview@1", "data": {"dtype": "float64"}}}})
    run.plan = replace(run.plan, task_specs=specs)
    async def invoke(*args, **kwargs):
        return SolverExecutionTransaction(SolverResult(StatePatch(), {"field": np.ones(2)}, visualizations={"preview": np.asarray(1.)}))
    monkeypatch.setattr("app.kernel.coordinator.simulation.execute_solver", invoke)
    sim = SimulationApi(run)
    await sim.run(run.producer)
    assert sim._visualizations
    sim.close()
    assert sim._resources.stats().resource_count == 0
