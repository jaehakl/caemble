"""Physical step scheduling, rejected candidates and passive observation clocks."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import numpy as np
import pytest

from app.kernel.api import ContentKey
from app.kernel.api.errors import CaeError
from app.solvers.incompressible_flow.domain import FlowDomain
from app.solvers.incompressible_flow.evolution import advance_window
from app.solvers.incompressible_flow.state import history_values, initial_state
from app.solvers.incompressible_flow.transient import PreparedTransientFlow, TransientStepFailure
from tests.test_incompressible_methods import tetrahedral_box
from tests.test_incompressible_physics import pressure_duct_boundaries


class ClockStepper:
    """Exact constant-rate pressure observer for testing the window controller."""

    def __init__(self, mesh, *, transported_speed=0., fail=False, fail_dt_above=None):
        self.mesh, self.transported_speed, self.fail = mesh, transported_speed, fail
        self.fail_dt_above = fail_dt_above
        self.calls = []

    async def step(self, *, pressure, velocity, face_volume_flux, dt, time, **kwargs):
        self.calls.append((time, dt, pressure.copy(), velocity.copy(), face_volume_flux.copy()))
        if self.fail:
            raise ValueError("invalid fixed boundary model")
        if self.fail_dt_above is not None and dt > self.fail_dt_above:
            raise TransientStepFailure("momentum residual=1", time=time + dt, dt=dt,
                                       residuals={"momentum": 1.}, position=self.mesh.cell_centers[0].tolist())
        return SimpleNamespace(pressure=pressure + dt, velocity=velocity.copy(),
            face_volume_flux=self.mesh.area_vectors[:, 0] * self.transported_speed,
            iterations=1, mass_residual=0., momentum_residual=0., pressure_residual=0.)


def window_fixture(*, dt=.1, duration=.4, window=.2, interval=.07):
    mesh = tetrahedral_box((2, 2, 2), (1., 1., 1.))
    velocity = np.full((len(mesh.faces), 3), np.nan)
    velocity[mesh.neighbour < 0] = 0.
    domain = FlowDomain(mesh, 1., 1., np.zeros(3), velocity, np.full(len(mesh.faces), np.nan), "test",
                        {"boundaryFaces": mesh.faces[mesh.boundary_face_map]})
    solution = SimpleNamespace(pressure=np.zeros(len(mesh.cells)), velocity=np.zeros((len(mesh.cells), 3)),
                               face_volume_flux=np.zeros(len(mesh.faces)))
    clock = {"dt": dt, "duration": duration, "windowSize": window, "outputInterval": interval}
    controls = {"maxIterations": 1000, "maxNonlinearIterations": 30, "tolerance": 1e-8, "maxCourant": .5}
    invocation = SimpleNamespace(cancellation=None, progress=None)
    return invocation, domain, initial_state(domain, solution, clock), clock, controls


@pytest.mark.asyncio
async def test_nested_progress_carries_accepted_time_through_retries_and_continuation():
    invocation, domain, saved, clock, controls = window_fixture()
    events = []
    invocation.progress = AsyncMock(side_effect=events.append)

    class ReportingStepper(ClockStepper):
        async def step(self, **kwargs):
            await kwargs["progress"]({"stage": "flow-nonlinear-iteration", "completed": 0,
                                      "total": 30, "time": kwargs["time"] + kwargs["dt"]})
            await kwargs["progress"]({"stage": "flow-pressure-iteration", "completed": 15, "total": 1000})
            return await super().step(**kwargs)

    stepper = ReportingStepper(domain.mesh, fail_dt_above=.03)
    first, _, _ = await advance_window(invocation, domain, saved, clock, controls, stepper)
    split = len(events)
    await advance_window(invocation, domain, first, clock, controls, stepper)
    trials = [event for event in events if event["stage"] == "flow-pressure-iteration"]
    assert [event["physicalTime"] for event in trials[:3]] == [
        {"completed": 0., "total": .4, "dt": dt} for dt in (.1, .05, .025)]
    assert events[0]["time"] == .1 and events[0]["physicalTime"]["completed"] == 0.
    assert events[split]["physicalTime"]["completed"] == .2
    assert events[-1]["physicalTime"]["completed"] == .4
    assert all(event["physicalTime"]["total"] == .4 for event in events)
    assert np.all(np.diff([event["physicalTime"]["completed"] for event in events]) >= 0)
    for event in events:
        if event["stage"] in {"flow-retry", "flow-time"}:
            assert event["completed"] == event["physicalTime"]["completed"]


@pytest.mark.asyncio
async def test_aligned_windows_share_steps_and_keep_endpoint_out_of_history():
    invocation, domain, saved, clock, controls = window_fixture()
    before = ContentKey.from_parts("checkpoint", saved)
    stepper = ClockStepper(domain.mesh)
    first, _, _ = await advance_window(invocation, domain, saved, clock, controls, stepper)
    assert ContentKey.from_parts("checkpoint", saved) == before
    np.testing.assert_allclose(history_values(first)["times"], [0., .07, .14, .2])
    assert .2 not in np.concatenate(first["history"]["times"])
    result, _, _ = await advance_window(invocation, domain, first, clock, controls, stepper)
    whole_stepper = ClockStepper(domain.mesh)
    whole, _, _ = await advance_window(invocation, domain, saved, {**clock, "windowSize": .4}, controls, whole_stepper)
    assert [(call[0], call[1]) for call in stepper.calls] == [(call[0], call[1]) for call in whole_stepper.calls]
    np.testing.assert_array_equal(result["pressure"], whole["pressure"])
    for name in ("times", "pressure", "velocity", "boundaryFlux"):
        np.testing.assert_array_equal(history_values(result)[name], history_values(whole)[name])
    assert result["steps"] == whole["steps"] == 4


@pytest.mark.asyncio
async def test_boundary_flux_history_interpolates_only_accepted_corrected_fluxes():
    invocation, domain, saved, clock, controls = window_fixture(dt=.1, duration=.1, window=.1, interval=.01)
    before = ContentKey.from_parts("checkpoint", saved)
    stepper = ClockStepper(domain.mesh, transported_speed=1., fail_dt_above=.03)
    result, _, diagnostics = await advance_window(invocation, domain, saved, clock, controls, stepper)
    history = history_values(result)
    assert diagnostics["retryCount"] >= 2
    final_flux = domain.mesh.area_vectors[domain.mesh.boundary_interface_indices, 0]
    np.testing.assert_array_equal(history["velocity"], 0.)
    np.testing.assert_allclose(history["boundaryFlux"][1], .4 * final_flux, atol=1e-15)
    np.testing.assert_allclose(history["boundaryFlux"][2], .8 * final_flux, atol=1e-15)
    np.testing.assert_allclose(history["boundaryFlux"][-1], final_flux, atol=1e-15)
    assert history["boundaryFlux"].shape[1] < len(result["faceVolumeFlux"])
    assert ContentKey.from_parts("checkpoint", saved) == before


@pytest.mark.asyncio
async def test_output_interval_change_is_future_only_and_never_subdivides_steps():
    invocation, domain, saved, clock, controls = window_fixture()
    stepper = ClockStepper(domain.mesh)
    first, _, _ = await advance_window(invocation, domain, saved, clock, controls, stepper)
    second, _, _ = await advance_window(invocation, domain, first, {**clock, "outputInterval": .03}, controls, stepper)
    values = history_values(second)
    np.testing.assert_allclose(values["times"], [0., .07, .14, .21, .24, .27, .30, .33, .36, .39, .4])
    np.testing.assert_allclose(values["pressure"][:, 0], values["times"], atol=1e-15)
    assert len(stepper.calls) == 4
    assert np.all(np.diff(values["times"]) > 0)


@pytest.mark.asyncio
async def test_courant_rejection_restarts_from_same_accepted_fields():
    invocation, domain, saved, clock, controls = window_fixture(dt=.1, duration=.1, window=.1)
    stepper = ClockStepper(domain.mesh, transported_speed=1.)
    before = ContentKey.from_parts("checkpoint", saved)
    result, _, diagnostics = await advance_window(invocation, domain, saved, clock, controls, stepper)
    assert diagnostics["retryCount"] > 0
    first_accepted = next(index for index, call in enumerate(stepper.calls) if call[0] > 0.)
    for previous, following in zip(stepper.calls[:first_accepted], stepper.calls[1:first_accepted]):
        assert following[1] == previous[1] / 2
        for first, second in zip(previous[2:], following[2:], strict=True):
            np.testing.assert_array_equal(first, second)
    assert ContentKey.from_parts("checkpoint", saved) == before
    assert diagnostics["maxCourant"] <= .5
    np.testing.assert_allclose(result["pressure"], .1, atol=1e-15)


@pytest.mark.asyncio
async def test_retry_exhaustion_and_model_errors_leave_input_state_unchanged():
    invocation, domain, saved, clock, controls = window_fixture(dt=.1, duration=.1, window=.1)
    before = ContentKey.from_parts("checkpoint", saved)
    stepper = ClockStepper(domain.mesh, transported_speed=1e10)
    with pytest.raises(CaeError, match="exhausted 12.*position.*mass"):
        await advance_window(invocation, domain, saved, clock, controls, stepper)
    assert len(stepper.calls) == 13
    assert ContentKey.from_parts("checkpoint", saved) == before
    invalid = ClockStepper(domain.mesh, fail=True)
    with pytest.raises(ValueError, match="fixed boundary"):
        await advance_window(invocation, domain, saved, clock, controls, invalid)
    assert len(invalid.calls) == 1
    assert ContentKey.from_parts("checkpoint", saved) == before


@pytest.mark.asyncio
async def test_numerical_failure_retries_without_advancing_pressure_or_history():
    invocation, domain, saved, clock, controls = window_fixture(dt=.1, duration=.1, window=.1, interval=.01)
    before = ContentKey.from_parts("checkpoint", saved)
    stepper = ClockStepper(domain.mesh, fail_dt_above=.03)
    result, _, diagnostics = await advance_window(invocation, domain, saved, clock, controls, stepper)
    assert diagnostics["retryCount"] >= 2
    assert [call[1] for call in stepper.calls[:3]] == [.1, .05, .025]
    assert all(call[0] == 0. for call in stepper.calls[:3])
    for call in stepper.calls[:3]:
        np.testing.assert_array_equal(call[2], saved["pressure"])
        np.testing.assert_array_equal(call[4], saved["faceVolumeFlux"])
    np.testing.assert_allclose(history_values(result)["pressure"][:, 0], history_values(result)["times"], atol=1e-15)
    assert ContentKey.from_parts("checkpoint", saved) == before


@pytest.mark.asyncio
async def test_failure_after_accepted_local_step_discards_entire_window():
    invocation, domain, saved, clock, controls = window_fixture(dt=.1, duration=.2, window=.2, interval=.01)
    before = ContentKey.from_parts("checkpoint", saved)
    stepper = ClockStepper(domain.mesh)

    async def fail_after_first_step(event):
        if event["stage"] == "flow-time":
            stepper.fail_dt_above = 0.

    invocation.progress = fail_after_first_step
    with pytest.raises(CaeError, match="exhausted 12.*0.1 s.*momentum=1"):
        await advance_window(invocation, domain, saved, clock, controls, stepper)
    assert len(stepper.calls) == 14
    assert stepper.calls[0][0] == 0.
    assert all(call[0] == .1 for call in stepper.calls[1:])
    assert ContentKey.from_parts("checkpoint", saved) == before
    np.testing.assert_array_equal(history_values(saved)["times"], [0.])


@pytest.mark.asyncio
async def test_cancellation_after_accepted_step_does_not_retry_or_commit():
    invocation, domain, saved, clock, controls = window_fixture()
    before = ContentKey.from_parts("checkpoint", saved)
    stepper = ClockStepper(domain.mesh)
    invocation.cancellation = SimpleNamespace(raise_if_cancelled=Mock())

    async def cancel_after_first_step(event):
        if event["stage"] == "flow-time":
            invocation.cancellation.raise_if_cancelled.side_effect = asyncio.CancelledError
        else:
            pytest.fail("cancellation must never enter timestep retry")

    invocation.progress = cancel_after_first_step
    with pytest.raises(asyncio.CancelledError):
        await advance_window(invocation, domain, saved, clock, controls, stepper)
    assert len(stepper.calls) == 1
    assert ContentKey.from_parts("checkpoint", saved) == before


@pytest.mark.asyncio
async def test_short_window_keeps_growth_proposal_and_has_actual_endpoint():
    invocation, domain, saved, clock, controls = window_fixture(dt=.1, duration=.12, window=.03, interval=1.)
    stepper = ClockStepper(domain.mesh)
    result, _, _ = await advance_window(invocation, domain, saved, clock, controls, stepper)
    assert result["time"] == .03 and result["nextDt"] == .1
    np.testing.assert_allclose(history_values(result)["times"], [0., .03])
    for _ in range(3):
        result, _, _ = await advance_window(invocation, domain, result, clock, controls, stepper)
    assert result["time"] == .12
    with pytest.raises(ValueError, match="already reached"):
        await advance_window(invocation, domain, result, clock, controls, stepper)


@pytest.mark.asyncio
@pytest.mark.parametrize("window", [.08, .03])
async def test_partial_window_steps_retain_first_order_temporal_convergence(window):
    mesh = tetrahedral_box((4, 2, 2), (2., 1., 1.))
    velocity, pressure, _, _ = pressure_duct_boundaries(mesh)
    domain = FlowDomain(mesh, 1., 1., np.zeros(3), velocity, pressure, "partial-window",
                        {"boundaryFaces": mesh.faces[mesh.boundary_face_map]})
    solver = PreparedTransientFlow(mesh, 1., 1., np.zeros(3), velocity, pressure)
    initial = await solver.initialize()
    invocation = SimpleNamespace(cancellation=None, progress=None)
    controls = {"maxIterations": 1000, "maxNonlinearIterations": 30, "tolerance": 1e-10, "maxCourant": .5}

    async def solve(dt, window_size):
        clock = {"dt": dt, "duration": .08, "windowSize": window_size, "outputInterval": .021}
        state = initial_state(domain, initial, clock)
        while state["time"] < clock["duration"]:
            state, _, _ = await advance_window(invocation, domain, state, clock, controls, solver)
        return state

    reference = await solve(.00125, .08)
    solutions = [await solve(dt, window) for dt in (.02, .01, .005)]
    errors = [np.linalg.norm(state["velocity"] - reference["velocity"]) for state in solutions]
    assert all(1.6 < earlier / later < 2.5 for earlier, later in zip(errors, errors[1:]))
