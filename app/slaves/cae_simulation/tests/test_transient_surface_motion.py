"""Physical surface waveforms distinguish initial, solved and coupling trial data."""

from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api import SolverInvocation
from app.kernel.catalog import solver_catalog
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.resources import ResourceStore
from app.solvers.structural_mechanics.analyses.window import advance_window
from app.solvers.structural_mechanics.entry import run
from app.solvers.structural_mechanics.interfaces.transient_surface import TransientSurfaceSamples
from app.solvers.structural_mechanics.operators.linear import prepare_matrices
from tests.box_grid_fixtures import grid
from tests.structural_fixture import clock_invocation
from tests.structural_fixture import tetrahedron_motion


@pytest.fixture
def surface_case(monkeypatch):
    model, _ = tetrahedron_motion()
    model.fixed = (6 * np.arange(3)[:, None] + np.arange(3)).ravel()
    model.cell_regions = {"experiment.solid": np.array([0])}
    model.boundary_regions["experiment.surface.radiating"] = {
        "faces": np.array([[0, 1, 3]]), "nodes": np.array([0, 1, 3]), "rootIds": ["solid"],
    }

    async def prepared_model(_invocation):
        return model

    monkeypatch.setattr("app.solvers.structural_mechanics.entry.build_geometry_model", prepared_model)
    settings = {
        "dt": .001, "windowSize": .002, "duration": .004, "outputInterval": .001,
        "dampingMass": 1., "dampingStiffness": 0., "couplingTolerance": 1e-8,
        "maxCouplingIterations": 12, "relaxation": .5,
    }
    config = {
        "parameters": {"analysis": "transient", "relativeTolerance": 1e-8, "maxIterations": 30, "geometricNonlinear": False},
        "initializations": [
            {"methodId": "fea.initial-motion", "target": ["experiment.solid"], "parameters": {
                "initialVelocity": [.001, .002, .003], "initialAngularVelocity": [0., 0., 0.], "referencePoint": [0., 0., 0.],
            }},
            {"methodId": "fea.time", "parameters": settings},
        ],
        "boundaryConditions": [],
        "outputs": [{"methodId": "fea.displacement-history", "key": "displacement", "parameters": {"scope": "cumulative"},
                     "boxGrid": grid(shape=(1, 1, 1), origin=(.1, .1, .1), size=(.1, .1, .1)).geometry}],
        "exports": [
            {"methodId": "fea.motion", "key": "prediction", "parameters": {}},
            {"methodId": "fea.transient-surface-motion", "key": "actual", "target": ["experiment.surface.radiating"]},
        ],
    }
    descriptor = next(item["descriptor"] for item in solver_catalog.manifests() if item["descriptor"]["name"] == "structural-mechanics")
    return model, SolverInvocation(config, {}, {}, {}, None, None, descriptor, task_name="structure")


@pytest.mark.asyncio
async def test_initial_surface_frame_is_constraint_consistent_and_not_a_prediction(surface_case):
    model, invocation = surface_case
    result = await run(invocation)
    actual = result.exports["actual"]
    velocity = actual.members["velocity"]
    np.testing.assert_array_equal(actual.members["times"]["value"], [0.])
    np.testing.assert_array_equal(result.exports["prediction"].members["times"], [0., .001, .002])
    assert actual.metadata["frameKind"] == "initial" and actual.metadata["couplingConverged"] is True
    assert actual.metadata["startTime"] == actual.metadata["endTime"] == actual.metadata["timeOrigin"] == 0.
    assert actual.metadata["couplingIteration"] == 0
    assert velocity.values.dtype == np.float64 and velocity.values.shape == (3, 1, 3)
    np.testing.assert_array_equal(velocity.values[:2], 0.)
    np.testing.assert_array_equal(velocity.values[2, 0], [.001, .002, .003])
    np.testing.assert_array_equal(velocity.domain.points, model.points[[0, 1, 3]])
    np.testing.assert_array_equal(velocity.domain.metadata["sourceMeshNodeIds"], [21, 22, 24])
    np.testing.assert_array_equal(velocity.domain.cells["tri3"], [[0, 1, 2]])
    assert velocity.location == "node" and velocity.unit == "m.s-1"
    np.testing.assert_array_equal(velocity.basis, np.eye(3))
    assert velocity.metadata["sampleAxes"][0]["unit"] == "s"


@pytest.mark.asyncio
async def test_solved_surface_span_is_actual_and_checkpoint_replay_is_identical(surface_case):
    _, invocation = surface_case
    initial = await run(invocation)
    checkpoint = initial.state_patch.operations[-1].value
    before = deepcopy(checkpoint)
    continuation = replace(invocation, state={"structural_mechanics": {"structure": checkpoint}})
    result = await run(continuation)
    replay = await run(continuation)
    actual = result.exports["actual"]
    np.testing.assert_array_equal(actual.members["times"]["value"], [0., .001, .002])
    np.testing.assert_array_equal(result.exports["prediction"].members["times"], [.002, .003, .004])
    assert actual.metadata["frameKind"] == "solved-window" and actual.metadata["couplingConverged"] is True
    assert actual.metadata["startTime"] == 0. and actual.metadata["endTime"] == .002
    assert actual.metadata["couplingIteration"] == 1
    np.testing.assert_array_equal(actual.members["velocity"].values, replay.exports["actual"].members["velocity"].values)
    np.testing.assert_array_equal(actual.members["velocity"].values[:, -1], result.state_patch.operations[-1].value["velocity"][[0, 1, 3], :3])
    np.testing.assert_array_equal(checkpoint["velocity"], before["velocity"])
    assert len(checkpoint["history"]["times"]) == 1


@pytest.mark.asyncio
async def test_unconverged_trial_is_labelled_even_though_state_revision_can_be_committed(surface_case):
    _, invocation = surface_case
    initial = await run(invocation)
    checkpoint = initial.state_patch.operations[-1].value
    result = await run(replace(invocation, state={"structural_mechanics": {"structure": checkpoint}},
                               inputs={"previousMotion": SimpleNamespace(value=initial.exports["prediction"])}))
    actual = result.exports["actual"]
    assert result.observations["couplingConverged"] is False
    assert actual.metadata["couplingConverged"] is False and actual.metadata["frameKind"] == "solved-window"
    assert result.state_patch.operations[-1].value["time"] == actual.metadata["endTime"]
    # Existing predictor remains the relaxed trial on this same interval.
    np.testing.assert_array_equal(result.exports["prediction"].members["times"], actual.members["times"]["value"])
    assert not np.array_equal(result.exports["prediction"].members["velocities"][:, [0, 1, 3]],
                              np.moveaxis(actual.members["velocity"].values, 1, 0))


@pytest.mark.asyncio
async def test_actual_surface_sampling_is_independent_of_record_interval_and_probe_box(surface_case):
    _, invocation = surface_case
    initial = await run(invocation)
    continuation = replace(invocation, state={"structural_mechanics": {"structure": initial.state_patch.operations[-1].value}})
    fine = await run(continuation)
    config = deepcopy(invocation.config)
    config["initializations"][-1]["parameters"]["outputInterval"] = .002
    config["outputs"][0]["boxGrid"] = grid(shape=(1, 1, 1), origin=(4., 4., 4.)).geometry
    coarse = await run(replace(continuation, config=config))
    np.testing.assert_array_equal(fine.exports["actual"].members["velocity"].values, coarse.exports["actual"].members["velocity"].values)
    np.testing.assert_array_equal(fine.exports["actual"].members["times"]["value"], coarse.exports["actual"].members["times"]["value"])
    np.testing.assert_array_equal(fine.state_patch.operations[-1].value["velocity"], coarse.state_patch.operations[-1].value["velocity"])
    assert fine.artifacts["displacement"]["value"].shape[3] == 3
    assert coarse.artifacts["displacement"]["value"].shape[3] == 2
    assert not coarse.artifacts["displacement"]["value"].any()


@pytest.mark.asyncio
async def test_adaptive_accepted_steps_are_retained_only_in_actual_surface_samples(surface_case, monkeypatch):
    import app.solvers.structural_mechanics.analyses.window as window

    _, invocation = surface_case
    initial = await run(invocation)
    original = window.transient_step

    def subdivide(*args, **kwargs):
        if args[7] > .0005 + 1e-15:
            raise ValueError("Newmark equilibrium did not converge")
        return original(*args, **kwargs)

    monkeypatch.setattr(window, "transient_step", subdivide)
    result = await run(replace(invocation, state={"structural_mechanics": {"structure": initial.state_patch.operations[-1].value}}))
    np.testing.assert_allclose(result.exports["actual"].members["times"]["value"], [0., .0005, .001, .0015, .002], rtol=0, atol=1e-18)
    assert result.exports["actual"].members["velocity"].values.shape == (3, 5, 3)
    assert len(result.exports["prediction"].members["times"]) == 3
    assert result.artifacts["displacement"]["value"].shape[3] == 3


def test_actual_tiny_time_step_is_not_skipped_by_fixed_absolute_tolerance():
    dt = 1e-15
    invocation, model, solution, settings = clock_invocation(1e-12, 1e-12 - dt, dt, 2 * dt)
    samples = TransientSurfaceSamples({}, np.array([0]))
    solved, _, _, _ = advance_window(invocation, model, solution, settings, prepare_matrices(model), surface_samples=samples)
    assert solved.time > solution.time
    assert len(samples.times) >= 2 and samples.times[-1] == solved.time
    assert np.all(np.diff(samples.times) > 0)
    assert samples.times[-1] - samples.times[0] == pytest.approx(dt, rel=1e-12, abs=0.)


@pytest.mark.asyncio
@pytest.mark.parametrize("analysis,geometric", [("static", False), ("harmonic", False), ("transient", True)])
async def test_reference_transient_surface_export_rejects_other_analysis_regimes(surface_case, analysis, geometric):
    _, invocation = surface_case
    invocation.config["parameters"].update(analysis=analysis, geometricNonlinear=geometric)
    with pytest.raises(ValueError, match="small-displacement transient"):
        await run(invocation)


@pytest.mark.asyncio
async def test_native_surface_payload_and_metadata_survive_resource_transfer(surface_case):
    _, invocation = surface_case
    initial = await run(invocation)
    actual = initial.exports["actual"]
    method = next(item for item in invocation.descriptor["methods"]["exports"] if item["methodId"] == "fea.transient-surface-motion")
    validate_artifact_payload(actual, method["data"], "actual")
    producer, consumer = ResourceStore(), ResourceStore()
    try:
        root = producer.ingest(actual)
        lease = producer.acquire(root)
        copied = consumer.ingest(producer.materialize(root, mutable=False))
        consumer_lease = consumer.acquire(copied)
        producer.release(lease)
        received = consumer.resolve(copied)
        np.testing.assert_array_equal(received.members["velocity"].values, actual.members["velocity"].values)
        assert received.metadata["frameKind"] == "initial" and received.metadata["couplingConverged"] is True
        consumer.release(consumer_lease)
    finally:
        producer.close()
        consumer.close()
