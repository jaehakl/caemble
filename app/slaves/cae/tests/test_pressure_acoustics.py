"""Analytical propagation, reflection, power and mesh/frequency convergence."""

from itertools import permutations, product

import numpy as np
import pytest
from scipy import sparse

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue
from app.methods.fields.box_grid import TetrahedralSampler
from app.solvers.pressure_acoustics.harmonic_fem.boundaries import boundary_mass, prepare_boundaries, surface_motion_load
from app.solvers.pressure_acoustics.harmonic_fem.formulation import prepare_operators
from app.solvers.pressure_acoustics.harmonic_fem.harmonic import solve_harmonic
from app.solvers.pressure_acoustics.harmonic_fem.model import AcousticBoundaries, AcousticModel, AcousticOperators


def tube(divisions):
    nx, ny, nz = divisions
    shape = np.array(divisions) + 1
    points = np.asarray(list(product(np.linspace(0, .5, nx + 1), np.linspace(0, .1, ny + 1), np.linspace(0, .1, nz + 1))))
    cells = []
    for cube in product(range(nx), range(ny), range(nz)):
        for axes in permutations(range(3)):
            coordinates = [np.array(cube)]
            for axis in axes:
                coordinates.append(coordinates[-1] + np.eye(3, dtype=int)[axis])
            cell = np.ravel_multi_index(np.asarray(coordinates).T, shape)
            if np.linalg.det((points[cell[1:]] - points[cell[0]]).T) < 0:
                cell[[1, 2]] = cell[[2, 1]]
            cells.append(cell)
    cells = np.asarray(cells)
    occurrences = {}
    for cell in cells:
        for opposite in range(4):
            face = np.delete(cell, opposite)
            vertices = points[face]
            if np.cross(vertices[1] - vertices[0], vertices[2] - vertices[0]) @ (points[cell[opposite]] - vertices[0]) > 0:
                face[[1, 2]] = face[[2, 1]]
            key = tuple(sorted(face))
            occurrences[key] = None if key in occurrences else face
    faces = np.asarray([face for face in occurrences.values() if face is not None])
    regions = {
        "inlet": {"faces": faces[np.all(points[faces, 0] == 0, axis=1)]},
        "outlet": {"faces": faces[np.all(points[faces, 0] == .5, axis=1)]},
    }
    return AcousticModel(points, cells, regions, 1.2, 343.)


def driven_boundaries(model, frequencies, resistance=None):
    return prepare_boundaries(model, [
        {"methodId": "acoustics.normal-velocity", "target": ["inlet"], "parameters": {"amplitude": 1., "phase": np.pi}},
        {"methodId": "acoustics.impedance", "target": ["outlet"], "parameters": {"resistance": resistance or model.density * model.sound_speed}},
    ], frequencies)


@pytest.fixture(scope="module")
def fine_tube():
    # The high-reflection case needs finer resolution than the matched tube.
    model = tube((50, 10, 10))
    return model, prepare_operators(model)


@pytest.mark.asyncio
async def test_three_mesh_levels_resolve_complex_pressure_and_positive_power(fine_tube):
    frequencies = np.array([100., 250., 400.])
    probes = np.column_stack((np.linspace(.0125, .4875, 39), np.full(39, .05), np.full(39, .05)))
    errors = []
    for model, operators in [(model, prepare_operators(model)) for model in (tube((10, 2, 2)), tube((20, 4, 4)))] + [fine_tube]:
        solution = await solve_harmonic(operators, driven_boundaries(model, frequencies), frequencies)
        pressure = TetrahedralSampler.prepare(model.points, model.cells, probes).sample(solution.pressure)
        expected = model.density * model.sound_speed * np.exp(-1j * 2 * np.pi * probes[:, :1] * frequencies / model.sound_speed)
        errors.append(float(np.max(np.abs(pressure - expected) / np.abs(expected))))
        assert np.all(solution.input_power > 0)
        assert np.all(solution.output_power > 0)
        np.testing.assert_allclose(solution.input_power, solution.output_power, rtol=.01)
        assert solution.relative_residuals.max() < 1e-8
    assert errors[2] < errors[1] < errors[0]
    assert errors[-1] <= .01, errors
    # This analytic power comparison is independent of the discrete balance.
    np.testing.assert_allclose(solution.output_power, .5 * model.density * model.sound_speed * .1**2, rtol=.01)


@pytest.mark.asyncio
async def test_three_frequency_levels_converge_between_samples(fine_tube):
    model, operators = fine_tube
    dense = np.linspace(100., 400., 129)
    probe = np.array([[.475, .05, .05]])
    expected = model.density * model.sound_speed * np.exp(-1j * 2 * np.pi * .475 * dense / model.sound_speed)
    sampler = TetrahedralSampler.prepare(model.points, model.cells, probe)
    errors = []
    for count in (5, 9, 17):
        frequencies = np.linspace(100., 400., count)
        solution = await solve_harmonic(operators, driven_boundaries(model, frequencies), frequencies)
        pressure = sampler.sample(solution.pressure)[0]
        interpolated = np.interp(dense, frequencies, pressure.real) + 1j * np.interp(dense, frequencies, pressure.imag)
        errors.append(float(np.max(abs(interpolated - expected) / abs(expected))))
    assert errors[2] < errors[1] < errors[0]
    assert errors[-1] <= .01, errors


@pytest.mark.asyncio
async def test_resistive_reflections_near_resonance_preserve_amplitude_and_phase(fine_tube):
    model, operators = fine_tube
    frequencies = np.array([320., 335., 342., 343., 344., 351., 365.])
    impedance = model.density * model.sound_speed
    solution = await solve_harmonic(operators, driven_boundaries(model, frequencies, 9 * impedance), frequencies)
    probes = np.array([[.025, .05, .05], [.225, .05, .05], [.475, .05, .05]])
    pressure = TetrahedralSampler.prepare(model.points, model.cells, probes).sample(solution.pressure)
    k = 2 * np.pi * frequencies / model.sound_speed
    reflection = .8 * np.exp(-2j * k * .5)
    expected = impedance * (np.exp(-1j * probes[:, :1] * k) + reflection * np.exp(1j * probes[:, :1] * k)) / (1 - reflection)
    # Normalize by the incident wave amplitude; nodes of standing waves do not divide by zero.
    assert np.max(abs(pressure - expected) / abs(impedance / (1 - reflection))) <= .01
    np.testing.assert_allclose(solution.input_power, solution.output_power, rtol=.01)


@pytest.mark.asyncio
async def test_singular_resonance_and_bad_frequency_do_not_add_hidden_damping():
    operators = AcousticOperators(sparse.eye(1, format="csr") * (2 * np.pi)**2, sparse.eye(1, format="csr"))
    boundaries = AcousticBoundaries(sparse.csr_matrix((1, 1)), np.ones((1, 1)))
    with pytest.raises(ValueError, match="1 Hz.*singular"):
        await solve_harmonic(operators, boundaries, [1.])
    for frequencies in ([0.], [-1.], [np.nan], [2., 1.], [1., 1.]):
        with pytest.raises(ValueError, match="positive and strictly increasing"):
            await solve_harmonic(operators, boundaries, frequencies)


def motion_bundle(model, frequencies):
    faces = model.boundary_regions["inlet"]["faces"]
    nodes, compact = np.unique(faces, return_inverse=True)
    points = model.points[nodes]
    domain = UnstructuredMeshValue(points, {"tri3": compact.reshape(-1, 3)[:, ::-1]}, "m", "independent-structure-surface")
    values = np.zeros((len(nodes), len(frequencies), 3), dtype=np.complex64)
    values[:, :, 0] = 1
    velocity = FieldValue(domain, "node", "kinematics.Velocity", "m.s-1", values, np.eye(3), ("x", "y", "z"),
                          {"sampleAxes": [{"axis": 1, "name": "frequency", "unit": "Hz", "ticks": np.asarray(frequencies)}]})
    return BundleValue("caemble.mechanics/harmonic-surface-motion@1", {
        "velocity": velocity, "frequencies": {"value": np.asarray(frequencies)},
    }, {"timeConvention": "exp(+i*omega*t)", "amplitude": "peak", "configuration": "reference"})


def test_native_motion_accepts_independent_mesh_identity_and_rejects_wrong_frequencies():
    source, target = tube((4, 2, 2)), tube((6, 3, 3))
    frequencies = np.array([100., 200.])
    bundle = motion_bundle(source, frequencies)
    faces = target.boundary_regions["inlet"]["faces"]
    load = surface_motion_load(bundle, target, faces, frequencies)
    expected = -(boundary_mass(target.points, faces) @ np.ones(len(target.points)))
    np.testing.assert_allclose(load, np.broadcast_to(expected[:, None], load.shape), atol=1e-14)
    with pytest.raises(ValueError, match="frequency coordinates"):
        surface_motion_load(bundle, target, faces, np.array([100., 201.]))
    wrong_phase = BundleValue(bundle.bundle_type, bundle.members, {**bundle.metadata, "timeConvention": "exp(-i*omega*t)"})
    with pytest.raises(ValueError, match="timeConvention"):
        surface_motion_load(wrong_phase, target, faces, frequencies)


def test_boundary_conflicts_and_nonpassive_resistance_are_rejected():
    model = tube((2, 1, 1))
    velocity = {"methodId": "acoustics.normal-velocity", "target": ["inlet"], "parameters": {"amplitude": 1., "phase": 0.}}
    with pytest.raises(ValueError, match="cannot overlap"):
        prepare_boundaries(model, [velocity, velocity], [100.])
    for resistance in (0., -1., np.inf):
        with pytest.raises(ValueError, match="finite and positive"):
            prepare_boundaries(model, [{"methodId": "acoustics.impedance", "target": ["outlet"], "parameters": {"resistance": resistance}}], [100.])


@pytest.mark.asyncio
async def test_frequency_sweep_reports_progress_and_cooperatively_cancels():
    class Cancellation:
        cancelled = False

        def raise_if_cancelled(self):
            if self.cancelled:
                raise RuntimeError("cancelled between frequencies")

    cancellation = Cancellation()
    updates = []

    async def progress(update):
        updates.append(update)
        cancellation.cancelled = True

    operators = AcousticOperators(sparse.eye(1, format="csr"), sparse.eye(1, format="csr"))
    boundaries = AcousticBoundaries(sparse.eye(1, format="csr"), np.ones((1, 2)))
    with pytest.raises(RuntimeError, match="cancelled between frequencies"):
        await solve_harmonic(operators, boundaries, [1., 2.], cancellation, progress)
    assert updates == [{"stage": "acoustic-frequency-response", "completed": 1, "total": 2}]


def test_surface_input_port_and_boundary_must_be_connected_together():
    model = tube((2, 1, 1))
    rule = {"methodId": "acoustics.surface-motion", "target": ["inlet"], "parameters": {}}
    with pytest.raises(ValueError, match="connected surfaceMotion input"):
        prepare_boundaries(model, [rule], [100.])
    with pytest.raises(ValueError, match="requires an acoustics.surface-motion boundary"):
        prepare_boundaries(model, [], [100.], motion_bundle(model, [100.]))


@pytest.mark.parametrize("method", ["acoustics.normal-velocity", "acoustics.impedance", "acoustics.surface-motion"])
def test_boundary_rule_unions_semantic_groups_without_double_counting(method):
    model = tube((4, 2, 2))
    faces = model.boundary_regions["inlet"]["faces"]
    model.boundary_regions["inlet-a"] = {"faces": faces[:5]}
    model.boundary_regions["inlet-b"] = {"faces": faces[3:]}
    parameters = {"amplitude": 1., "phase": .3} if method.endswith("normal-velocity") else {"resistance": 411.6} if method.endswith("impedance") else {}
    bundle = motion_bundle(model, [100.]) if method.endswith("surface-motion") else None
    whole = {"methodId": method, "target": ["inlet"], "parameters": parameters}
    union = {**whole, "target": ["inlet-a", "inlet-b", "inlet-a"]}
    expected = prepare_boundaries(model, [whole], [100.], bundle)
    actual = prepare_boundaries(model, [union], [100.], bundle)
    np.testing.assert_allclose(actual.normal_load, expected.normal_load, atol=1e-15)
    np.testing.assert_allclose(actual.impedance.toarray(), expected.impedance.toarray(), atol=1e-15)
    with pytest.raises(ValueError, match="cannot overlap"):
        prepare_boundaries(model, [union, whole], [100.], bundle)
