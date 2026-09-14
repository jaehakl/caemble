"""Acoustic staggered timing, passive boundaries and native surface contracts."""

from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest
from scipy.integrate import quad

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue
from app.methods.geometry.service import GeometryService
from app.solvers.pressure_acoustics.transient_fdtd.domain import CartesianAcousticGrid, build_grid
from app.solvers.pressure_acoustics.transient_fdtd.run import restart_identity, run_transient, time_settings
from app.solvers.pressure_acoustics.transient_fdtd.sources import (
    AcousticFaceRule, prepare_face_rules, prepare_surface_motion, prescribed_velocities, tone_burst_average,
)
from app.solvers.pressure_acoustics.transient_fdtd.stepping import advance_step, discrete_energy, initial_fields


def grid(shape=(8, 3, 2)):
    return CartesianAcousticGrid(np.zeros(3), np.array([.5, .1, .1]), shape, 1.2, 343.,
                                {"inlet": {(0, 0)}, "outlet": {(0, 1)}})


@pytest.mark.parametrize("frequency", [125., 250., 1000.])
def test_tone_burst_exact_step_average_and_support(frequency):
    parameters = {"amplitude": -.002, "frequency": frequency, "startTime": .001, "duration": .008}
    for start, end in ((0., .0009), (.0009, .0018), (.0023, .0051), (.0087, .010), (.01, .02)):
        def waveform(time):
            s = time - parameters["startTime"]
            return parameters["amplitude"] * np.sin(np.pi * s / .008)**2 * np.sin(2 * np.pi * frequency * s) if 0 < s < .008 else 0.
        expected = quad(waveform, start, end, points=[t for t in (.001, .009) if start < t < end], epsabs=1e-16)[0]
        assert tone_burst_average(parameters, start, end) * (end - start) == pytest.approx(expected, abs=2e-18)
    assert tone_burst_average(parameters, 0., .001) == 0.
    assert tone_burst_average(parameters, .009, .01) == 0.


def test_direct_velocity_first_step_uses_interval_average_and_fluid_outward_sign():
    model = grid((5, 1, 1))
    parameters = {"amplitude": -.002, "frequency": 250., "startTime": 0., "duration": .008}
    rule = AcousticFaceRule(0, 0, "acoustics.tone-burst-velocity", parameters)
    pressure, velocity = initial_fields(model)
    dt = 1e-5
    source = prescribed_velocities([rule], None, model, 0., dt)
    result = advance_step(model, pressure, velocity, [rule], dt, source)
    expected = -model.density * model.sound_speed**2 * dt * source[(0, 0)] / model.spacing[0]
    assert result[0, 0, 0] == pytest.approx(expected)
    assert result[0, 0, 0] > 0
    np.testing.assert_array_equal(result[1:], 0.)
    np.testing.assert_array_equal(pressure, 0.)


@pytest.mark.parametrize("ratio", [None, .01, 1., 100.])
def test_three_dimensional_energy_balance_including_impedance_edges_and_corners(ratio):
    model = grid((6, 4, 3))
    dt = .9 / (model.sound_speed * np.linalg.norm(1 / model.spacing))
    rules = [] if ratio is None else [AcousticFaceRule(axis, side, "acoustics.impedance",
        {"resistance": ratio * model.density * model.sound_speed}) for axis in range(3) for side in range(2)]
    rng = np.random.default_rng(93)
    pressure, velocities = initial_fields(model)
    pressure[:] = rng.normal(size=pressure.shape)
    for axis, velocity in enumerate(velocities):
        interior = [slice(None)] * 3
        interior[axis] = slice(1, -1)
        velocity[tuple(interior)] = rng.normal(size=velocity[tuple(interior)].shape) / (model.density * model.sound_speed)
    previous_pressure = pressure.copy()
    for axis, velocity in enumerate(velocities):
        previous_pressure += model.density * model.sound_speed**2 * dt * np.diff(velocity, axis=axis) / model.spacing[axis]
    initial_energy = energy = discrete_energy(model, previous_pressure, pressure, velocities, rules)
    cumulative_loss = 0.
    for _ in range(500):
        old_velocity = [v.copy() for v in velocities]
        next_pressure = advance_step(model, pressure, velocities, rules, dt, {})
        next_energy = discrete_energy(model, pressure, next_pressure, velocities, rules)
        loss = 0.
        for rule in rules:
            index = [slice(None)] * 3
            index[rule.axis] = 0 if rule.side == 0 else -1
            mean = (old_velocity[rule.axis][tuple(index)] + velocities[rule.axis][tuple(index)]) / 2
            loss += dt * rule.parameters["resistance"] * np.prod(np.delete(model.spacing, rule.axis)) * np.sum(mean**2)
        assert abs(next_energy - energy + loss) <= initial_energy * 2e-14
        assert next_energy >= 0.
        cumulative_loss += loss
        pressure, energy = next_pressure, next_energy
    assert abs(energy + cumulative_loss - initial_energy) <= initial_energy * 5e-13
    if ratio is None:
        assert energy == pytest.approx(initial_energy, rel=5e-13)
    else:
        assert energy < initial_energy


def test_prescribed_flux_energy_work_and_passive_decay_after_source_ends():
    model = grid((10, 1, 1))
    dt = 2**-16
    source = AcousticFaceRule(0, 0, "acoustics.tone-burst-velocity",
        {"amplitude": -.001, "frequency": 250., "startTime": 0., "duration": .004})
    terminal = AcousticFaceRule(0, 1, "acoustics.impedance", {"resistance": model.density * model.sound_speed})
    rules = [source, terminal]
    pressure, velocities = initial_fields(model)
    energy = work = loss = 0.
    peak = 0.
    for step in range(2048):
        old_left, old_right = velocities[0][0].copy(), velocities[0][-1].copy()
        flux = prescribed_velocities(rules, None, model, step * dt, (step + 1) * dt)
        next_pressure = advance_step(model, pressure, velocities, rules, dt, flux)
        next_energy = discrete_energy(model, pressure, next_pressure, velocities, rules)
        area = model.spacing[1] * model.spacing[2]
        added_work = dt * area * np.sum(pressure[0] * (old_left + velocities[0][0]) / 2)
        added_loss = dt * terminal.parameters["resistance"] * area * np.sum(((old_right + velocities[0][-1]) / 2)**2)
        peak = max(peak, next_energy)
        assert abs(next_energy - energy - added_work + added_loss) <= max(peak, 1e-30) * 2e-13
        if step * dt > .004:
            assert next_energy <= energy + peak * 1e-14
        work += added_work
        loss += added_loss
        pressure, energy = next_pressure, next_energy
    assert abs(energy + loss - work) <= peak * 1e-12
    assert energy < peak * 1e-4


def test_first_resistive_reflection_has_correct_delay_sign_and_point_eight_ratio(record_property):
    # A pulse shorter than the round-trip separates incident and first reflected
    # arrivals. Stop before the inlet can send a second reflection to the probe.
    model = grid((500, 1, 1))
    dt, probe, duration = 2e-6, .25, .0005
    characteristic = model.density * model.sound_speed
    source = AcousticFaceRule(0, 0, "acoustics.tone-burst-velocity",
        {"amplitude": -.001, "frequency": 2000., "startTime": 0., "duration": duration})
    terminal = AcousticFaceRule(0, 1, "acoustics.impedance", {"resistance": 9 * characteristic})
    rules = [source, terminal]
    pressure, velocities = initial_fields(model)
    times = np.arange(1501) * dt
    samples = np.zeros(len(times))
    centers = model.axes[0]
    for step, (start, end) in enumerate(zip(times[:-1], times[1:]), start=1):
        flux = prescribed_velocities(rules, None, model, start, end)
        pressure = advance_step(model, pressure, velocities, rules, dt, flux)
        samples[step] = np.interp(probe, centers, pressure[:, 0, 0])
    incident_delay = probe / model.sound_speed
    reflected_delay = (2 * model.size[0] - probe) / model.sound_speed
    second_return = (2 * model.size[0] + probe) / model.sound_speed
    assert times[-1] < second_return
    incident, reflected = [], []
    for delay in (incident_delay, reflected_delay):
        shifted = times - delay
        # Independent continuous pulse expression; no FDTD helper defines the
        # expected reflection coefficient or the physical propagation delay.
        expected = np.where((shifted >= 0) & (shifted <= duration),
            characteristic * .001 * np.sin(np.pi * shifted / duration)**2 * np.sin(2 * np.pi * 2000 * shifted), 0.)
        mask = (times >= delay - 10 * dt) & (times <= delay + duration + 10 * dt)
        if delay == incident_delay:
            incident = [samples[mask], expected[mask]]
        else:
            reflected = [samples[mask], expected[mask]]
        peak_time = times[mask][np.argmax(samples[mask])]
        assert abs(peak_time - (delay + duration / 3)) <= 4 * dt
    incident_error = np.linalg.norm(incident[0] - incident[1]) / np.linalg.norm(incident[1])
    reflection = float(reflected[0] @ reflected[1] / (reflected[1] @ reflected[1]))
    reflected_error = np.linalg.norm(reflected[0] - .8 * reflected[1]) / np.linalg.norm(reflected[1])
    assert incident_error < .01
    assert reflection == pytest.approx(.8, abs=.008)
    assert reflected_error < .01
    record_property("first_reflection_incident_normalized_l2", float(reflected_error))
    record_property("measured_first_reflection_coefficient", reflection)


def test_boundary_alias_dedup_and_overlap_rejection():
    model = grid()
    model.boundary_regions["alias"] = {(0, 0)}
    one = {"methodId": "acoustics.impedance", "parameters": {"resistance": 400.}, "target": ["inlet", "alias", "inlet"]}
    assert len(prepare_face_rules(model, [one])) == 1
    with pytest.raises(ValueError, match="cannot overlap"):
        prepare_face_rules(model, [one, one])
    for resistance in (0., -1., np.inf):
        with pytest.raises(ValueError, match="finite and positive"):
            prepare_face_rules(model, [{**one, "parameters": {"resistance": resistance}}])


def motion_bundle(model, times):
    points, quads = model.face_mesh(0, 0)
    faces = np.concatenate((quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]))[:, ::-1]
    values = np.zeros((len(points), len(times), 3))
    values[:, :, 0] = 1 + 2 * np.asarray(times)
    domain = UnstructuredMeshValue(points, {"tri3": faces}, "m", "independent-structure")
    field = FieldValue(domain, "node", "kinematics.Velocity", "m.s-1", values, np.eye(3), ("x", "y", "z"),
        {"configuration": "reference", "sampleAxes": [{"axis": 1, "name": "time", "unit": "s", "ticks": times}]})
    return BundleValue("caemble.mechanics/transient-surface-motion@1",
        {"times": {"value": times, "axes": [{"ticks": times, "unit": "s"}]}, "velocity": field},
        {"configuration": "reference", "frameKind": "solved-window", "couplingConverged": True,
         "timeOrigin": 0., "startTime": times[0], "endTime": times[-1], "sourceModelIdentity": "source-model"})


def test_transient_surface_velocity_matches_exact_window_flux_across_sample_boundaries():
    model = grid((5, 3, 2))
    times = np.array([0., .0003, .0011, .002])
    rule = AcousticFaceRule(0, 0, "acoustics.transient-surface-motion", {})
    motion = prepare_surface_motion(motion_bundle(model, times), model, rule, 0., .002, 1e-15)
    values = prescribed_velocities([rule], motion, model, .0002, .0012)
    np.testing.assert_allclose(values[(0, 0)], -(1 + 2 * .0007), atol=2e-14)
    assert motion[2] == ("source-model", "independent-structure")
    for changes in ({"frameKind": "initial"}, {"couplingConverged": False}, {"configuration": "current"}, {"timeOrigin": 1.}):
        bundle = motion_bundle(model, times)
        with pytest.raises(ValueError):
            prepare_surface_motion(replace(bundle, metadata={**bundle.metadata, **changes}), model, rule, 0., .002, 1e-15)
    with pytest.raises(ValueError, match="without gap or overlap"):
        prepare_surface_motion(motion_bundle(model, times), model, rule, .0001, .002, 1e-15)


def test_time_grid_cfl_and_restart_identity_exclude_window_partition():
    model = grid()
    config = {"initializations": [{"methodId": "acoustics.time", "parameters": {"dt": 1e-5, "totalSteps": 80, "windowSteps": 13}}]}
    assert time_settings(config, model) == (1e-5, 80, 13)
    assert restart_identity(model, 1e-5, 80, [], None) != restart_identity(model, 2e-5, 80, [], None)
    for key, value in (("dt", .1), ("dt", 0), ("totalSteps", 1.5), ("windowSteps", 0)):
        changed = {"initializations": [{"methodId": "acoustics.time", "parameters": {**config["initializations"][0]["parameters"], key: value}}]}
        with pytest.raises(ValueError):
            time_settings(changed, model)


def test_time_refinement_is_second_order_against_the_same_spatial_model(record_property):
    model = grid((20, 2, 2))
    wavenumber = np.pi / model.size[0]
    spatial_frequency = 2 * model.sound_speed / model.spacing[0] * np.sin(wavenumber * model.spacing[0] / 2)
    shape = np.cos(wavenumber * model.axes[0])[:, None, None] * np.ones(model.shape)
    duration = 2**-6
    expected = shape * np.cos(spatial_frequency * duration)
    errors = []
    for dt in (2**-15, 2**-16, 2**-17):
        pressure, velocities = initial_fields(model)
        pressure[:] = shape
        # Zero velocity at t=0 is represented by a backward half kick; using
        # v^(-1/2)=0 for this nonzero initial pressure would insert a time shift.
        velocities[0][1:-1] = dt * np.diff(pressure, axis=0) / (2 * model.density * model.spacing[0])
        for _ in range(round(duration / dt)):
            pressure = advance_step(model, pressure, velocities, [], dt, {})
        errors.append(float(np.linalg.norm(pressure - expected) / np.linalg.norm(shape)))
    assert 3.8 < errors[0] / errors[1] < 4.2, errors
    assert 3.8 < errors[1] / errors[2] < 4.2, errors
    record_property("temporal_semidiscrete_relative_l2", errors)
    record_property("temporal_time_step_seconds", [2**-15, 2**-16, 2**-17])


@pytest.mark.asyncio
async def test_window_partition_and_checkpoint_retry_are_identical(monkeypatch):
    import importlib
    module = importlib.import_module("app.solvers.pressure_acoustics.transient_fdtd.run")
    model = grid((10, 3, 2))
    async def build(_):
        return model
    monkeypatch.setattr(module, "build_grid", build)
    config = {"initializations": [{"methodId": "acoustics.time", "parameters": {"dt": 1e-5, "totalSteps": 127}}],
              "outputs": [], "boundaryConditions": [
                  {"methodId": "acoustics.tone-burst-velocity", "target": ["inlet"], "parameters": {"amplitude": -.001, "frequency": 250., "startTime": 0., "duration": .004}},
                  {"methodId": "acoustics.impedance", "target": ["outlet"], "parameters": {"resistance": 411.6}}]}
    invocation = SimpleNamespace(config=config, task_name="air", state={}, inputs={}, descriptor={"methods": {"outputs": []}}, progress=None, cancellation=None)
    single = await run_transient(invocation)
    expected = single.state_patch.operations[-1].value["restart"]
    config["initializations"][0]["parameters"]["windowSteps"] = 19
    first = await run_transient(invocation)
    checkpoint = first.state_patch.operations[-1].value
    copy = {key: checkpoint["restart"][key].copy() for key in ("pressure", "vx", "vy", "vz")}
    invocation.state = {"pressure_acoustics": {"air": checkpoint}}
    retry_a = await run_transient(invocation)
    retry_b = await run_transient(invocation)
    for key in copy:
        np.testing.assert_array_equal(checkpoint["restart"][key], copy[key])
        np.testing.assert_array_equal(retry_a.state_patch.operations[-1].value["restart"][key], retry_b.state_patch.operations[-1].value["restart"][key])
    while invocation.state["pressure_acoustics"]["air"]["restart"]["step"] < 127:
        result = await run_transient(invocation)
        invocation.state = {"pressure_acoustics": {"air": result.state_patch.operations[-1].value}}
    for key in copy:
        np.testing.assert_array_equal(invocation.state["pressure_acoustics"]["air"]["restart"][key], expected[key])
    invocation.state = {"pressure_acoustics": {"air": checkpoint}}
    config["initializations"][0]["parameters"]["dt"] = 2e-5
    with pytest.raises(ValueError, match="different grid/material/boundary/time/integration"):
        await run_transient(invocation)


@pytest.mark.asyncio
async def test_domain_preserves_exact_transformed_box_and_semantic_faces():
    node = {"kind": "primitive", "primitive": "box", "nodeId": "box", "parameters": {"size": [.51, .11, .09]}}
    matrix = np.eye(4)
    matrix[:3, 3] = [.3, -.2, .1]
    part = {"id": "fluid", "node": {"kind": "transform", "matrix": matrix.ravel().tolist(), "child": node}, "material": {"name": "Air"}}
    scene = {"geometryHash": "fluid-box-test", "lengthUnit": "m", "roots": [part], "geometryGroups": [{"name": "Fluid", "rootIds": ["fluid"]}],
        "surfaceGroups": [{"name": "Inlet", "selectors": [{"rootId": "fluid", "sourceNodeId": "box", "surfaceIndex": 0}]}]}
    world = {"task": scene, "materialSelections": {"fluidDomain": {"Air": {"constitutive": "air"}}},
        "materials": {"task": {"Air": {"models": {"air": {"model": "acoustics.homogeneous-fluid@1", "parameters": {"density": 1.2, "soundSpeed": 343.}}}}}}}
    invocation = SimpleNamespace(world=world, config={"parameters": {"spatialResolution": .02}, "initializations": [{"methodId": "acoustics.fluid", "target": ["task.geometry.Fluid"]}]}, geometry=GeometryService(), progress=None)
    result = await build_grid(invocation)
    np.testing.assert_allclose(result.origin, [.045, -.255, .055], atol=1e-15)
    np.testing.assert_allclose(result.size, [.51, .11, .09], atol=1e-15)
    assert result.shape == (26, 6, 5)
    assert result.boundary_regions["task.surface.Inlet"] == {(0, 0)}
    node["parameters"]["size"] = [.5, .1, .1]
    for offset in (.1, .5, 1., 10.):
        scene["geometryHash"] = f"translated-box-{offset}"
        matrix[:3, 3] = offset
        part["node"]["matrix"] = matrix.ravel().tolist()
        translated = await build_grid(invocation)
        assert translated.shape == (25, 5, 5)
        np.testing.assert_array_equal(translated.size, [.5, .1, .1])
    angle = np.pi / 2
    matrix[:2, :2] = [[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]
    part["node"]["matrix"] = matrix.ravel().tolist()
    scene["geometryHash"] = "axis-permuted-box"
    rotated = await build_grid(invocation)
    assert rotated.shape == (5, 25, 5)
    np.testing.assert_array_equal(rotated.size, [.1, .5, .1])
    assert rotated.boundary_regions["task.surface.Inlet"] == {(1, 0)}
    for angle in (.2, 1e-6):
        matrix[:2, :2] = [[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]
        part["node"]["matrix"] = matrix.ravel().tolist()
        with pytest.raises(ValueError, match="world-axis-aligned"):
            await build_grid(invocation)
    part["node"] = {"kind": "primitive", "primitive": "cylinder"}
    with pytest.raises(ValueError, match="Box primitive"):
        await build_grid(invocation)
