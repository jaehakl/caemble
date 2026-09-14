"""선택 절점 이력의 좌표, 불변 checkpoint, 출력 범위를 검증합니다."""

from types import SimpleNamespace
from tests.test_box_grid_outputs import grid

import numpy as np
import pytest

from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.catalog import solver_catalog
from app.kernel.resources import ArtifactStore
from app.kernel.resources.store import ResourceStore
from app.kernel.transport.recording import materialize_record_value
from app.kernel.transport.tensor import encode_recorded_data
from app.solvers.structural_mechanics.state import initial_solution
from app.solvers.structural_mechanics.analyses.window import advance_window
from app.solvers.structural_mechanics.interfaces.motion import predict_motion
from app.solvers.structural_mechanics.operators.linear import prepare_matrices
from app.solvers.structural_mechanics.model import StructuralModel
from app.solvers.structural_mechanics.outputs.build import build_outputs
from app.solvers.structural_mechanics.state import configure_history
from app.solvers.structural_mechanics.outputs.history import history_members
from app.solvers.structural_mechanics.state import append_history
from app.solvers.structural_mechanics.state import encode_state
from app.solvers.structural_mechanics.state import read_state


def history_case():
    model = StructuralModel(np.array([10, 20, 90]), np.zeros((3, 3)), [], np.array([0, 6, 12]), np.empty(0, dtype=int), np.zeros((3, 6)), identity="selected-history")
    model.masses = [(node, 1., np.zeros((3, 3))) for node in range(3)]
    configure_history(model)
    solution = initial_solution(model)
    solution.velocity[:, 0] = [.1, .2, .3]
    append_history(model, solution, pitch=.2)
    settings = {"dt": .01, "windowSize": .02, "duration": .04, "outputInterval": .01, "dampingMass": 0., "dampingStiffness": 0., "couplingTolerance": 1e-4, "maxCouplingIterations": 12, "relaxation": .5}
    invocation = SimpleNamespace(inputs={}, config={"parameters": {"relativeTolerance": 1e-10, "maxIterations": 10, "geometricNonlinear": False}}, cancellation=None)
    return model, solution, settings, invocation


def test_automatic_history_contains_all_nodes_and_requested_internal_order():
    model, solution, _, _ = history_case()
    configure_history(model)
    solution.history = {}
    solution.displacement[:, 0] = model.node_ids
    append_history(model, solution)
    assert model.history_nodes.tolist() == [0, 1, 2]
    first = history_members(model, solution, [90, 20])
    second = history_members(model, solution, [20, 10])
    np.testing.assert_array_equal(first["nodeIds"], [90, 20])
    np.testing.assert_array_equal(first["displacement"][0, :, 0], [90, 20])
    np.testing.assert_array_equal(second["displacement"][0, :, 0], [20, 10])
    with pytest.raises(ValueError, match="absent"):
        history_members(model, solution, [999])
    with pytest.raises(ValueError, match="unique"):
        history_members(model, solution, [90, 90])


def test_window_chunks_restart_replay_and_initial_sample_are_preserved():
    model, initial, settings, invocation = history_case()
    matrices = prepare_matrices(model)
    checkpoint = encode_state(model, initial)
    first = advance_window(invocation, model, read_state(model, checkpoint), settings, matrices)[0]
    replay = advance_window(invocation, model, read_state(model, checkpoint), settings, matrices)[0]
    assert [chunk.shape for chunk in first.history["displacement"]] == [(1, 3, 3), (2, 3, 3)]
    assert first.history["displacement"][0] is checkpoint["history"]["displacement"][0]
    assert not first.history["displacement"][-1].flags.writeable
    np.testing.assert_array_equal(history_members(model, first)["displacement"], history_members(model, replay)["displacement"])
    assert len(checkpoint["history"]["times"]) == 1
    second = advance_window(invocation, model, read_state(model, encode_state(model, first)), settings, matrices)[0]
    complete = history_members(model, second)
    np.testing.assert_allclose(complete["times"], [0., .01, .02, .03, .04])
    np.testing.assert_allclose(complete["displacement"][:, :, 0], complete["times"][:, None] * [.1, .2, .3])
    np.testing.assert_allclose(history_members(model, second, scope="latest-window")["times"], [.03, .04])
    np.testing.assert_allclose(complete["pitch"], .2)


@pytest.mark.parametrize("scope", ["cumulative", "latest-window", "final"])
def test_box_history_scopes_preserve_accepted_windows_and_cumulative_visualization(scope):
    model, initial, settings, invocation = history_case()
    matrices = prepare_matrices(model)
    first = advance_window(invocation, model, initial, settings, matrices)[0]
    second = advance_window(invocation, model, read_state(model, encode_state(model, first)), settings, matrices)[0]
    descriptor = solver_catalog.descriptor("structural-mechanics", "6.1.0")
    config = {"parameters": {"analysis": "transient"}, "outputs": [{
        "methodId": "fea.pitch-history", "key": "pitch", "boxGrid": grid(shape=(1, 1, 1)).geometry,
        "parameters": {"scope": scope},
    }]}
    for solution, cumulative, window in (
        (first, [0., .01, .02], [.01, .02]),
        (second, [0., .01, .02, .03, .04], [.03, .04]),
    ):
        artifacts, _, visuals = build_outputs(config, descriptor, model, solution)
        expected = cumulative if scope == "cumulative" else window if scope == "latest-window" else cumulative[-1:]
        value = artifacts["pitch"]
        assert value["value"].shape == (1, 1, 1, len(expected), 1, 1, 1)
        np.testing.assert_allclose(value["axes"][3]["ticks"], expected)
        np.testing.assert_allclose(value["value"], .2)
        np.testing.assert_allclose(visuals["displacementHistory"].members["times"]["value"], cumulative)
        np.testing.assert_allclose(
            visuals["displacementHistory"].members["values"]["value"][:, :, 0],
            np.asarray(cumulative)[:, None] * [.1, .2, .3],
        )


def test_scalar_mechanical_history_survives_without_requested_node_output():
    model, solution, settings, _ = history_case()
    configure_history(model)
    solution.history = {}
    append_history(model, solution, pitch=.3)
    assert solution.history["displacement"][0].shape == (1, 3, 3)
    np.testing.assert_allclose(predict_motion(model, solution, settings).members["pitch"], .3)
    saved = encode_state(model, solution)
    configure_history(model)
    np.testing.assert_array_equal(read_state(model, saved).history["displacement"][0], solution.history["displacement"][0])


def test_recorded_scalar_history_retains_physical_time_on_box_axes():
    """Preserve Box Grid time and geometry through the artifact/recording boundary."""
    model, solution, _, _ = history_case()
    descriptor = solver_catalog.descriptor("structural-mechanics", "6.1.0")
    config = {"parameters": {"analysis": "static"}, "outputs": [{"methodId": "fea.pitch-history", "key": "history", "boxGrid": grid(shape=(1,1,1)).geometry, "parameters": {"scope": "final"}}]}
    definition = next(item for item in descriptor["methods"]["outputs"] if item["methodId"] == "fea.pitch-history")
    value = build_outputs(config, descriptor, model, solution)[0]["history"]
    validate_artifact_payload(value, definition["data"], "history")
    resources = ResourceStore()
    artifacts = ArtifactStore(resources)
    leases = []
    try:
        handle = artifacts.publish(value, producer_task="structure", solver_name="structural-mechanics", solver_version="6.1.0", output_name="history", artifact_type=definition["artifactType"], state_revision=1)
        schema = definition["data"]
        recorded = materialize_record_value(handle, schema, resources=resources, artifacts=artifacts, owner="record", leases=leases)
        encoded, attachments, _ = encode_recorded_data("history", schema, recorded, 1)
        assert not attachments
        expected_times = [0.]
        assert encoded["axes"][3] == {"ticks": expected_times, "unit": "s"}
        assert encoded["shape"] == [1,1,1,1,1,1,1]
        assert encoded["boxGrid"]["sampling"] == "aggregate"
    finally:
        for lease in reversed(leases):
            resources.release(lease)
        artifacts.close()
        assert resources.stats().resource_count == 0
        resources.close()


@pytest.mark.parametrize("time", [0., .02, .04])
def test_final_box_history_is_last_accepted_sample_of_each_call(time):
    model, solution, _, _ = history_case()
    if time:
        solution.time = time
        append_history(model, solution, pitch=.7)
    descriptor = solver_catalog.descriptor("structural-mechanics", "6.1.0")
    config = {"parameters": {"analysis": "static"}, "outputs": [{
        "methodId": "fea.pitch-history", "key": "pitch", "boxGrid": grid(shape=(1,1,1)).geometry,
        "parameters": {"scope": "final"}}]}
    value = build_outputs(config, descriptor, model, solution)[0]["pitch"]
    assert value["value"].shape == (1,1,1,1,1,1,1)
    np.testing.assert_array_equal(value["axes"][3]["ticks"], [time])
    assert value["value"].item() == pytest.approx(.7 if time else .2)
