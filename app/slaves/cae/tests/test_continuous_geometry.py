"""Shared axial-solid contracts, continuous differentials and mesh convergence."""

import asyncio
import json
from pathlib import Path

import numpy as np
import pytest

from app.methods.geometry import (
    GeometryService,
    TriangularMesh,
    TriangleProvenance,
    mass_properties,
)
from app.methods.geometry.continuous import (
    evaluate_surface,
    evaluate_differential,
    tessellate_primitive,
)
from app.methods.geometry.fiber import evaluate_fiber, tessellate_fiber
from tests.geometry_fixtures import scene, transformed, boolean, box
from app.methods.geometry import TriangleMeshingProfile
from app.methods.mesh import VolumeMeshingProfile

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures/continuous-geometry.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("fixture", FIXTURES)
def test_continuous_solids_feed_component_and_volume_mesh_consumers(fixture):
    node = dict(
        kind="primitive",
        nodeId="surface",
        primitive=fixture["kind"],
        parameters=fixture["parameters"],
        tessellation=dict(radialSegments=12, meridianSegments=4),
    )
    source = scene(node)
    service = GeometryService()
    components = asyncio.run(
        service.solid_components(source, "body", "m", TriangleMeshingProfile(12))
    )
    assert len(components) == 1 and mass_properties(components[0].mesh, 1).volume > 0
    volume = asyncio.run(
        service.volume_mesh(
            source,
            ("body",),
            "m",
            VolumeMeshingProfile(1.5, boundary_max_element_size=1.5),
        )
    )
    assert len(volume.cells) > 0
    assert {
        alias.surface_index
        for aliases in volume.boundary_provenance
        for alias in aliases
    } == set(fixture["surfaces"])


@pytest.mark.parametrize("fixture", FIXTURES)
def test_shared_continuous_mesh_winding_closed_edges_and_derivatives(fixture):
    kind, p = fixture["kind"], fixture["parameters"]
    vertices, triangles, surfaces = tessellate_primitive(
        kind, p, dict(radialSegments=32, meridianSegments=16)
    )
    assert sorted(set(surfaces)) == fixture["surfaces"]
    edges = np.sort(
        np.concatenate(
            [triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]]
        ),
        axis=1,
    )
    assert np.all(np.unique(edges, axis=0, return_counts=True)[1] == 2)
    points = vertices[triangles]
    normals = np.cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0])
    assert np.all(np.linalg.norm(normals, axis=1) > 0)
    value = mass_properties(
        TriangularMesh(
            vertices,
            triangles,
            tuple(TriangleProvenance("body", "primitive", index) for index in surfaces),
        ),
        1,
    )
    assert value.volume > 0
    for surface in fixture["surfaces"]:
        at = evaluate_differential(kind, p, surface, 0.37, 0.43)
        finite = (
            evaluate_surface(kind, p, surface, 0.370001, 0.43)[0]
            - evaluate_surface(kind, p, surface, 0.369999, 0.43)[0]
        ) / 2e-6
        np.testing.assert_allclose(at["derivativeU"], finite, rtol=2e-9, atol=2e-9)
        affine = np.diag([-2.0, 3.0, 0.5, 1.0])
        affine[:3, 3] = [4, 5, 6]
        moved = evaluate_differential(kind, p, surface, 0.37, 0.43, affine)
        assert moved["normal"] @ moved["derivativeU"] == pytest.approx(0, abs=1e-12)
        assert moved["normal"] @ moved["derivativeV"] == pytest.approx(0, abs=1e-12)


@pytest.mark.parametrize("fixture", FIXTURES[:4])
def test_foci_radius_and_volume_inertia_convergence(fixture):
    kind, p = fixture["kind"], fixture["parameters"]
    if kind == "ellipsoid":
        a, f = p["axialRadius"], p["focalDistance"]
        b2 = a * a - f * f
        exact = 4 * np.pi * b2 * a / 3
        expected_inertia = exact / 5 * np.diag([a * a + b2, a * a + b2, 2 * b2])
    elif kind == "hyperboloid":
        a, f, r = p["axialRadius"], p["focalDistance"], p["radius"]
        b2 = f * f - a * a
        top = a * np.sqrt(1 + r * r / b2)
        exact = np.pi * r * r * top - 2 * np.pi * a * b2 / 3 * (
            (1 + r * r / b2) ** 1.5 - 1
        )
    else:
        f, r = p["focalLength"], p["radius"]
        top = r * r / (4 * f)
        exact = np.pi * r**4 / (8 * f)
    errors = []
    for subdivisions in (16, 32, 64, 128):
        vertices, triangles, surfaces = tessellate_primitive(
            kind,
            p,
            dict(radialSegments=subdivisions, meridianSegments=subdivisions // 2),
        )
        actual = mass_properties(
            TriangularMesh(
                vertices,
                triangles,
                tuple(
                    TriangleProvenance("body", "primitive", index) for index in surfaces
                ),
            ),
            1,
        )
        errors.append(abs(actual.volume - exact))
        if kind == "ellipsoid" and subdivisions == 128:
            np.testing.assert_allclose(
                actual.inertia, expected_inertia, rtol=0.002, atol=1e-10
            )
        elif kind != "ellipsoid":
            assert np.linalg.norm(vertices[:, :2], axis=1).max() == pytest.approx(r)
            assert vertices[:, 2].max() == pytest.approx(top)
            assert vertices[:, 2].min() == pytest.approx(
                a if kind == "hyperboloid" else 0
            )
    assert all(fine < coarse / 3 for coarse, fine in zip(errors, errors[1:]))
    for u in (0, 0.2, 0.7, 1):
        point, _ = evaluate_surface(kind, p, 0 if kind == "ellipsoid" else 1, u, 0.3)
        if kind in {"ellipsoid", "hyperboloid"}:
            near = np.linalg.norm(point - [0, 0, f])
            far = np.linalg.norm(point + [0, 0, f])
            assert (near + far if kind == "ellipsoid" else far - near) == pytest.approx(
                2 * a
            )
        else:
            assert np.linalg.norm(point - [0, 0, f]) == pytest.approx(point[2] + f)


def test_fiber_profiles_frames_and_invalid_intersections():
    node = dict(
        path=dict(
            start=[0, 0, 0],
            direction=[0, 0, 1],
            segments=[
                dict(kind="line", length=2),
                dict(kind="arc", radius=3, angle=np.pi / 2, normal=[0, 1, 0]),
            ],
        ),
        radiusProfile=[
            dict(s=0, radius=0.2),
            dict(s=2, radius=0.3),
            dict(s=2 + 3 * np.pi / 2, radius=0.2),
        ],
    )
    end = evaluate_fiber(node, 2 + 3 * np.pi / 2)
    np.testing.assert_allclose(end["center"], [3, 0, 5], atol=1e-12)
    np.testing.assert_allclose(
        evaluate_fiber(node, 2, side="left")["normal"],
        evaluate_fiber(node, 2)["normal"],
    )
    assert not np.allclose(
        evaluate_fiber(node, 2, side="left")["outward"],
        evaluate_fiber(node, 2)["outward"],
    )
    vertices, triangles, surfaces = tessellate_fiber(
        node, dict(pathSegments=7, radialSegments=24)
    )
    assert set(surfaces) == {0, 1, 2}
    assert (
        mass_properties(
            TriangularMesh(
                vertices,
                triangles,
                tuple(
                    TriangleProvenance("body", "primitive", index) for index in surfaces
                ),
            ),
            1,
        ).volume
        > 0
    )
    node["path"]["segments"] = [
        dict(kind="arc", radius=3, angle=np.pi / 2, normal=[0, 1, 0])
    ] * 4
    node["radiusProfile"] = [dict(s=0, radius=0.2), dict(s=6 * np.pi, radius=0.2)]
    with pytest.raises(ValueError, match="self-intersection"):
        tessellate_fiber(node)
    with pytest.raises(ValueError, match="rebuild"):
        tessellate_fiber(dict(points=[], radii=[]))


def test_worker_transform_boolean_surface_provenance_units_and_cache():
    primitive = dict(
        kind="primitive",
        nodeId="bowl",
        primitive="paraboloid",
        parameters=dict(focalLength=2, radius=4),
        tessellation=dict(radialSegments=24, meridianSegments=8),
    )
    node = transformed(
        boolean(
            "cut",
            "subtract",
            primitive,
            transformed(box("cutter", [2, 2, 6]), [4, 0, 0]),
        ),
        [10, 0, 0],
        np.diag([-1.0, 2.0, 1.0]),
    )
    input_scene = scene(node, "mm")
    input_scene["meshHash"] = "coarse"
    service = GeometryService()
    mesh = asyncio.run(service.triangular_mesh(input_scene, "body", "m"))
    assert {
        x.surface_index for x in mesh.triangle_provenance if x.source_node_id == "bowl"
    } == {1, 2}
    assert mass_properties(mesh, 1).volume > 0
    assert mesh.vertices[:, 2].max() == pytest.approx(0.002)
    input_scene["meshHash"] = "fine"
    primitive["tessellation"]["radialSegments"] = 48
    refined = asyncio.run(service.triangular_mesh(input_scene, "body", "m"))
    assert refined is not mesh and len(refined.triangles) > len(mesh.triangles)


def test_worker_rejects_removed_or_invalid_definitions():
    with pytest.raises(ValueError, match="zMax"):
        tessellate_primitive("paraboloid", dict(focalLength=2, radius=4, zMax=2))
    with pytest.raises(ValueError, match="intersect"):
        tessellate_primitive(
            "asphericCylinder",
            dict(
                radius=1,
                centerThickness=0.1,
                top=dict(
                    curvature=0,
                    conic=0,
                    coefficients=[dict(order=4, value=-4), dict(order=6, value=4)],
                ),
                bottom=dict(curvature=0, conic=0, coefficients=[]),
            ),
        )
    with pytest.raises(ValueError, match="rebuild"):
        asyncio.run(
            GeometryService().triangular_mesh(
                scene(dict(kind="shell", nodeId="old")), "body", "m"
            )
        )
