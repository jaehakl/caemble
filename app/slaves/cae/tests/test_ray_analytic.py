"""Small numerical contracts for the continuous ray path (no product entry)."""

from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from app.methods.geometry import GeometryService
from app.methods.geometry.analytic import AnalyticSolid, SurfaceRef
from app.methods.geometry.extrema import solid_bounds
from app.methods.geometry.fiber import evaluate_fiber
from app.methods.rays.analytic import AnalyticScene
from app.methods.rays.roots import UnresolvedIntersection, isolate_roots
from app.methods.rays.sampling import AnalyticSurfaceSampler
from app.solvers.ray_tracing.domain import build_collision_scene
from app.solvers.ray_tracing.formulation import Ray, _trace_one, launch_sources
from app.solvers.ray_tracing.outputs import PathCollector


def primitive(kind, **parameters):
    return dict(kind="primitive", nodeId=kind, primitive=kind, parameters=parameters)


def solid(node, scale=1):
    return AnalyticSolid(
        dict(id="solid", node=node, material=dict(name="Glass")), scale
    )


def events(node, origin, direction):
    result = AnalyticScene([solid(node)]).intersections(
        np.array(origin, float), np.array(direction, float)
    )
    assert result.status != "unresolved", result.diagnostic
    return result.events


@pytest.mark.parametrize(
    "node,origin,direction,distances",
    [
        (primitive("box", size=[2, 2, 2]), [-3, 0, 0], [1, 0, 0], [2, 4]),
        (primitive("sphere", radius=1), [-3, 0, 0], [1, 0, 0], [2, 4]),
        (
            primitive("cylinder", radius=1, radius_2=0.5, height=2),
            [-3, 0, 0],
            [1, 0, 0],
            [2.25, 3.75],
        ),
        (
            primitive("cylinder", radius=1, radius_2=0.5, height=2),
            [0, 0, -3],
            [0, 0, 1],
            [2, 4],
        ),
        (
            primitive("ellipsoid", axialRadius=2, focalDistance=1),
            [0, 0, -3],
            [0, 0, 1],
            [1, 5],
        ),
        (
            primitive("paraboloid", focalLength=1, radius=2),
            [0, 0, -3],
            [0, 0, 1],
            [3, 4],
        ),
        (
            primitive("hyperboloid", axialRadius=1, focalDistance=2, radius=3),
            [0, 0, -3],
            [0, 0, 1],
            [4, 5],
        ),
    ],
)
def test_exact_primitive_events(node, origin, direction, distances):
    hits = events(node, origin, direction)
    np.testing.assert_allclose(
        [h.distance for h in hits], distances, rtol=1e-12, atol=1e-12
    )
    assert [h.crossing_kind for h in hits] == ["enter", "exit"]
    for hit in hits:
        assert np.linalg.norm(hit.normal) == pytest.approx(1)
        np.testing.assert_allclose(
            hit.position, np.array(origin) + hit.distance * np.array(direction)
        )


def asphere():
    return primitive(
        "asphericCylinder",
        radius=1,
        centerThickness=1,
        bottom=dict(curvature=0, conic=0, coefficients=[]),
        top=dict(curvature=0.2, conic=-1, coefficients=[dict(order=4, value=0.05)]),
    )


def curved():
    return primitive(
        "curvedEdgeCylinder",
        height=2,
        verticalCurve=dict(origin=0, coefficients=[1, 0.1, 0.2]),
        azimuthalCurve=[
            dict(amplitude=1, phase=0),
            dict(amplitude=0.1, phase=0.3),
            dict(amplitude=0.05, phase=0.1),
        ],
    )


@pytest.mark.parametrize("node", [asphere(), curved()])
def test_nonlinear_intersections_match_surface_and_independent_differential(node):
    body = solid(node)
    patch = next(
        p
        for p in body.patches
        if p.surface_index == (2 if node["primitive"] == "asphericCylinder" else 1)
    )
    point, normal, du, dv = patch.evaluate(0.37, 0.71)
    delta = 1e-5
    finite_u = (
        patch.evaluate(0.37 + delta, 0.71)[0] - patch.evaluate(0.37 - delta, 0.71)[0]
    ) / (2 * delta)
    finite_v = (
        patch.evaluate(0.37, 0.71 + delta)[0] - patch.evaluate(0.37, 0.71 - delta)[0]
    ) / (2 * delta)
    np.testing.assert_allclose(du, finite_u, atol=1e-9)
    np.testing.assert_allclose(dv, finite_v, atol=1e-9)
    assert abs(np.dot(normal, du)) < 1e-12
    result = AnalyticScene([body]).intersections(point + normal * 0.1, -normal)
    assert result.status == "hit", result.diagnostic
    hit = result.events[0]
    np.testing.assert_allclose(hit.position, point, atol=1e-11)
    np.testing.assert_allclose(hit.normal, normal, atol=1e-10)


def test_asphere_axis_and_side():
    hits = events(asphere(), [0, 0, -2], [0, 0, 1])
    np.testing.assert_allclose([h.distance for h in hits], [1.5, 2.5], atol=1e-12)
    hits = events(asphere(), [-2, 0, 0], [1, 0, 0])
    np.testing.assert_allclose([h.distance for h in hits], [1, 3], atol=1e-12)
    assert all(h.surface_ref.surface_index == 1 for h in hits)
    assert not events(asphere(), [-2, 1.1, 0], [1, 0, 0.1])


def fiber(arc=False, taper=False):
    length = np.pi if arc else 3.0
    return dict(
        kind="fiber",
        nodeId="fiber",
        path=dict(
            start=[0, 0, 0],
            direction=[0, 0, 1],
            segments=[dict(kind="arc", normal=[0, 1, 0], radius=2, angle=np.pi / 2)]
            if arc
            else [dict(kind="line", length=length)],
        ),
        radiusProfile=[
            dict(s=0, radius=0.2),
            dict(s=length / 2, radius=0.3 if taper else 0.2),
            dict(s=length, radius=0.25 if taper else 0.2),
        ],
    )


@pytest.mark.parametrize("arc", [False, True])
@pytest.mark.parametrize("taper", [False, True])
def test_fiber_surface_caps_and_no_artificial_knot_cap(arc, taper):
    node = fiber(arc, taper)
    s = node["radiusProfile"][-1]["s"] * 0.3
    evaluated = evaluate_fiber(node, s, 0.6)
    result = AnalyticScene([solid(node)]).intersections(
        evaluated["position"] + 0.03 * evaluated["outward"], -evaluated["outward"]
    )
    assert result.status == "hit", result.diagnostic
    np.testing.assert_allclose(
        result.events[0].position, evaluated["position"], atol=1e-10
    )
    np.testing.assert_allclose(result.events[0].normal, evaluated["outward"], atol=1e-9)
    if not arc:
        hits = events(node, [0, 0, -1], [0, 0, 1])
        np.testing.assert_allclose([h.distance for h in hits], [1, 4], atol=1e-12)
        assert [h.surface_ref.surface_index for h in hits] == [0, 2]


def test_fiber_knot_uses_right_derivative_and_arc_end_cap():
    node = fiber(False, True)
    position = evaluate_fiber(node, 1.5, 0.4)
    hit = AnalyticScene([solid(node)]).intersect(
        position["position"] + 0.1 * position["normal"], -position["normal"]
    )
    np.testing.assert_allclose(hit.normal, position["outward"], atol=1e-12)
    for sign in (-1, 1):
        node = fiber(True, True)
        node["path"]["segments"][0]["angle"] *= sign
        end = evaluate_fiber(node, node["radiusProfile"][-1]["s"])
        hit = AnalyticScene([solid(node)]).intersect(
            end["center"] + 0.03 * end["tangent"], -end["tangent"]
        )
        assert hit.surface_ref.surface_index == 2
        np.testing.assert_allclose(hit.position, end["center"], atol=1e-12)
        np.testing.assert_allclose(hit.normal, end["tangent"], atol=1e-12)


@pytest.mark.parametrize(
    "operation,distances",
    [("union", [1, 5]), ("intersect", [2, 4]), ("subtract", [1, 2, 4, 5])],
)
def test_csg_final_boundaries_and_cut_normal(operation, distances):
    node = dict(
        kind="boolean",
        operation=operation,
        children=[
            primitive("sphere", radius=2),
            dict(primitive("sphere", radius=1), nodeId="tool"),
        ],
    )
    hits = events(node, [-3, 0, 0], [1, 0, 0])
    np.testing.assert_allclose([h.distance for h in hits], distances)
    assert [h.crossing_kind for h in hits] == ["enter", "exit"] * (len(hits) // 2)
    if operation == "subtract":
        np.testing.assert_allclose(hits[1].normal, [1, 0, 0])
        assert hits[1].metadata.material_name == "Glass"


@pytest.mark.parametrize(
    "operation,count", [("union", 2), ("intersect", 2), ("subtract", 0)]
)
def test_coincident_events_are_order_independent(operation, count):
    node = dict(
        kind="boolean",
        operation=operation,
        children=[
            primitive("sphere", radius=1),
            dict(primitive("sphere", radius=1), nodeId="copy"),
        ],
    )
    assert len(events(node, [-2, 0, 0], [1, 0, 0])) == count


def test_tangent_and_near_miss_are_distinct():
    assert [
        h.crossing_kind
        for h in events(primitive("sphere", radius=1), [-2, 1, 0], [1, 0, 0])
    ] == ["touch"]
    assert not events(primitive("sphere", radius=1), [-2, 1 + 1e-8, 0], [1, 0, 0])
    roots = isolate_roots(lambda t: (t - 0.37) ** 2, 0, 1, label="double-root")
    assert len(roots) == 1
    assert roots[0].value == pytest.approx(0.37, abs=1e-12)
    assert not isolate_roots(lambda t: (t - 0.37) ** 2 + 1e-8, 0, 1, label="near-miss")
    hits = events(primitive("box", size=[2, 2, 2]), [-2, 1, 0], [1, 0, 0])
    assert all(hit.crossing_kind == "touch" for hit in hits)


def test_transform_normal_distance_and_unit_conversion():
    matrix = np.diag([-2.0, 3.0, 0.5, 1.0])
    matrix[:3, 3] = [0.3, 0.7, -0.2]
    node = dict(
        kind="instance",
        child=primitive("sphere", radius=1),
        matrix=matrix.ravel().tolist(),
    )
    hits = events(node, [-4, 0.7, -0.2], [1, 0, 0])
    np.testing.assert_allclose([h.distance for h in hits], [2.3, 6.3])
    np.testing.assert_allclose(hits[0].normal, [-1, 0, 0])
    mm = AnalyticScene([solid(primitive("sphere", radius=1000), 0.001)])
    m = AnalyticScene([solid(primitive("sphere", radius=1))])
    np.testing.assert_allclose(
        mm.intersect([-2, 0, 0], [1, 0, 0]).position,
        m.intersect([-2, 0, 0], [1, 0, 0]).position,
    )


def test_self_hit_exclusion_does_not_skip_a_nearby_other_surface():
    node = dict(
        kind="boolean",
        operation="subtract",
        children=[
            primitive("sphere", radius=1),
            dict(primitive("sphere", radius=1 - 1e-9), nodeId="inner"),
        ],
    )
    scene = AnalyticScene([solid(node)])
    hit = scene.intersect([-2, 0, 0], [1, 0, 0])
    following = scene.intersect(hit.position, [1, 0, 0], previous=hit)
    assert following.surface_ref.source_node_id == "inner"
    assert following.distance == pytest.approx(1e-9, abs=2e-15)


def test_surface_sampling_and_hits_are_tessellation_independent():
    node = curved()
    node2 = deepcopy(node)
    node2["tessellation"] = dict(azimuthalSegments=5, verticalSegments=3)
    bodies = [solid(n) for n in (node, node2)]
    selector = dict(rootId="solid", sourceNodeId="curvedEdgeCylinder", surfaceIndex=1)
    samplers = [
        AnalyticSurfaceSampler({"solid": b}, [selector, selector]) for b in bodies
    ]
    for index in range(20):
        first, second = [sampler.sample(42, 0, index) for sampler in samplers]
        np.testing.assert_array_equal(first, second)
        position, normal = first
        hits = [
            AnalyticScene([b]).intersect(position + normal * 0.1, -normal)
            for b in bodies
        ]
        np.testing.assert_array_equal(hits[0].position, hits[1].position)
        np.testing.assert_array_equal(hits[0].normal, hits[1].normal)


def test_clipped_source_samples_only_remaining_boundary():
    node = dict(
        kind="boolean",
        operation="intersect",
        children=[
            primitive("sphere", radius=1),
            dict(
                kind="transform",
                matrix=[1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                child=primitive("box", size=[1, 3, 3]),
            ),
        ],
    )
    body = solid(node)
    sampler = AnalyticSurfaceSampler(
        {"solid": body}, [dict(rootId="solid", sourceNodeId="sphere", surfaceIndex=0)]
    )
    for i in range(50):
        point, normal = sampler.sample(1, 0, i)
        assert point[0] >= 0
        assert np.linalg.norm(point) == pytest.approx(1)
        np.testing.assert_allclose(point, normal, atol=1e-12)


@pytest.mark.asyncio
async def test_scene_and_sources_never_request_mesh(monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("Analytic ray path requested triangular_mesh")

    monkeypatch.setattr(GeometryService, "triangular_mesh", forbidden)

    async def progress(value):
        pass

    scene = dict(
        geometryHash="one",
        lengthUnit="m",
        roots=[
            dict(
                id="solid",
                node=primitive("sphere", radius=1),
                material=dict(name="Glass"),
            )
        ],
        geometryGroups=[dict(name="source", rootIds=["solid"])],
        surfaceGroups=[],
    )
    context = SimpleNamespace(
        geometry=GeometryService(),
        descriptor=dict(referenceLengthUnit="m"),
        progress=progress,
    )
    collision, solids = await build_collision_scene(context, scene, scene["roots"])
    assert collision.intersect([-2, 0, 0], [1, 0, 0]) is not None
    params = dict(
        wavelength=550e-9,
        radiantFlux=1.0,
        rayCount=2,
        stokes=[1, 0, 0, 0],
        direction=[1, 0, 0],
        coneHalfAngle=0.0,
    )
    rays, _ = await launch_sources(
        context,
        dict(
            initializations=[
                dict(
                    methodId="ray.point-source",
                    target=["experiment.geometry.source"],
                    parameters=params,
                )
            ]
        ),
        scene,
        solids,
        1,
    )
    np.testing.assert_array_equal(rays[0].origin, [0, 0, 0])


def test_explicit_unresolved_and_nonregular_errors(monkeypatch):
    from app.methods.rays import analytic

    def fail(*args):
        raise UnresolvedIntersection("injected numerical failure")

    monkeypatch.setattr(analytic, "_leaf_events", fail)
    scene = AnalyticScene([solid(primitive("sphere", radius=1))])
    assert scene.intersections([-2, 0, 0], [1, 0, 0]).status == "unresolved"
    with pytest.raises(UnresolvedIntersection, match="injected"):
        scene.intersect([-2, 0, 0], [1, 0, 0])
    node = curved()
    node["parameters"]["verticalCurve"]["coefficients"] = [-1]
    with pytest.raises(ValueError, match="positive radius"):
        solid(node)


def test_point_source_bounds_are_tight_for_transformed_ellipsoid():
    matrix = np.eye(4)
    angle = 0.6
    matrix[:2, :2] = [[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]
    matrix[:3, 3] = [2, 3, 4]
    body = solid(
        dict(
            kind="transform",
            child=primitive("ellipsoid", axialRadius=2, focalDistance=1),
            matrix=matrix.ravel().tolist(),
        )
    )
    minimum, maximum = solid_bounds(body)
    np.testing.assert_allclose((minimum + maximum) / 2, [2, 3, 4])


def test_point_bounds_follow_boolean_clipping():
    node = dict(
        kind="boolean",
        operation="intersect",
        children=[
            primitive("sphere", radius=1),
            dict(
                kind="transform",
                matrix=[1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                child=primitive("box", size=[1, 3, 3]),
            ),
        ],
    )
    minimum, maximum = solid_bounds(solid(node))
    np.testing.assert_allclose(minimum, [0, -1, -1], atol=1e-9)
    np.testing.assert_allclose(maximum, [1, 1, 1], atol=1e-9)


def test_empty_coincident_source_and_multiple_selector_area_weights():
    node = dict(
        kind="boolean",
        operation="subtract",
        children=[
            primitive("sphere", radius=1),
            dict(primitive("sphere", radius=1), nodeId="copy"),
        ],
    )
    with pytest.raises(ValueError, match="positive-area"):
        AnalyticSurfaceSampler(
            {"solid": solid(node)},
            [dict(rootId="solid", sourceNodeId="sphere", surfaceIndex=0)],
        )
    body = solid(primitive("box", size=[1, 2, 3]))
    selectors = [
        dict(rootId="solid", sourceNodeId="box", surfaceIndex=i) for i in (1, 5)
    ]
    sampler = AnalyticSurfaceSampler({"solid": body}, selectors)
    hits = [sampler.sample(14, 0, i)[1] for i in range(800)]
    # x face area is 6; z face area is 2. The source keeps equal ray powers.
    fraction = sum(normal[0] > 0.5 for normal in hits) / len(hits)
    assert 0.69 < fraction < 0.81


def test_partially_coincident_emitters_do_not_overweight_shared_area():
    children = []
    for name, offset in (("left", -0.5), ("right", 0.5)):
        matrix = np.eye(4)
        matrix[0, 3] = offset
        children.append(
            dict(
                kind="transform",
                matrix=matrix.ravel().tolist(),
                child=dict(primitive("box", size=[2, 2, 2]), nodeId=name),
            )
        )
    body = solid(dict(kind="boolean", operation="union", children=children))
    sampler = AnalyticSurfaceSampler(
        {"solid": body},
        [
            dict(rootId="solid", sourceNodeId=name, surfaceIndex=5)
            for name in ("left", "right")
        ],
    )
    points = np.array([sampler.sample(14, 0, i)[0] for i in range(600)])
    assert 0.27 < np.mean(np.abs(points[:, 0]) < 0.5) < 0.40
    np.testing.assert_allclose(points[:, 2], 1)


def test_asphere_multiple_crossings_and_nonlinear_tangent():
    node = asphere()
    node["parameters"]["top"] = dict(
        curvature=0,
        conic=0,
        coefficients=[
            dict(order=4, value=1),
            dict(order=6, value=-2),
            dict(order=8, value=1),
        ],
    )
    hits = events(node, [-2, 0, 0.51], [1, 0, 0])
    assert len(hits) == 4
    for hit in hits:
        x = hit.position[0]
        assert x**4 * (1 - x * x) ** 2 == pytest.approx(0.01, abs=1e-12)
    node["parameters"]["top"] = dict(
        curvature=0, conic=0, coefficients=[dict(order=4, value=1)]
    )
    hits = events(node, [-2, 0.5, 0.5625], [1, 0, 0])
    touches = [hit for hit in hits if hit.crossing_kind == "touch"]
    assert len(touches) == 1
    np.testing.assert_allclose(touches[0].position, [0, 0.5, 0.5625], atol=1e-12)


@pytest.mark.parametrize("detector", [False, True])
def test_touch_preserves_medium_and_direction_unless_detected(monkeypatch, detector):
    from app.solvers.ray_tracing import formulation

    scene = AnalyticScene([solid(primitive("sphere", radius=1))])
    ray = Ray(
        np.array([-2.0, 1, 0]),
        np.array([1.0, 0, 0]),
        np.array([0.0, 1, 0]),
        np.array([1.0, 0, 0, 0]),
        550e-9,
        1,
        0,
    )
    monkeypatch.setattr(
        formulation,
        "optical_material",
        lambda *args: SimpleNamespace(
            absorption_coefficient=0, scattering_coefficient=0
        ),
    )
    collector = PathCollector(10)
    result = _trace_one(
        ray,
        scene,
        {},
        {},
        {SurfaceRef("solid", "sphere", 0): [object()]} if detector else {},
        {},
        {},
        {},
        8,
        1e-8,
        1,
        collector,
    )
    assert not ray.medium_stack
    np.testing.assert_array_equal(ray.direction, [1, 0, 0])
    assert collector.detected_power == int(detector)
    assert len(result) == int(not detector)


@pytest.mark.parametrize("order", [0, 1])
def test_rotated_thin_grating_exit_is_not_repeated_after_world_rounding(order):
    from app.solvers.ray_tracing.grating import diffracted_direction
    from app.solvers.ray_tracing.formulation import _cross_medium
    matrix = np.array([
        [0.9999823208972435, 0., -0.005946250327933201, 0.],
        [0., 1., 0., 0.],
        [0.005946250327933201, 0., 0.9999823208972435, 0.1192437306685398],
        [0., 0., 0., 1.],
    ])
    scene = AnalyticScene([solid(dict(kind="transform", matrix=matrix.ravel().tolist(),
        child=primitive("box", size=[.02, .02, .0000762])))])
    origin = np.array([-.00020206606634240584, -.0003835484692435692, .07])
    incoming = np.array([.006926325427595277, .006021548651563518, .9999578825970161])
    front = scene.intersect(origin, incoming)
    assert front.crossing_kind == "enter"
    direction = diffracted_direction(incoming, front.normal, np.array([0., -1., 0.]),
        550e-9, 2e-6, order, incident_index=1., outgoing_index=1., transmission=True)
    rear = scene.intersect(front.position, direction, previous=front)
    assert rear.crossing_kind == "exit" and rear.surface_ref.surface_index == 5
    assert rear.distance > .0000762
    stack = _cross_medium([], None, ("solid", "Glass"))
    assert _cross_medium(stack, "solid", None) == []
    assert scene.intersect(rear.position, direction, previous=rear) is None
    # A real reflected crossing through the other face remains visible.
    reflected = direction - 2 * np.dot(direction, rear.normal) * rear.normal
    back = scene.intersect(rear.position, reflected, previous=rear)
    assert back.crossing_kind == "exit" and back.surface_ref.surface_index == 4
    assert back.distance > .0000762


def test_self_hit_filter_keeps_a_distinct_crossing_of_the_same_curved_surface():
    scene = AnalyticScene([solid(primitive("sphere", radius=1.))])
    first = scene.intersect([-2., .25, 0.], [1., 0., 0.])
    last = scene.intersect(first.position, [1., 0., 0.], previous=first)
    assert first.surface_ref == last.surface_ref
    assert first.crossing_kind == "enter" and last.crossing_kind == "exit"
    assert last.distance == pytest.approx(2 * np.sqrt(1 - .25**2))


def test_diffracted_nearly_axial_ray_crosses_each_film_face_once(monkeypatch):
    from app.methods.optics import perpendicular
    from app.solvers.ray_tracing import formulation
    # Seed 42, case 8947: the old filter accepted the front face again at
    # t=1.3581848041908873e-17 after the first-order direction changed.
    matrix = np.array([
        [.999838604433591, 0., .01796566403696789, 0.],
        [0., 1., 0., 0.],
        [-.01796566403696789, 0., .999838604433591, .12267024792692374],
        [0., 0., 0., 1.],
    ])
    scene = AnalyticScene([solid(dict(kind="transform", matrix=matrix.ravel().tolist(),
        child=primitive("box", size=[.02, .02, .0000762])))])
    origin = np.array([-1.6996600614159994e-05, .0001396058599266658, .07])
    incoming = np.array([-3.269065001722279e-05, -.0018557101170121677, .9999982776341583])
    ray = Ray(origin, incoming, perpendicular(incoming), np.array([1., 0., 0., 0.]), 550e-9, 1., 0)
    monkeypatch.setattr(formulation, "optical_material", lambda *args: SimpleNamespace(
        absorption_coefficient=0., scattering_coefficient=0., refractive_index=complex(1.)))
    grating = {SurfaceRef("solid", "box", 4): dict(spacing={"value": 2e-6},
        grooveDirection={"value": [0., -1., 0.]}, orders={"value": [1]},
        reflectedEfficiencies={"value": [0.]}, transmittedEfficiencies={"value": [1.]})}
    collector = PathCollector(10)
    for step in range(3):
        branches = _trace_one(ray, scene, {}, {}, {}, {}, {}, grating, 8, 1e-8, 42, collector)
        if step < 2:
            assert len(branches) == 1
            ray = branches[0]
            assert ray.last_hit.surface_ref.surface_index == (4 if step == 0 else 5)
            assert ray.medium_stack == ([("solid", "Glass")] if step == 0 else [])
            assert ray.stokes[0] == pytest.approx(1.)
        else:
            assert not branches
    assert collector.paths[0].events == [11, 1, 7]


@pytest.mark.parametrize("translation", [0., 1e6])
def test_plane_distance_bound_covers_affine_cancellation(translation):
    import mpmath
    from app.methods.rays.analytic import _leaf_events
    matrix = np.array([[.999838604433591, 0., .01796566403696789, 0.], [0., 1., 0., 0.],
        [-.01796566403696789, 0., .999838604433591, .12267024792692374], [0., 0., 0., 1.]])
    shift = np.array([translation, -translation, translation])
    matrix[:3, 3] += shift
    body = solid(dict(kind="transform", matrix=matrix.ravel().tolist(),
        child=primitive("box", size=[.02, .02, .0000762])))
    origin = np.array([-1.8717193498686394e-05, 4.193506961222959e-05, .12263247809785088]) + shift
    direction = np.array([.27432238514702706, -.0018557101170121677, .961635994203216])
    leaf = body.leaves[0]
    hit = next(event for event in _leaf_events(leaf, origin, direction) if event.surface_ref.surface_index == 4)
    precise = mpmath.mp.clone()
    precise.dps = 80
    local_origin = sum(precise.mpf(float(leaf.inverse[2, i])) * float(origin[i]) for i in range(3)) + float(leaf.inverse[2, 3])
    local_direction = sum(precise.mpf(float(leaf.inverse[2, i])) * float(direction[i]) for i in range(3))
    expected = (-precise.mpf(.0000762) / 2 - local_origin) / local_direction
    assert abs(precise.mpf(hit.distance) - expected) <= hit.distance_error
    for axis in range(3):
        expected_position = precise.mpf(float(origin[axis])) + expected * float(direction[axis])
        assert abs(precise.mpf(float(hit.position[axis])) - expected_position) <= hit.position_error[axis]


def test_seeded_transformed_films_keep_enter_exit_and_reflection_order():
    from app.solvers.ray_tracing.grating import diffracted_direction
    rng = np.random.default_rng(42)
    for index in range(10000):
        angle, z = rng.uniform(-.05, .05), rng.uniform(.08, .15)
        c, s = np.cos(angle), np.sin(angle)
        matrix = np.array([[c, 0., s, 0.], [0., 1., 0., 0.], [-s, 0., c, z], [0., 0., 0., 1.]])
        origin = np.array([rng.uniform(-.003, .003), rng.uniform(-.0015, .0015), .07])
        incoming = np.array([rng.uniform(-.03, .03), rng.uniform(-.01, .01), 1.])
        incoming /= np.linalg.norm(incoming)
        scene = AnalyticScene([solid(dict(kind="transform", matrix=matrix.ravel().tolist(),
            child=primitive("box", size=[.02, .02, .0000762])))])
        front = scene.intersect(origin, incoming)
        assert front.crossing_kind == "enter", index
        direction = diffracted_direction(incoming, front.normal, np.array([0., -1., 0.]),
            (400e-9, 550e-9, 700e-9)[index % 3], 2e-6, (0, 1, -1)[index % 3],
            incident_index=1., outgoing_index=1., transmission=True)
        rear = scene.intersect(front.position, direction, previous=front)
        assert rear.crossing_kind == "exit" and rear.surface_ref.surface_index == 5, index
        assert rear.distance > .0000762, index
        assert scene.intersect(rear.position, direction, previous=rear) is None, index
        reflected = direction - 2 * np.dot(direction, rear.normal) * rear.normal
        returning = scene.intersect(rear.position, reflected, previous=rear)
        assert returning.crossing_kind == "exit" and returning.surface_ref.surface_index == 4, index
        assert scene.intersect(returning.position, reflected, previous=returning) is None, index


def test_near_tangent_true_recrossing_is_kept_or_explicitly_unresolved():
    scene = AnalyticScene([solid(primitive("sphere", radius=1.))])
    # Resolvable entry and exit of the same curved surface must both survive.
    first = scene.intersect([-2., 1. - 1e-8, 0.], [1., 0., 0.])
    following = scene.intersect(first.position, [1., 0., 0.], previous=first)
    assert following.crossing_kind == "exit" and following.distance > 2e-4
    # Closer to tangency the propagated uncertainty includes a different root.
    first = scene.intersect([-2., 1. - 5e-16, 0.], [1., 0., 0.])
    with pytest.raises(UnresolvedIntersection, match="separation"):
        scene.intersect(first.position, [1., 0., 0.], previous=first)
    tangent = scene.intersect([-2., 1., 0.], [1., 0., 0.])
    assert tangent.crossing_kind == "touch"
    assert scene.intersect(tangent.position, [1., 0., 0.], previous=tangent) is None


def test_incident_position_error_is_projected_along_diffracted_direction():
    from app.solvers.ray_tracing.grating import diffracted_direction
    matrix = np.array([[.999838604433591, 0., .01796566403696789, 0.], [0., 1., 0., 0.],
        [-.01796566403696789, 0., .999838604433591, .12267024792692374], [0., 0., 0., 1.]])
    scene = AnalyticScene([solid(dict(kind="transform", matrix=matrix.ravel().tolist(),
        child=primitive("box", size=[.02, .02, .0000762])))])
    incoming = np.array([0., 0., 1.])
    front = scene.intersect([0., 0., -1e8], incoming)
    direction = diffracted_direction(incoming, front.normal, np.array([0., -1., 0.]),
        550e-9, 2e-6, 1, incident_index=1., outgoing_index=1., transmission=True)
    # Long incident travel leaves uncertainty along z, while the new ray has x motion.
    assert front.position_error[0] == 0
    raw = scene.intersect(front.position, direction)
    assert raw.surface_ref == front.surface_ref and raw.distance > 1e-9
    rear = scene.intersect(front.position, direction, previous=front)
    assert rear.surface_ref.surface_index == 5 and rear.crossing_kind == "exit"
    assert rear.distance > .0000762


def test_plane_direction_cancellation_is_explicitly_unresolved():
    c, s = np.cos(.3), np.sin(.3)
    matrix = np.array([[c, 0., s, 0.], [0., 1., 0., 0.], [-s, 0., c, 0.], [0., 0., 0., 1.]])
    scene = AnalyticScene([solid(dict(kind="transform", matrix=matrix.ravel().tolist(),
        child=primitive("box", size=[2., 2., .0000762])))])
    origin = matrix[:3, :3] @ np.array([0., 0., -.0000381])
    resolved = matrix[:3, :3] @ np.array([1., 0., 1e-10])
    assert scene.intersect(origin, resolved).surface_ref.surface_index == 4
    unresolved = matrix[:3, :3] @ np.array([1., 0., 1e-16])
    with pytest.raises(UnresolvedIntersection, match="plane direction"):
        scene.intersect(origin, unresolved)


@pytest.mark.parametrize("stack,exiting,entering,message", [
    ([], "solid", None, "exited inactive medium"),
    ([("solid", "Glass")], None, ("solid", "Glass"), "entered active medium"),
    ([("outer", "Glass"), ("inner", "Glass")], "outer", None, "must not overlap"),
])
def test_medium_transition_errors_are_not_silenced(stack, exiting, entering, message):
    from app.kernel.api.errors import CaeError
    from app.solvers.ray_tracing.formulation import _cross_medium
    with pytest.raises(CaeError, match=message):
        _cross_medium(stack, exiting, entering)
