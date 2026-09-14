"""Pressure recording cadence and Box sampling never change acoustic integration."""

from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.catalog import solver_catalog
from app.solvers.pressure_acoustics.transient_fdtd.domain import CartesianAcousticGrid
from app.solvers.pressure_acoustics.transient_fdtd.run import run_transient
from tests.test_box_grid_outputs import grid


@pytest.fixture
def recording_invocation(monkeypatch):
    import importlib
    module = importlib.import_module("app.solvers.pressure_acoustics.transient_fdtd.run")
    model = CartesianAcousticGrid(np.zeros(3), np.array([.5, .1, .1]), (10, 2, 2), 1.2, 343.,
                                  {"inlet": {(0, 0)}, "outlet": {(0, 1)}})

    async def built_grid(_):
        return model

    monkeypatch.setattr(module, "build_grid", built_grid)
    config = {
        "initializations": [{"methodId": "acoustics.time", "parameters": {"dt": 1e-5, "totalSteps": 127}}],
        "boundaryConditions": [
            {"methodId": "acoustics.tone-burst-velocity", "target": ["inlet"],
             "parameters": {"amplitude": -.001, "frequency": 250., "startTime": 0., "duration": .004}},
            {"methodId": "acoustics.impedance", "target": ["outlet"], "parameters": {"resistance": 411.6}},
        ],
        "outputs": [{"methodId": "acoustics.pressure-history", "key": "pressure", "parameters": {"sampleEvery": 7},
                     "boxGrid": grid(shape=(5, 1, 1), origin=(0., 0., 0.), size=(.5, .1, .1)).geometry}],
    }
    return SimpleNamespace(config=config, task_name="air", state={}, inputs={}, progress=None, cancellation=None,
                           descriptor=solver_catalog.descriptor("pressure-acoustics", "1.1.0"))


@pytest.mark.asyncio
async def test_cumulative_recording_is_identical_across_nonmatching_windows(recording_invocation):
    invocation = recording_invocation
    single = await run_transient(invocation)
    expected = single.artifacts["pressure"]
    assert expected["value"].shape == (5, 1, 1, 19, 1, 1, 1)
    np.testing.assert_allclose(expected["axes"][3]["ticks"], np.arange(19) * 7e-5, rtol=0, atol=3e-19)
    assert expected["axes"][3]["ticks"][-1] < single.observations["time"]
    invocation.config["initializations"][0]["parameters"]["windowSteps"] = 27
    while not invocation.state or invocation.state["pressure_acoustics"]["air"]["restart"]["step"] < 127:
        prior = None if not invocation.state else invocation.state["pressure_acoustics"]["air"]
        result = await run_transient(invocation)
        saved = result.state_patch.operations[-1].value
        if prior is not None:
            assert saved["recording"]["pressure"]["times"][0] is prior["recording"]["pressure"]["times"][0]
            assert saved["recording"]["pressure"]["values"][0] is prior["recording"]["pressure"]["values"][0]
        invocation.state = {"pressure_acoustics": {"air": saved}}
    np.testing.assert_array_equal(result.artifacts["pressure"]["value"], expected["value"])
    np.testing.assert_array_equal(result.artifacts["pressure"]["axes"][3]["ticks"], expected["axes"][3]["ticks"])
    assert not saved["recording"]["pressure"]["values"][0].flags.writeable
    for key in ("pressure", "vx", "vy", "vz"):
        np.testing.assert_array_equal(saved["restart"][key], single.state_patch.operations[-1].value["restart"][key])


@pytest.mark.asyncio
async def test_output_stride_rotated_boxes_and_no_output_preserve_physical_state(recording_invocation):
    invocation = recording_invocation
    reference = await run_transient(invocation)
    config = deepcopy(invocation.config)
    rotation = np.array([[0., -1., 0.], [1., 0., 0.], [0., 0., 1.]])
    config["outputs"][0].update(parameters={"sampleEvery": 13},
        boxGrid=grid(shape=(1, 4, 1), origin=(.5, 0., 0.), size=(.1, .5, .1), rotation=rotation).geometry)
    config["outputs"].append({"methodId": "acoustics.pressure-history", "key": "outside", "parameters": {},
                              "boxGrid": grid(shape=(1, 1, 1), origin=(5., 5., 5.), size=(.1, .1, .1)).geometry})
    invocation.config = config
    sampled = await run_transient(invocation)
    assert sampled.artifacts["pressure"]["value"].shape == (1, 4, 1, 10, 1, 1, 1)
    np.testing.assert_array_equal(sampled.artifacts["pressure"]["boxGrid"]["rotation"], rotation)
    assert np.any(sampled.artifacts["pressure"]["value"] != 0)
    np.testing.assert_array_equal(sampled.artifacts["outside"]["value"], 0.)
    invocation.config = {**config, "outputs": []}
    unrecorded = await run_transient(invocation)
    for key in ("pressure", "vx", "vy", "vz"):
        physical = reference.state_patch.operations[-1].value["restart"][key]
        np.testing.assert_array_equal(sampled.state_patch.operations[-1].value["restart"][key], physical)
        np.testing.assert_array_equal(unrecorded.state_patch.operations[-1].value["restart"][key], physical)


@pytest.mark.asyncio
async def test_window_with_no_new_output_keeps_existing_nonempty_sample(recording_invocation):
    invocation = recording_invocation
    invocation.config["initializations"][0]["parameters"]["windowSteps"] = 5
    invocation.config["outputs"][0]["parameters"]["sampleEvery"] = 100
    first = await run_transient(invocation)
    invocation.state = {"pressure_acoustics": {"air": first.state_patch.operations[-1].value}}
    second = await run_transient(invocation)
    np.testing.assert_array_equal(second.artifacts["pressure"]["axes"][3]["ticks"], [0.])
    np.testing.assert_array_equal(second.artifacts["pressure"]["value"], first.artifacts["pressure"]["value"])
    assert second.observations["time"] > first.observations["time"]


@pytest.mark.asyncio
async def test_rejected_grid_checkpoint_does_not_damage_the_original(recording_invocation):
    invocation = recording_invocation
    invocation.config["initializations"][0]["parameters"]["windowSteps"] = 13
    first = await run_transient(invocation)
    original = first.state_patch.operations[-1].value
    snapshot = deepcopy(original)
    wrong_grid = {**original, "restart": {**original["restart"], "gridSpacing": original["restart"]["gridSpacing"] * 2}}
    invocation.state = {"pressure_acoustics": {"air": wrong_grid}}
    with pytest.raises(ValueError, match="physical grid"):
        await run_transient(invocation)
    np.testing.assert_equal(original, snapshot)
    invocation.state = {"pressure_acoustics": {"air": original}}
    resumed = await run_transient(invocation)
    assert resumed.observations["stepCount"] == 26
    np.testing.assert_equal(original, snapshot)


@pytest.mark.parametrize("change", ["box", "stride", "new-output", "removed-output"])
@pytest.mark.asyncio
async def test_recording_definition_change_is_rejected_without_relabeling_old_history(recording_invocation, change):
    invocation = recording_invocation
    invocation.config["initializations"][0]["parameters"]["windowSteps"] = 5
    invocation.config["outputs"][0]["parameters"]["sampleEvery"] = 100
    first = await run_transient(invocation)
    original = first.state_patch.operations[-1].value
    snapshot = deepcopy(original)
    config = deepcopy(invocation.config)
    expected_invocation = deepcopy(invocation)
    expected_invocation.state = {"pressure_acoustics": {"air": original}}
    expected = await run_transient(expected_invocation)
    if change == "box":
        # Identical sample shape must not allow old locations to acquire new labels.
        config["outputs"][0]["boxGrid"] = {**config["outputs"][0]["boxGrid"], "origin": [.1, 0., 0.]}
    elif change == "stride":
        config["outputs"][0]["parameters"]["sampleEvery"] = 13
    elif change == "new-output":
        # No sample at step 6..10 would exist for this new output's stride.
        config["outputs"].append({**deepcopy(config["outputs"][0]), "key": "new-pressure"})
    else:
        config["outputs"] = []
    original_config = invocation.config
    invocation.config = config
    invocation.state = {"pressure_acoustics": {"air": original}}
    with pytest.raises(ValueError, match="recording.*changed.*initial state"):
        await run_transient(invocation)
    np.testing.assert_equal(original, snapshot)
    invocation.config = original_config
    resumed = await run_transient(invocation)
    np.testing.assert_equal(resumed.state_patch.operations[-1].value, expected.state_patch.operations[-1].value)
    np.testing.assert_array_equal(resumed.artifacts["pressure"]["value"], expected.artifacts["pressure"]["value"])
    np.testing.assert_equal(original, snapshot)


@pytest.mark.parametrize("invalid_step", [1.5, True, np.nan, np.inf])
@pytest.mark.asyncio
async def test_invalid_checkpoint_step_is_rejected_without_truncation(recording_invocation, invalid_step):
    invocation = recording_invocation
    invocation.config["initializations"][0]["parameters"]["windowSteps"] = 5
    first = await run_transient(invocation)
    original = first.state_patch.operations[-1].value
    invalid = {**original, "restart": {**original["restart"], "step": invalid_step}}
    invocation.state = {"pressure_acoustics": {"air": invalid}}
    with pytest.raises(ValueError, match="step must be a finite integer"):
        await run_transient(invocation)
    invocation.state = {"pressure_acoustics": {"air": original}}
    assert (await run_transient(invocation)).observations["stepCount"] == 10


@pytest.mark.parametrize("field,value", [("pressure", 1j), ("vx", np.nan), ("vy", np.inf), ("vz", -np.inf)])
@pytest.mark.asyncio
async def test_invalid_checkpoint_fields_are_rejected_before_casting(recording_invocation, field, value):
    invocation = recording_invocation
    invocation.config["initializations"][0]["parameters"]["windowSteps"] = 5
    first = await run_transient(invocation)
    original = first.state_patch.operations[-1].value
    snapshot = deepcopy(original)
    values = np.full(original["restart"][field].shape, value)
    invalid = {**original, "restart": {**original["restart"], field: values}}
    invocation.state = {"pressure_acoustics": {"air": invalid}}
    with pytest.raises(ValueError, match=f"checkpoint {field} must contain finite real values"):
        await run_transient(invocation)
    invocation.state = {"pressure_acoustics": {"air": original}}
    assert (await run_transient(invocation)).observations["stepCount"] == 10
    np.testing.assert_equal(original, snapshot)
