"""선택 절점 이력의 좌표, 불변 checkpoint, 출력 범위를 검증합니다."""

from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api import BundleValue
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.catalog import solver_catalog
from app.kernel.resources import ArtifactStore
from app.kernel.resources.store import ResourceStore
from app.kernel.transport.recording import materialize_record_value
from app.kernel.transport.tensor import encode_recorded_data
from app.solvers.structural_mechanics.analysis import initial_solution
from app.solvers.structural_mechanics.coupling import advance_window, predict_motion
from app.solvers.structural_mechanics.formulation import prepare_matrices
from app.solvers.structural_mechanics.model import StructuralModel
from app.solvers.structural_mechanics.outputs import build_outputs, configure_history, history_members
from app.solvers.structural_mechanics.state import append_history, encode_state, read_state


def history_case():
    model = StructuralModel(np.array([10, 20, 90]), np.zeros((3, 3)), [], np.array([0, 6, 12]), np.empty(0, dtype=int), np.zeros((3, 6)), identity="selected-history")
    model.masses = [(node, 1., np.zeros((3, 3))) for node in range(3)]
    configure_history(model, [{"methodId": "fea.history", "parameters": {"nodeIds": [90, 10], "scope": "final"}}])
    solution = initial_solution(model)
    solution.velocity[:, 0] = [.1, .2, .3]
    append_history(model, solution, pitch=.2)
    settings = {"dt": .01, "windowSize": .02, "duration": .04, "outputInterval": .01, "dampingMass": 0., "dampingStiffness": 0., "couplingTolerance": 1e-4, "maxCouplingIterations": 12, "relaxation": .5}
    invocation = SimpleNamespace(inputs={}, config={"parameters": {"relativeTolerance": 1e-10, "maxIterations": 10, "geometricNonlinear": False}}, cancellation=None)
    return model, solution, settings, invocation


def test_selected_node_order_and_multiple_output_union():
    model, solution, _, _ = history_case()
    configure_history(model, [{"methodId": "fea.history", "parameters": {"nodeIds": [90, 20]}}, {"methodId": "fea.history", "parameters": {"nodeIds": [20, 10]}}])
    solution.history = {}
    solution.displacement[:, 0] = model.node_ids
    append_history(model, solution)
    assert model.history_nodes.tolist() == [2, 1, 0]
    first = history_members(model, solution, [90, 20])
    second = history_members(model, solution, [20, 10])
    np.testing.assert_array_equal(first["nodeIds"], [90, 20])
    np.testing.assert_array_equal(first["displacement"][0, :, 0], [90, 20])
    np.testing.assert_array_equal(second["displacement"][0, :, 0], [20, 10])
    with pytest.raises(ValueError, match="absent"):
        configure_history(model, [{"methodId": "fea.history", "parameters": {"nodeIds": [999]}}])
    with pytest.raises(ValueError, match="unique"):
        configure_history(model, [{"methodId": "fea.history", "parameters": {"nodeIds": [90, 90]}}])


def test_window_chunks_restart_replay_and_initial_sample_are_preserved():
    model, initial, settings, invocation = history_case()
    matrices = prepare_matrices(model)
    checkpoint = encode_state(model, initial)
    first = advance_window(invocation, model, read_state(model, checkpoint), settings, matrices)[0]
    replay = advance_window(invocation, model, read_state(model, checkpoint), settings, matrices)[0]
    assert [chunk.shape for chunk in first.history["displacement"]] == [(1, 2, 3), (2, 2, 3)]
    assert first.history["displacement"][0] is checkpoint["history"]["displacement"][0]
    assert not first.history["displacement"][-1].flags.writeable
    np.testing.assert_array_equal(history_members(model, first)["displacement"], history_members(model, replay)["displacement"])
    assert len(checkpoint["history"]["times"]) == 1
    second = advance_window(invocation, model, read_state(model, encode_state(model, first)), settings, matrices)[0]
    complete = history_members(model, second, scope="final", complete=True)
    np.testing.assert_allclose(complete["times"], [0., .01, .02, .03, .04])
    np.testing.assert_allclose(complete["displacement"][:, :, 0], complete["times"][:, None] * [.3, .1])
    np.testing.assert_allclose(history_members(model, second, scope="latest-window")["times"], [.03, .04])
    np.testing.assert_allclose(complete["pitch"], .2)


def test_final_scope_empty_tensors_obey_actual_artifact_and_resource_contract():
    model, solution, _, _ = history_case()
    members = history_members(model, solution, [90, 10], "final", complete=False)
    assert members["times"].shape == (0,)
    assert members["displacement"].shape == (0, 2, 3)
    contract = {"resourceKind": "structuredBundle", "members": {}}
    for name, values in members.items():
        member = {"dtype": str(values.dtype), "axes": [{"name": "node"}] if name == "nodeIds" else [{"name": "sample"}]}
        if values.ndim == 3:
            member.update(axes=[{"name": "sample"}, {"name": "node"}], tensorOrder=1, basis=["x", "y", "z"])
        contract["members"][name] = member
    value = BundleValue("caemble.mechanics/history@1", members)
    validate_artifact_payload(value, contract, "history")
    store = ResourceStore()
    try:
        store.ingest(value)
    finally:
        store.close()


def test_scalar_mechanical_history_survives_without_requested_node_output():
    model, solution, settings, _ = history_case()
    configure_history(model, [])
    solution.history = {}
    append_history(model, solution, pitch=.3)
    assert solution.history["displacement"][0].shape == (1, 0, 3)
    np.testing.assert_allclose(predict_motion(model, solution, settings).members["pitch"], .3)
    saved = encode_state(model, solution)
    configure_history(model, [{"methodId": "fea.history", "parameters": {"nodeIds": [90]}}])
    with pytest.raises(ValueError, match="selection differs"):
        read_state(model, saved)


@pytest.mark.parametrize("complete", [False, True])
def test_recorded_history_retains_physical_time_and_selected_node_axes(complete):
    """실제 ABI/기록 경계를 통과해도 Calculation용 시간/절점 좌표가 남아야 합니다."""
    model, solution, _, _ = history_case()
    descriptor = solver_catalog.descriptor("structural-mechanics", "1.0.0")
    config = {"outputs": [{"methodId": "fea.history", "key": "history", "parameters": {"nodeIds": [90, 10], "scope": "final"}}]}
    definition = next(item for item in descriptor["methods"]["outputs"] if item["methodId"] == "fea.history")
    value = build_outputs(config, descriptor, model, solution, history_complete=complete)["history"]
    validate_artifact_payload(value, definition["data"], "history")
    resources = ResourceStore()
    artifacts = ArtifactStore(resources)
    leases = []
    try:
        handle = artifacts.publish(value, producer_task="structure", solver_name="structural-mechanics", solver_version="1.0.0", output_name="history", artifact_type=definition["artifactType"], state_revision=1)
        schema = definition["data"]["members"]
        recorded = materialize_record_value(handle, schema, resources=resources, artifacts=artifacts, owner="record", leases=leases)
        encoded, attachments, _ = encode_recorded_data("history", schema, recorded, 1)
        assert not attachments
        expected_times = [0.] if complete else []
        assert encoded["rotorSpeed"]["axes"] == [{"ticks": expected_times, "unit": "s"}]
        assert encoded["displacement"]["axes"] == [{"ticks": expected_times, "unit": "s"}, {"ticks": [90, 10]}, {"implicitOrdinal": True}]
        assert encoded["nodeIds"]["axes"] == [{"ticks": [90, 10]}]
        assert encoded["displacement"]["shape"] == [int(complete), 2, 3]
    finally:
        for lease in reversed(leases):
            resources.release(lease)
        artifacts.close()
        assert resources.stats().resource_count == 0
        resources.close()
