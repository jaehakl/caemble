"""Rigid ABI state continuation, physical root preparation and independent clocks."""

import asyncio
from copy import deepcopy
from dataclasses import replace
from threading import Event

import numpy as np
import pytest

from app.kernel.api import ContentKey, SolverInvocation
from app.kernel.catalog import solver_catalog
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.execution.child import ProcessCancellationToken
from app.kernel.resources import ResourceStore, StateStore
from app.methods.geometry import GeometryService
from app.methods.rigid import angular_velocity, quaternion_to_matrix, rotation_exp
from app.solvers.rigid_body.domain import build_model, model_request
from app.solvers.rigid_body.entry import implementation
from app.solvers.rigid_body.evolution import advance_window, history_values, time_settings
from app.solvers.rigid_body.outputs import native_members
from tests.box_grid_fixtures import grid
from tests.geometry_fixtures import boolean, box, box_inertia, transformed


def invocation(node=None, *, dt=.01, window=.03, duration=.09, output=.017, outputs=False):
    node = box("shape", [1., 2., 3.]) if node is None else node
    scene = {"geometryHash": repr(node), "lengthUnit": "m",
             "roots": [{"id": "body", "node": node, "material": {"name": "solid"}}],
             "geometryGroups": [{"name": "bodies", "rootIds": ["body"]}], "surfaceGroups": []}
    world = {"experiment": scene, "task": {"geometryHash": "empty", "lengthUnit": "m", "roots": [],
                                          "geometryGroups": [], "surfaceGroups": []},
             "materialSelections": {"body": {"solid": {"density": "rho"}}},
             "materials": {"experiment": {"solid": {"models": {"rho": {
                 "model": "mechanics.mass-density@1", "parameters": {"density": {"value": 2.}}}}}}}}
    config = {"parameters": {"massAngularSegments": 32, "subcellSamplesPerAxis": 1},
              "initializations": [
                  {"methodId": "rigid.body", "target": ["experiment.geometry.bodies"], "parameters": {}},
                  {"methodId": "rigid.time", "target": [], "parameters": {
                      "dt": dt, "duration": duration, "windowSize": window, "outputInterval": output}},
                  {"methodId": "rigid.initial-motion", "target": ["experiment.geometry.bodies"],
                   "parameters": {"velocity": [.3, -.1, .2], "angularVelocity": [.7, 1.1, 1.5]}},
              ], "boundaryConditions": [{"methodId": "rigid.gravity", "target": ["experiment.geometry.bodies"],
                                            "parameters": {"acceleration": [0., 0., -9.81]}}],
              "outputs": [], "exports": [{"methodId": "rigid.snapshot", "key": "pose", "parameters": {}}]}
    if outputs:
        config["outputs"] = [{"methodId": "rigid.mass-density", "key": "density", "parameters": {"scope": "final"},
                              "boxGrid": grid(shape=(1, 1, 1), origin=(100., 100., 100.)).geometry}]
    return SolverInvocation(config, {}, {}, world, GeometryService(), None,
                            solver_catalog.descriptor("rigid_body", "2.0.0"), task_name="motion")


async def run_to_end(current):
    result = None
    count = int(np.ceil(time_settings(current.config)["duration"] / time_settings(current.config)["windowSize"]))
    for _ in range(count):
        result = await implementation(current)
        saved = result.state_patch.operations[-1].value
        current = replace(current, state={"rigid_body": {current.task_name: saved}})
    return result, saved


@pytest.mark.asyncio
async def test_first_call_initializes_and_advances_with_valid_native_catalog_contracts():
    case = invocation()
    result = await implementation(case)
    saved = result.state_patch.operations[-1].value
    assert implementation.abi_version == 3
    assert case.state == {}
    assert [item.path for item in result.state_patch.operations] == [("rigid_body",), ("rigid_body", "motion")]
    assert result.observations["time"] == .03
    assert result.observations["stepCount"] == 3
    np.testing.assert_allclose(saved["position"][0], [.3*.03, -.1*.03, .2*.03 - .5*9.81*.03**2], atol=1e-15)
    np.testing.assert_allclose(saved["velocity"][0], [.3, -.1, .2 - 9.81*.03], atol=1e-15)
    np.testing.assert_array_equal(result.exports["pose"].members["times"]["value"], [.03])
    np.testing.assert_allclose(history_values(saved)["times"], [0., .017])
    np.testing.assert_allclose(result.visualizations["motion"].members["times"]["value"], [0., .017, .03])
    definition = case.descriptor["methods"]["exports"][0]
    validate_artifact_payload(result.exports["pose"], definition["data"], "pose")
    validate_artifact_payload(result.visualizations["motion"], case.descriptor["visualizations"]["motion"]["data"], "motion")


@pytest.mark.asyncio
async def test_state_patch_branches_preserve_input_and_reuse_prepared_model(monkeypatch):
    case = invocation()
    resources, states = ResourceStore(), None
    try:
        states = StateStore(resources)
        first_result = await implementation(case)
        first = states.commit(None, first_result.state_patch, producer_task="motion")
        before = str(ContentKey.from_parts("test.state", first.to_mutable(copy_arrays=True)))
        original_model = first["rigid_body"]["motion"]["model"]

        async def unexpected_model(*_args):
            raise AssertionError("mass properties were rebuilt during continuation")

        monkeypatch.setattr("app.solvers.rigid_body.entry.build_model", unexpected_model)
        resumed = replace(case, state=first)
        left_result, right_result = await implementation(resumed), await implementation(resumed)
        assert str(ContentKey.from_parts("test.state", first.to_mutable(copy_arrays=True))) == before
        left = states.commit(first, left_result.state_patch, producer_task="motion")
        right = states.commit(first, right_result.state_patch, producer_task="motion")
        for name in ("position", "velocity", "orientation", "angularMomentum"):
            np.testing.assert_array_equal(left["rigid_body"]["motion"][name], right["rigid_body"]["motion"][name])
        assert left.parent_revision == right.parent_revision == first.revision
        np.testing.assert_array_equal(left["rigid_body"]["motion"]["model"]["masses"], original_model["masses"])
        assert first["rigid_body"]["motion"]["time"] == .03
        states.release(first)
        states.release(left)
        states.release(right)
    finally:
        if states is not None:
            states.close()
        assert resources.stats().resource_count == 0
        resources.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("window,duration", [(.03, .09), (.1, 1.), (.2, 1.), (.05, 1.), (.07, 1.), (.1, .105)])
async def test_matching_internal_step_sequence_has_identical_split_and_continuous_results(window, duration):
    single_result, single = await run_to_end(invocation(window=duration, duration=duration))
    split_result, split = await run_to_end(invocation(window=window, duration=duration))
    assert single["steps"] == split["steps"] == int(np.ceil(duration/.01))
    assert single["time"] == split["time"] == duration
    for name in ("position", "velocity", "orientation", "angularMomentum"):
        np.testing.assert_array_equal(single[name], split[name])
        np.testing.assert_array_equal(history_values(single)[name], history_values(split)[name])
    np.testing.assert_array_equal(history_values(single)["times"], history_values(split)["times"])
    assert single_result.observations["kineticEnergy"] == split_result.observations["kineticEnergy"]


@pytest.mark.asyncio
async def test_genuinely_partial_window_boundaries_keep_their_internal_steps(monkeypatch):
    from app.solvers.rigid_body import evolution
    original = evolution.midpoint_step
    increments = []

    def capture_steps(state, mass, inverse, dt, **loads):
        increments.append(dt)
        return original(state, mass, inverse, dt, **loads)

    monkeypatch.setattr(evolution, "midpoint_step", capture_steps)
    _, saved = await run_to_end(invocation(dt=.01, window=.027, duration=.09))
    expected = [.01, .01, .007, .003, .01, .01, .004, .006, .01, .01, .001, .009]
    np.testing.assert_allclose(increments, expected, rtol=0., atol=3e-17)
    assert saved["steps"] == len(expected)
    assert saved["time"] == .09


@pytest.mark.asyncio
async def test_arbitrary_clock_intervals_use_dense_output_and_exact_final_endpoint():
    case = invocation(dt=.011, window=.027, duration=.101, output=.013)
    result, saved = await run_to_end(case)
    expected = np.r_[np.arange(8) * .013, .101]
    history = history_values(saved)
    np.testing.assert_array_equal(history["times"], expected)
    assert np.all(np.diff(history["times"]) > 0)
    np.testing.assert_allclose(history["position"][:, 0, :2], expected[:, None] * [.3, -.1], atol=2e-15)
    np.testing.assert_allclose(history["position"][:, 0, 2], .2*expected - .5*9.81*expected**2, atol=2e-15)
    assert saved["time"] == result.observations["time"] == .101
    assert saved["completedWindows"] == 4
    np.testing.assert_array_equal(result.exports["pose"].members["times"]["value"], [.101])
    with pytest.raises(ValueError, match="already reached"):
        await implementation(replace(case, state={"rigid_body": {"motion": saved}}))


@pytest.mark.asyncio
async def test_no_new_output_preserves_final_sample_but_native_and_visual_reach_endpoint():
    case = invocation(window=.03, duration=.12, output=.1, outputs=True)
    for index in range(1, 5):
        result = await implementation(case)
        saved = result.state_patch.operations[-1].value
        expected_history = [0.] if index < 4 else [0., .1, .12]
        expected_final = 0. if index < 4 else .12
        np.testing.assert_array_equal(result.artifacts["density"]["axes"][3]["ticks"], [expected_final])
        np.testing.assert_array_equal(history_values(saved)["times"], expected_history)
        np.testing.assert_array_equal(result.exports["pose"].members["times"]["value"], [index*.03])
        np.testing.assert_array_equal(result.visualizations["motion"].members["times"]["value"],
                                      [*expected_history, index*.03] if index < 4 else expected_history)
        case = replace(case, state={"rigid_body": {"motion": saved}})


@pytest.mark.asyncio
async def test_observation_grid_precision_interval_and_scope_do_not_change_model_or_dynamics():
    first_case = invocation(output=.007, outputs=True)
    second_case = invocation(output=.023, outputs=True)
    second_case.config["parameters"]["subcellSamplesPerAxis"] = 2
    second_case.config["outputs"][0]["parameters"]["scope"] = "cumulative"
    second_case.config["outputs"][0]["boxGrid"] = grid(shape=(3, 2, 1), origin=(30., 40., 50.)).geometry
    second_case.world["experiment"]["roots"].append({"id": "observation", "node": box("probe", [4., 5., 6.])})
    second_case.world["experiment"]["geometryHash"] = "added-observation-box"
    assert model_request(first_case)[-1] == model_request(second_case)[-1]
    _, first = await run_to_end(first_case)
    _, second = await run_to_end(second_case)
    assert first["model"]["identity"] == second["model"]["identity"]
    for name in ("position", "velocity", "orientation", "angularMomentum"):
        np.testing.assert_array_equal(first[name], second[name])
    for name in ("masses", "localCenters", "inertias", "bodyIds"):
        np.testing.assert_array_equal(first["model"][name], second["model"][name])


@pytest.mark.asyncio
async def test_root_loads_and_initial_motion_apply_to_each_disconnected_component():
    pair = boolean("pair", "union", transformed(box("first", [1., 1., 1.]), [-2., 0., 0.]),
                   transformed(box("second", [2., 1., 1.]), [2., 0., 0.]))
    case = invocation(pair)
    for method, values in (("rigid.force", {"force": [3., 2., 1.]}),
                           ("rigid.torque", {"torque": [1., 2., 3.]}),
                           ("rigid.point-force", {"point": [0., 1., 0.], "force": [0., 0., 2.]})):
        case.config["boundaryConditions"].append({"methodId": method, "target": ["experiment.geometry.bodies"], "parameters": values})
    model, state = await build_model(case, model_request(case))
    assert len(model["bodyIds"]) == len(set(model["bodyIds"])) == 2
    assert all(body_id.startswith("experiment:body:") for body_id in model["bodyIds"])
    np.testing.assert_allclose(sorted(model["masses"]), [2., 4.], atol=1e-13)
    np.testing.assert_allclose(state["velocity"], np.tile([.3, -.1, .2], (2, 1)))
    np.testing.assert_allclose(angular_velocity(state["orientation"], model["inverseInertias"], state["angularMomentum"]),
                               np.tile([.7, 1.1, 1.5], (2, 1)), atol=2e-15)
    np.testing.assert_allclose(model["force"], np.tile([3., 2., 1.], (2, 1)) + model["masses"][:, None] * [0., 0., -9.81])
    np.testing.assert_array_equal(model["torque"], np.tile([1., 2., 3.], (2, 1)))
    np.testing.assert_array_equal(model["attachmentBodyIndices"], [0, 1])
    np.testing.assert_allclose(model["attachmentArms"], [0., 1., 0.] - model["localCenters"])


@pytest.mark.asyncio
async def test_nonuniform_scaled_rotated_root_preserves_origin_com_and_si_inertia():
    rotation = rotation_exp([.2, -.3, .7])
    stretch = np.diag([2., 3., 4.])
    offset = np.array([50., -25., 10.])
    node = transformed(transformed(box("shape", [10., 20., 30.]), [5., 0., 0.]), offset, rotation @ stretch)
    case = invocation(node)
    case.world["experiment"]["lengthUnit"] = "mm"
    model, state = await build_model(case, model_request(case))
    expected_local_center = np.array([.01, 0., 0.])
    expected_mass = 2. * .02 * .06 * .12
    np.testing.assert_allclose(quaternion_to_matrix(state["orientation"])[0], rotation, atol=2e-15)
    # Leading transforms establish the frame origin; remaining local center is zero.
    np.testing.assert_allclose(model["localCenters"], 0., atol=2e-16)
    np.testing.assert_allclose(state["position"][0], offset*.001 + rotation @ expected_local_center, atol=2e-16)
    np.testing.assert_allclose(model["masses"], [expected_mass], rtol=2e-14)
    np.testing.assert_allclose(model["inertias"][0], box_inertia([.02, .06, .12], expected_mass), atol=2e-19)
    reconstructed = state["position"][0] + (model["vertices"] - model["localCenters"][0]) @ rotation.T
    canonical = await case.geometry.solid_components(case.world["experiment"], "body", "m")
    np.testing.assert_allclose(reconstructed, canonical[0].mesh.vertices, atol=2e-16)


@pytest.mark.asyncio
async def test_cancellation_during_dense_sampling_does_not_change_or_commit_checkpoint(monkeypatch):
    case = invocation(dt=.01, window=.03, duration=.09, output=.0001)
    first = await implementation(case)
    saved = first.state_patch.operations[-1].value
    before = str(ContentKey.from_parts("test.state", saved))
    signal = Event()
    case = replace(case, state={"rigid_body": {"motion": saved}}, cancellation=ProcessCancellationToken(signal))
    from app.solvers.rigid_body import evolution
    original = evolution.interpolate_step
    calls = 0

    def cancel_after_sample(*args):
        nonlocal calls
        calls += 1
        signal.set()
        return original(*args)

    monkeypatch.setattr(evolution, "interpolate_step", cancel_after_sample)
    with pytest.raises(asyncio.CancelledError):
        await implementation(case)
    assert calls == 1
    assert str(ContentKey.from_parts("test.state", saved)) == before


@pytest.mark.asyncio
async def test_unrepresentable_dt_or_window_boundaries_fail_without_spinning():
    case = invocation()
    result = await implementation(case)
    saved = result.state_patch.operations[-1].value
    for dt, window, count, next_tick in ((1., 10., 10**15, 10**16 + 1), (10., 1., 10**16, 10**15 + 1)):
        settings = {"dt": dt, "windowSize": window, "duration": 1e16 + 20., "outputInterval": 10.}
        modified = {**saved, "time": 1e16, "completedWindows": count, "nextDtTick": next_tick,
                    "nextOutputTick": 10**15 + 1}
        with pytest.raises(ValueError, match="cannot advance representable time"):
            await advance_window(case, saved["model"], modified, settings)


@pytest.mark.asyncio
async def test_changed_physical_model_or_continuation_clock_is_rejected():
    case = invocation()
    result = await implementation(case)
    saved = result.state_patch.operations[-1].value
    changed = deepcopy(case.config)
    changed["initializations"][1]["parameters"]["dt"] *= .5
    with pytest.raises(ValueError, match="time settings"):
        await implementation(replace(case, config=changed, state={"rigid_body": {"motion": saved}}))
    changed = deepcopy(case.config)
    changed["boundaryConditions"][0]["parameters"]["acceleration"] = [0., 0., -5.]
    with pytest.raises(ValueError, match="different geometry, material or load model"):
        await implementation(replace(case, config=changed, state={"rigid_body": {"motion": saved}}))


@pytest.mark.asyncio
async def test_repeated_output_ticks_that_round_to_the_same_float_are_rejected():
    case = invocation()
    result = await implementation(case)
    saved = result.state_patch.operations[-1].value
    settings = {"dt": 10., "windowSize": 10., "duration": 1e16 + 20., "outputInterval": 1.}
    modified = {**saved, "time": 1e16, "completedWindows": 10**15,
                "nextDtTick": 10**15 + 1, "nextOutputTick": 10**16 + 2}
    with pytest.raises(ValueError, match="output settings cannot advance representable time"):
        await advance_window(case, saved["model"], modified, settings)


@pytest.mark.asyncio
async def test_display_resolution_cannot_change_fixed_profile_mass_or_forced_motion():
    saved = []
    for segments in (16, 64):
        node = {"kind": "primitive", "nodeId": "sphere", "primitive": "sphere",
                "parameters": {"radius": 1., "segments": segments}}
        case = invocation(node)
        case.config["boundaryConditions"].append({"methodId": "rigid.force", "target": ["experiment.geometry.bodies"],
                                                 "parameters": {"force": [.5, 1., .2]}})
        _, final = await run_to_end(case)
        saved.append(final)
    for name in ("position", "velocity", "orientation", "angularMomentum"):
        np.testing.assert_array_equal(saved[0][name], saved[1][name])
    for name in ("masses", "localCenters", "inertias", "bodyIds"):
        np.testing.assert_array_equal(saved[0]["model"][name], saved[1]["model"][name])


@pytest.mark.asyncio
async def test_progress_is_throttled_by_wall_time_and_preserves_first_and_final_steps(monkeypatch):
    case = invocation(dt=.01, window=.1, duration=.1)
    reference = await implementation(case)
    clock = iter([0., .01, .02, .03, .04, .06, .061, .062, .063, .064])
    monkeypatch.setattr("app.solvers.rigid_body.evolution.monotonic", lambda: next(clock))
    reported = []

    async def progress(value):
        if value["stage"] == "rigid-motion":
            reported.append(value["completed"])

    result = await implementation(replace(case, progress=progress))
    assert reported == [.01, .06, .1]
    first, second = reference.state_patch.operations[-1].value, result.state_patch.operations[-1].value
    for name in ("position", "velocity", "orientation", "angularMomentum"):
        np.testing.assert_array_equal(first[name], second[name])


@pytest.mark.asyncio
async def test_mass_properties_error_identifies_source_root_and_preserves_cause():
    case = invocation()
    case.world["materials"]["experiment"]["solid"]["models"]["rho"]["parameters"]["density"] = 0.
    with pytest.raises(ValueError, match="experiment:body.*density") as caught:
        await implementation(case)
    assert isinstance(caught.value.__cause__, ValueError)


@pytest.mark.asyncio
@pytest.mark.parametrize("velocity,dt,expected", [(1e308, 2., "motion failed"), (1e200, .01, "kinetic energy is nonfinite")])
async def test_numerical_overflow_is_rejected_before_native_result_or_state_commit(velocity, dt, expected):
    case = invocation(dt=dt, window=dt, duration=dt, output=2*dt)
    case.config["initializations"][2]["parameters"] = {"velocity": [velocity, 0., 0.], "angularVelocity": [0., 0., 0.]}
    with pytest.raises(ValueError, match=expected) as caught:
        await implementation(case)
    assert f"time {dt:g}" in str(caught.value)
    assert "experiment:body:" in str(caught.value)
    assert case.state == {}


@pytest.mark.asyncio
async def test_native_angular_velocity_overflow_is_rejected_with_sample_time_and_body():
    case = invocation()
    model, initial = await build_model(case, model_request(case))
    model = {**model, "inertias": np.diag([1e-308, 1., 1.])[None],
             "inverseInertias": np.diag([1e308, 1., 1.])[None]}
    samples = {"times": np.array([.017]), **{name: value[None] for name, value in initial.items()}}
    samples["orientation"] = np.array([[[1., 0., 0., 0.]]])
    samples["angularMomentum"] = np.array([[[2., 0., 0.]]])
    assert all(np.all(np.isfinite(value)) for value in samples.values())
    assert np.all(np.isfinite(model["inverseInertias"]))
    with pytest.raises(ValueError, match="native angularVelocities is nonfinite at time 0.017") as caught:
        native_members(model, samples, mesh=True)
    assert model["bodyIds"][0] in str(caught.value)
