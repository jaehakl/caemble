"""Independent periodic geometry, conservation and driven-channel references."""

from tests.flow_fixtures import closed_boundaries, periodic_box

import numpy as np
import pytest
from scipy import sparse
from types import SimpleNamespace

from app.kernel.coordinator.plan import detached
from app.kernel.coordinator.run import CaeRun
from app.methods.coupling.polygons import polygon_area_centroid
from app.methods.finite_volume.tetrahedral import _gradient_extensions, cell_operators, create_fv_mesh
from app.methods.geometry import GeometryService
from app.solvers.incompressible_flow.domain import build_domain, prepare_boundaries
from app.solvers.incompressible_flow.formulation import solve_stokes
from app.solvers.incompressible_flow.linear import LinearFlowSystem
from app.solvers.incompressible_flow.periodic import apply_periodic, boundary_patches, freeze_periodic, restore_periodic, split_gravity
from app.solvers.incompressible_flow.transient import PreparedTransientFlow


def channel_reference(z, time=None, acceleration=1., viscosity=1., density=1.):
    if time is None:
        return density*acceleration/(2*viscosity)*z*(1-z), density*acceleration/(12*viscosity)
    odd = np.arange(1, 150, 2, dtype=float)
    decay = -np.expm1(-viscosity/density*(np.pi*odd)**2*time)
    coefficient = 4*acceleration*density/(viscosity*np.pi**3*odd**3)*decay
    return np.sin(np.pi*z[:, None]*odd) @ coefficient, float(np.sum(coefficient*2/(np.pi*odd)))


def test_nonmatching_periodic_interfaces_preserve_coverage_moments_and_common_flux():
    base, pairs, mesh = periodic_box()
    assert np.array_equal(mesh.faces, base.faces)
    assert mesh.face_count != len(mesh.faces)
    assert np.any(mesh.gradient_weights[:, 0] != mesh.gradient_weights[:, 1])
    np.testing.assert_allclose(mesh.divergence @ mesh.area_vectors, 0, atol=2e-15)
    patches = boundary_patches(mesh)
    areas = np.zeros(len(mesh.boundary_face_map))
    moments = np.zeros((len(mesh.boundary_face_map), 3))
    for row, boundary in enumerate(patches["boundaryIndices"]):
        polygon = patches["vertices"][patches["offsets"][row]:patches["offsets"][row+1]]
        area, center = polygon_area_centroid(polygon)
        areas[boundary] += area
        moments[boundary] += area*center
    expected_areas = np.linalg.norm(base.area_vectors[base.boundary_face_map], axis=1)
    np.testing.assert_allclose(areas, expected_areas, rtol=2e-13, atol=2e-16)
    np.testing.assert_allclose(moments, expected_areas[:, None]*base.face_centers[base.boundary_face_map], atol=1e-15)
    flux = np.random.default_rng(7).normal(size=mesh.face_count)
    flux[mesh.neighbour < 0] = 0
    assert abs(np.sum(mesh.divergence @ flux)) < 1e-13
    mapped = mesh.boundary_flux_map @ flux
    for pair in pairs:
        source = np.isin(base.boundary_face_map, pair["sourceFaces"])
        target = np.isin(base.boundary_face_map, pair["targetFaces"])
        assert mapped[source].sum() == pytest.approx(-mapped[target].sum(), abs=2e-14)


def test_translated_wls_and_gauss_reproduce_periodic_compatible_affine_fields():
    _, _, mesh = periodic_box()
    operators = cell_operators(mesh, mesh.neighbour < 0)
    gradient = np.array([0., 0., .7])
    values = .3+mesh.cell_centers @ gradient
    boundary = .3+mesh.face_centers @ gradient
    reconstructed = (operators.gradient @ values + operators.gradient_boundary @ boundary).reshape(-1, 3)
    gauss = (operators.gauss_gradient @ values + operators.gauss_gradient_boundary @ boundary).reshape(-1, 3)
    np.testing.assert_allclose(reconstructed, np.broadcast_to(gradient, reconstructed.shape), atol=3e-14)
    np.testing.assert_allclose(gauss, np.broadcast_to(gradient, gauss.shape), atol=4e-14)
    np.testing.assert_allclose(operators.normal_gradient @ values + operators.normal_gradient_boundary @ boundary,
                               mesh.area_vectors @ gradient, atol=3e-15)
    periodic = mesh.interface_neighbour_faces >= 0
    r_owner = mesh.face_centers[periodic] - mesh.cell_centers[mesh.owner[periodic]]
    r_neighbour = (mesh.face_centers[periodic] - mesh.neighbour_shifts[periodic]
                   - mesh.cell_centers[mesh.neighbour[periodic]])
    np.testing.assert_allclose(r_owner-r_neighbour, mesh.cell_deltas[periodic], atol=3e-16)


def test_second_ring_accumulates_translations_across_different_periodic_pairs():
    _, _, mesh = periodic_box((2, 2, 2), axes=(0, 1, 2), nonmatching=False)
    rows, columns, delta, weights = _gradient_extensions(mesh)
    shifts = delta-(mesh.cell_centers[columns]-mesh.cell_centers[rows])
    periods = np.array([2., 1., 1.])
    images = np.rint(shifts/periods)
    np.testing.assert_allclose(shifts, images*periods, atol=2e-16)
    assert np.any(np.count_nonzero(images, axis=1) >= 2)
    assert np.all(weights > 0)


def test_overlap_subdivision_does_not_change_wls_or_integrated_operators():
    base, _, mesh = periodic_box()
    topology = freeze_periodic(mesh)
    face = int(np.flatnonzero(mesh.interface_neighbour_faces >= 0)[0])
    polygons = [mesh.interface_vertices[a:b] for a, b in zip(mesh.interface_offsets[:-1], mesh.interface_offsets[1:])]
    polygon = polygons[face]
    area, center = polygon_area_centroid(polygon)
    children = [np.asarray([center, first, second]) for first, second in zip(polygon, np.roll(polygon, -1, axis=0))]
    children = [child for child in children if polygon_area_centroid(child)[0] > area*1e-14]
    indices = np.r_[np.arange(mesh.face_count), np.full(len(children)-1, face)]
    divided = {key: np.array(value[indices], copy=True) for key, value in topology.items()
               if key not in {"vertices", "offsets", "translations"}}
    child_faces = [face, *range(mesh.face_count, mesh.face_count+len(children)-1)]
    polygons = [*polygons, *children[1:]]
    polygons[face] = children[0]
    for child_face, child in zip(child_faces, children):
        child_area, child_center = polygon_area_centroid(child)
        divided["areaVectors"][child_face] = mesh.area_vectors[face]*child_area/area
        divided["faceCenters"][child_face] = child_center
        divided["gradientWeights"][child_face] = mesh.gradient_weights[face]*child_area/area
    divided.update(vertices=np.concatenate(polygons), offsets=np.r_[0, np.cumsum([len(polygon) for polygon in polygons])],
                   translations=topology["translations"])
    subdivided = restore_periodic(base, divided)
    first = cell_operators(mesh, mesh.neighbour < 0)
    second = cell_operators(subdivided, subdivided.neighbour < 0)
    np.testing.assert_allclose(first.gradient.toarray(), second.gradient.toarray(), atol=2e-14)
    np.testing.assert_allclose(first.gauss_gradient.toarray(), second.gauss_gradient.toarray(), atol=3e-14)
    np.testing.assert_allclose((mesh.divergence @ first.normal_gradient).toarray(),
                               (subdivided.divergence @ second.normal_gradient).toarray(), atol=3e-14)


def test_oblique_translated_planes_preserve_geometric_and_gradient_covariance():
    base, pairs, original = periodic_box()
    rotation, _ = np.linalg.qr(np.array([[1., 2., 3.], [3., 2., 1.], [1., 4., 2.]]))
    moved = create_fv_mesh(base.points @ rotation.T + [1.7, -2.3, .8], base.cells,
                          base.faces[base.boundary_face_map])
    transformed = apply_periodic(moved, [{**pair, "translation": pair["translation"] @ rotation.T} for pair in pairs])
    np.testing.assert_allclose(transformed.area_vectors, original.area_vectors @ rotation.T, atol=4e-15)
    operators = cell_operators(transformed, transformed.neighbour < 0)
    gradient = rotation @ [0., 0., .7]
    values = .3+transformed.cell_centers @ gradient
    boundary = .3+transformed.face_centers @ gradient
    actual = (operators.gradient @ values + operators.gradient_boundary @ boundary).reshape(-1, 3)
    np.testing.assert_allclose(actual, np.broadcast_to(gradient, actual.shape), atol=4e-13)


def test_periodic_pure_inertia_pressure_correction_keeps_the_same_skew_interpolation():
    _, _, mesh = periodic_box()
    velocity, pressure = closed_boundaries(mesh)
    velocity_fixed = mesh.neighbour < 0
    pressure_fixed = np.zeros(mesh.face_count, dtype=bool)
    velocity_operators, pressure_operators = cell_operators(mesh, velocity_fixed), cell_operators(mesh, pressure_fixed)
    density, dt = 1.7, .013
    system = LinearFlowSystem(mesh, velocity_operators, pressure_operators,
        sparse.diags(density*mesh.cell_volumes/dt), np.zeros((len(mesh.cells), 3)), velocity_fixed, pressure_fixed,
        np.nan_to_num(velocity), np.nan_to_num(pressure), reference_speed=1., force_density_scale=1.)
    checkerboard = np.where(np.arange(len(mesh.cells)) % 2, 1., -1.)
    _, flux, _ = system.response(checkerboard)
    np.testing.assert_allclose(flux, -dt/density*(pressure_operators.normal_gradient @ checkerboard),
                               rtol=3e-14, atol=3e-16)


def test_distinct_parallel_pairs_share_one_gravity_direction_without_a_pair_count_limit():
    base, pairs, whole = periodic_box((4, 4, 4), axes=(0,), nonmatching=False)
    pair = pairs[0]
    pieces = []
    for stripe in range(4):
        pieces.append({"translation": pair["translation"], **{
            name: faces[np.floor(base.face_centers[faces, 1] * 4).astype(int) == stripe]
            for name, faces in pair.items() if name != "translation"}})
    split = apply_periodic(base, pieces)
    assert len(split.periodic_vectors) == 4
    hydro, drive = split_gravity(split, [.4, -.2, -9.81])
    np.testing.assert_allclose(hydro, [0., -.2, -9.81], atol=1e-14)
    np.testing.assert_allclose(drive, [.4, 0., 0.], atol=1e-14)
    first = cell_operators(whole, whole.neighbour < 0)
    second = cell_operators(split, split.neighbour < 0)
    np.testing.assert_allclose(first.gradient.toarray(), second.gradient.toarray(), atol=2e-14)
    np.testing.assert_allclose((whole.divergence @ first.normal_gradient).toarray(),
                               (split.divergence @ second.normal_gradient).toarray(), atol=3e-14)


@pytest.mark.parametrize("failure", ["gap", "translation", "duplicate", "other-pair-translation"])
def test_invalid_periodic_coverage_and_pairs_are_rejected(failure):
    base, pairs, _ = periodic_box()
    if failure == "gap":
        pairs[0]["targetFaces"] = pairs[0]["targetFaces"][1:]
    elif failure == "translation":
        pairs[0]["translation"] = pairs[0]["translation"] + [0., .03, 0.]
    elif failure == "duplicate":
        pairs.append(pairs[0])
    else:
        pairs[1]["translation"] = pairs[0]["translation"]
    with pytest.raises(ValueError, match="coverage|overlaps|planes"):
        apply_periodic(base, pairs)


def test_periodic_topology_roundtrip_and_gravity_span_are_exact():
    base, _, mesh = periodic_box()
    restored = restore_periodic(base, freeze_periodic(mesh))
    for name in ("owner", "neighbour", "area_vectors", "cell_deltas", "gradient_weights", "interface_vertices"):
        assert np.array_equal(getattr(restored, name), getattr(mesh, name))
    hydro, drive = split_gravity(mesh, [.4, -.2, -9.81])
    np.testing.assert_allclose(hydro, [0., 0., -9.81], atol=1e-15)
    np.testing.assert_allclose(drive, [.4, -.2, 0.], atol=1e-15)
    rotation, _ = np.linalg.qr(np.array([[1., 2., 3.], [3., 2., 1.], [1., 4., 2.]]))
    topology = freeze_periodic(mesh)
    topology = {**topology, "translations": topology["translations"] @ rotation.T}
    rotated = restore_periodic(base, topology)
    rotated_hydro, rotated_drive = split_gravity(rotated, np.array([.4, -.2, -9.81]) @ rotation.T)
    np.testing.assert_allclose(rotated_hydro, hydro @ rotation.T, atol=4e-15)
    np.testing.assert_allclose(rotated_drive, drive @ rotation.T, atol=4e-15)


@pytest.mark.validation
@pytest.mark.asyncio
async def test_periodic_channel_stokes_converges_without_pressure_jump():
    errors = []
    for resolution in (3, 5, 8):
        _, pairs, mesh = periodic_box((4, 3, resolution))
        velocity, pressure = closed_boundaries(mesh)
        result = await solve_stokes(mesh, 1., 1., [1., 0., -2.], velocity, pressure, tolerance=1e-10)
        exact, exact_flow = channel_reference(mesh.cell_centers[:, 2])
        error = np.sqrt(np.average((result.velocity[:, 0]-exact)**2, weights=mesh.cell_volumes)
                        / np.average(exact**2, weights=mesh.cell_volumes))
        selected = np.isin(mesh.interface_owner_faces, pairs[0]["sourceFaces"])
        flow = -result.face_volume_flux[selected].sum()
        errors.append((error, abs(flow-exact_flow)/exact_flow))
        assert result.mass_residual < 1e-10
        assert np.average(result.pressure, weights=mesh.cell_volumes) == pytest.approx(0., abs=1e-13)
    assert np.all(np.diff(np.asarray(errors), axis=0) < 0)
    assert errors[-1][0] < .035
    assert errors[-1][1] < .04


@pytest.mark.asyncio
async def test_periodic_startup_retains_driving_acceleration_and_hydrostatics():
    _, _, mesh = periodic_box((4, 3, 6))
    velocity, pressure = closed_boundaries(mesh)
    prepared = PreparedTransientFlow(mesh, 1., 1., [1., 0., -2.], velocity, pressure)
    state = await prepared.initialize(tolerance=1e-10)
    assert np.array_equal(state.velocity, np.zeros_like(state.velocity))
    assert np.array_equal(state.face_volume_flux, np.zeros_like(state.face_volume_flux))
    center = np.average(mesh.cell_centers, axis=0, weights=mesh.cell_volumes)
    np.testing.assert_allclose(state.pressure, -2*(mesh.cell_centers[:, 2]-center[2]), atol=3e-14)
    for index in range(20):
        state = await prepared.step(pressure=state.pressure, velocity=state.velocity,
            face_volume_flux=state.face_volume_flux, dt=.002, time=.002*index, tolerance=1e-10)
    exact, _ = channel_reference(mesh.cell_centers[:, 2], .04)
    error = np.sqrt(np.average((state.velocity[:, 0]-exact)**2, weights=mesh.cell_volumes)
                    / np.average(exact**2, weights=mesh.cell_volumes))
    assert error < .06
    assert state.momentum_residual < 1e-10


@pytest.mark.asyncio
async def test_periodic_startup_is_first_order_in_time():
    _, _, mesh = periodic_box((4, 3, 5))
    velocity, pressure = closed_boundaries(mesh)
    prepared = PreparedTransientFlow(mesh, 1., 1., [1., 0., 0.], velocity, pressure)
    initial = await prepared.initialize(tolerance=1e-10)
    results = []
    for count in (5, 10, 20):
        state, dt = initial, .04/count
        for index in range(count):
            state = await prepared.step(pressure=state.pressure, velocity=state.velocity,
                face_volume_flux=state.face_volume_flux, dt=dt, time=index*dt, tolerance=1e-10)
        results.append(state)
    first = np.linalg.norm(results[0].velocity-results[1].velocity)
    second = np.linalg.norm(results[1].velocity-results[2].velocity)
    assert 1.6 < first/second < 2.4


@pytest.mark.asyncio
async def test_actual_csg_nonmatching_periodic_startup_matches_channel_series(catalog_builds):
    run = CaeRun(measurement=catalog_builds["incompressible-startup-channel"], max_run_seconds=180,
                 job_id="periodic-csg-physics")
    try:
        spec = run.plan.task_specs["flow"]
        invocation = SimpleNamespace(config=detached(spec.task["config"]), world=run.plan.world(spec),
                                     geometry=GeometryService(), progress=None, cancellation=None)
        domain = await build_domain(invocation)
        base, pairs = domain.mesh, []
        for axis in (0, 1):
            lower, upper = base.points[:, axis].min(), base.points[:, axis].max()
            exterior = base.neighbour < 0
            source = np.flatnonzero(exterior & np.isclose(base.face_centers[:, axis], lower))
            target = np.flatnonzero(exterior & np.isclose(base.face_centers[:, axis], upper))
            translation = np.zeros(3)
            translation[axis] = upper-lower
            pairs.append({"sourceFaces": source, "targetFaces": target, "translation": translation})
        mesh = apply_periodic(base, pairs)
        assert mesh.maximum_nonorthogonality > 60
        assert np.any(np.abs(mesh.gradient_weights[:, 0]-mesh.gradient_weights[:, 1]) > .01)
        velocity, pressure = closed_boundaries(mesh)
        acceleration = .0025
        prepared = PreparedTransientFlow(mesh, domain.density, domain.viscosity, [acceleration, 0., 0.], velocity, pressure)
        state = await prepared.initialize()
        for index in range(10):
            state = await prepared.step(pressure=state.pressure, velocity=state.velocity,
                face_volume_flux=state.face_volume_flux, dt=.001, time=.001*index)
        height = float(np.ptp(mesh.points[:, 2]))
        width = float(np.ptp(mesh.points[:, 1]))
        viscosity = domain.viscosity/domain.density
        z = (mesh.cell_centers[:, 2]-mesh.points[:, 2].min())/height
        exact, flow = channel_reference(z, viscosity*.01/height**2)
        scale = acceleration*height**2/viscosity
        exact, flow = exact*scale, flow*scale*height*width
        error = np.sqrt(np.average((state.velocity[:, 0]-exact)**2, weights=mesh.cell_volumes)
                        / np.average(exact**2, weights=mesh.cell_volumes))
        selected = np.isin(mesh.interface_owner_faces, pairs[0]["sourceFaces"])
        actual_flow = -state.face_volume_flux[selected].sum()
        assert error < .05
        assert abs(actual_flow-flow)/flow < .05
        assert state.mass_residual < 1e-8
        assert state.momentum_residual < 1e-8
        assert np.average(state.pressure, weights=mesh.cell_volumes) == pytest.approx(0., abs=1e-12)
    finally:
        await run.close()


@pytest.mark.asyncio
async def test_fully_periodic_transient_accelerates_uniformly_but_steady_requires_anchor():
    base, pairs, mesh = periodic_box((3, 3, 3), axes=(0, 1, 2))
    velocity, pressure = closed_boundaries(mesh)
    gravity = np.array([.2, -.3, .4])
    prepared = PreparedTransientFlow(mesh, 2., 1., gravity, velocity, pressure)
    state = await prepared.initialize(tolerance=1e-10)
    for index in range(3):
        state = await prepared.step(pressure=state.pressure, velocity=state.velocity,
            face_volume_flux=state.face_volume_flux, dt=.01, time=.01*index, tolerance=1e-10)
    np.testing.assert_allclose(state.velocity, np.broadcast_to(.03*gravity, state.velocity.shape), atol=2e-12)
    np.testing.assert_allclose(state.face_volume_flux, mesh.area_vectors @ (.03*gravity), atol=2e-13)
    np.testing.assert_allclose(state.pressure, 0., atol=2e-11)
    with pytest.raises(ValueError, match="mean velocity"):
        await solve_stokes(mesh, 2., 1., gravity, velocity, pressure)
    regions, rules = {}, []
    for index, pair in enumerate(pairs):
        regions[f"a{index}"], regions[f"b{index}"] = pair["sourceFaces"], pair["targetFaces"]
        rules.append({"methodId": "flow.periodic", "target": [f"a{index}", f"b{index}"],
                      "parameters": {"translation": pair["translation"]}})
    prepare_boundaries(base, regions, rules, "transient-navier-stokes")
    with pytest.raises(ValueError, match="velocity"):
        prepare_boundaries(base, regions, rules, "steady-stokes")
