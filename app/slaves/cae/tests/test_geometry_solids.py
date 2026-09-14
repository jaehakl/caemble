"""Canonical solid decomposition and exact polyhedral mass integration."""

import asyncio
from copy import deepcopy

import numpy as np
import pytest

from app.kernel.resources import FileResourceCache
from app.methods.geometry import (
    GeometryService,
    TriangleMeshingProfile,
    TriangularMesh,
    mass_properties,
    solid_component_identity,
)


def box(name, size):
    return {"kind": "primitive", "nodeId": name, "primitive": "box", "parameters": {"size": size}}


def transformed(node, position=(0, 0, 0), rotation=None):
    matrix = np.eye(4)
    matrix[:3, 3] = position
    if rotation is not None:
        matrix[:3, :3] = rotation
    return {"kind": "transform", "nodeId": node["nodeId"] + "-transform", "matrix": matrix.ravel().tolist(), "child": node}


def boolean(name, operation, *children):
    return {"kind": "boolean", "nodeId": name, "operation": operation, "children": list(children)}


def scene(node, unit="m"):
    return {"geometryHash": repr(node), "lengthUnit": unit, "roots": [{"id": "body", "node": node}]}


def components(node, segments=256, unit="m"):
    return asyncio.run(GeometryService().solid_components(scene(node, unit), "body", "m", TriangleMeshingProfile(segments)))


def box_inertia(size, mass):
    squared = np.square(size)
    return mass * np.diag(squared.sum() - squared) / 12


def test_box_mass_center_full_rotated_inertia_and_frozen_arrays():
    angle = 0.43
    rotation = np.array([[np.cos(angle), -np.sin(angle), 0], [np.sin(angle), np.cos(angle), 0], [0, 0, 1]])
    size, center, density = np.array([2, 3, 4]), np.array([1.5, -0.25, 2]), 7.0
    solid, = components(transformed(box("box", size.tolist()), center, rotation))
    properties = mass_properties(solid.mesh, density)
    np.testing.assert_allclose(properties.center, center, atol=1e-14)
    assert properties.mass == pytest.approx(168)
    expected = rotation @ box_inertia(size, properties.mass) @ rotation.T
    np.testing.assert_allclose(properties.inertia, expected, rtol=1e-14, atol=1e-12)
    assert abs(properties.inertia[0, 1]) > 1
    for array in (solid.mesh.vertices, solid.mesh.triangles, properties.center, properties.inertia):
        assert not array.flags.writeable


def test_mass_integration_is_translation_stable_and_converts_geometry_units():
    shifted, = components(transformed(box("box", [2, 3, 4]), [1e9, -1e9, 5e8]))
    properties = mass_properties(shifted.mesh, 7)
    np.testing.assert_array_equal(properties.center, [1e9, -1e9, 5e8])
    np.testing.assert_allclose(properties.inertia, box_inertia([2, 3, 4], 168), rtol=1e-14)
    millimeter, = components(box("box", [2000, 3000, 4000]), unit="mm")
    converted = mass_properties(millimeter.mesh, 7)
    assert converted.mass == pytest.approx(properties.mass)
    np.testing.assert_allclose(converted.inertia, properties.inertia, rtol=1e-14)


def test_offset_enclosed_cavity_preserves_mass_center_and_general_inertia():
    outer_size, inner_size = np.array([4, 3, 2]), np.array([1, .75, 1])
    offset = np.array([.5, .25, .3])
    solid, = components(boolean("hollow", "subtract", box("outer", outer_size.tolist()),
                                 transformed(box("inner", inner_size.tolist()), offset)))
    properties = mass_properties(solid.mesh, 2)
    outer_mass, inner_mass = 2 * np.prod(outer_size), 2 * np.prod(inner_size)
    expected_mass = outer_mass - inner_mass
    expected_center = -inner_mass * offset / expected_mass
    expected_origin = box_inertia(outer_size, outer_mass) - box_inertia(inner_size, inner_mass)
    expected_origin -= inner_mass * (offset @ offset * np.eye(3) - np.outer(offset, offset))
    expected = expected_origin - expected_mass * (
        expected_center @ expected_center * np.eye(3) - np.outer(expected_center, expected_center))
    assert properties.mass == pytest.approx(expected_mass)
    np.testing.assert_allclose(properties.center, expected_center, atol=1e-14)
    np.testing.assert_allclose(properties.inertia, expected, rtol=1e-13, atol=1e-13)
    assert {p.source_node_id for p in solid.mesh.triangle_provenance} == {"outer", "inner"}


def test_connected_material_separation_keeps_cavities_and_nested_islands():
    hollow = boolean("hollow", "subtract", box("outer", [4, 4, 4]), box("hole", [2, 2, 2]))
    nested = boolean("nested", "union", hollow, box("island", [1, 1, 1]),
                     transformed(box("separate", [2, 2, 2]), [7, 0, 0]))
    # Intersection must retain the same semantic components through the CSG tree.
    clipped = boolean("clip", "intersect", nested, box("bounds", [20, 20, 20]))
    solids = components(clipped)
    assert len(solids) == 3
    assert sorted(mass_properties(solid.mesh, 1).mass for solid in solids) == pytest.approx([1, 8, 56])
    assert len({solid.identity for solid in solids}) == 3
    assert [solid.identity for solid in solids] == sorted(solid.identity for solid in solids)


def test_two_hollow_components_each_own_their_cavity():
    first = boolean("first", "subtract", box("outer1", [4, 4, 4]), box("inner1", [2, 2, 2]))
    second = boolean("second", "subtract", box("outer2", [4, 4, 4]), box("inner2", [2, 2, 2]))
    solids = components(boolean("pair", "union", first, transformed(second, [10, 0, 0])))
    assert len(solids) == 2
    assert [mass_properties(solid.mesh, 1).volume for solid in solids] == pytest.approx([56, 56])


def test_sphere_mass_and_inertia_converge_with_independent_mesh_profile():
    node = {"kind": "primitive", "nodeId": "sphere", "primitive": "sphere",
            "parameters": {"radius": 1, "segments": 16}}
    original = deepcopy(node)
    errors = []
    for segments in (64, 128, 256):
        solid, = components(node, segments)
        properties = mass_properties(solid.mesh, 1)
        errors.append(abs(properties.inertia[0, 0] / (8 * np.pi / 15) - 1))
        np.testing.assert_allclose(properties.center, 0, atol=1e-14)
        assert abs(properties.volume / (4 * np.pi / 3) - 1) < errors[-1]
    assert errors[1] < .27 * errors[0]
    assert errors[2] < .27 * errors[1]
    assert errors[-1] < 1e-3
    assert node == original
    legacy = asyncio.run(GeometryService().triangular_mesh(scene(node), "body", "m"))
    assert len(legacy.triangles) < 1000


def test_boolean_cutter_refines_before_csg_evaluation():
    cylinder = {"kind": "primitive", "nodeId": "cutter", "primitive": "cylinder",
                "parameters": {"radius": .25, "radius_2": .25, "height": 2, "segments": 8}}
    shape = boolean("holed", "subtract", box("plate", [2, 3, 1]), transformed(cylinder, [.5, .5, 0]))
    analytic_volume = 6 - np.pi * .25**2
    volumes = []
    for segments in (16, 64, 256):
        solid, = components(shape, segments)
        properties = mass_properties(solid.mesh, 1)
        volumes.append(properties.volume)
        assert properties.inertia[0, 1] > 0
        assert {p.source_node_id for p in solid.mesh.triangle_provenance} == {"plate", "cutter"}
    assert abs(volumes[2] - analytic_volume) < abs(volumes[1] - analytic_volume) / 10
    assert abs(volumes[1] - analytic_volume) < abs(volumes[0] - analytic_volume) / 10


@pytest.mark.parametrize("primitive", ["sphere", "cylinder"])
def test_mass_profile_is_independent_of_lower_and_higher_display_subdivisions(primitive):
    parameters = {"radius": 1.}
    if primitive == "cylinder":
        parameters.update(radius_2=1., height=2.)
    profiles = []
    for display_segments in (16, 64):
        node = {"kind": "primitive", "nodeId": "shape", "primitive": primitive,
                "parameters": {**parameters, "segments": display_segments}}
        component, = components(node, segments=32)
        profiles.append((component, mass_properties(component.mesh, 2.)))
    first, second = profiles
    assert first[0].identity == second[0].identity
    assert first[1].mass == second[1].mass
    np.testing.assert_array_equal(first[1].center, second[1].center)
    np.testing.assert_array_equal(first[1].inertia, second[1].inertia)
    np.testing.assert_array_equal(first[0].mesh.vertices, second[0].mesh.vertices)
    np.testing.assert_array_equal(first[0].mesh.triangles, second[0].mesh.triangles)


def test_content_identity_does_not_depend_on_array_order_or_cyclic_triangle_order():
    solid, = components(boolean("hole", "subtract", box("outer", [4, 4, 4]), box("inner", [2, 2, 2])))
    mesh = solid.mesh
    random = np.random.default_rng(14)
    vertex_order = random.permutation(len(mesh.vertices))
    triangle_order = random.permutation(len(mesh.triangles))
    triangles = np.argsort(vertex_order)[mesh.triangles[triangle_order]][:, [1, 2, 0]]
    shuffled = TriangularMesh(mesh.vertices[vertex_order], triangles,
                             tuple(mesh.triangle_provenance[index] for index in triangle_order))
    assert solid_component_identity(shuffled) == solid.identity
    np.testing.assert_allclose(mass_properties(shuffled, 1).inertia, mass_properties(mesh, 1).inertia, atol=1e-12)


def test_components_cache_reuses_profile_key_and_freezes_loaded_meshes(tmp_path, monkeypatch):
    node = {"kind": "primitive", "nodeId": "sphere", "primitive": "sphere",
            "parameters": {"radius": 1, "segments": 16}}
    snapshot = scene(node)
    cache = FileResourceCache(tmp_path)
    first_service = GeometryService(cache=cache)
    coarse = asyncio.run(first_service.solid_components(snapshot, "body", "m", TriangleMeshingProfile(16)))
    fine = asyncio.run(first_service.solid_components(snapshot, "body", "m", TriangleMeshingProfile(32)))
    assert coarse[0].identity != fine[0].identity
    assert len(coarse[0].mesh.triangles) < len(fine[0].mesh.triangles)
    assert first_service.cached_mesh_count == 2

    def unexpected_compile(*args, **kwargs):
        raise AssertionError("a valid cached component was recompiled")

    monkeypatch.setattr("app.methods.geometry.service._compile_node", unexpected_compile)
    second_service = GeometryService(cache=FileResourceCache(tmp_path))
    loaded = asyncio.run(second_service.solid_components(snapshot, "body", "m", TriangleMeshingProfile(32)))
    assert loaded[0].identity == fine[0].identity
    np.testing.assert_array_equal(loaded[0].mesh.vertices, fine[0].mesh.vertices)
    assert not loaded[0].mesh.vertices.flags.writeable
    assert not loaded[0].mesh.triangles.flags.writeable


@pytest.mark.parametrize("case", ["open", "reversed-face", "reversed-solid", "degenerate", "nonfinite", "empty"])
def test_mass_properties_explicitly_reject_invalid_solid_meshes(case):
    solid, = components(box("box", [1, 1, 1]))
    vertices, triangles = solid.mesh.vertices.copy(), solid.mesh.triangles.copy()
    provenance = solid.mesh.triangle_provenance
    if case == "open":
        triangles, provenance = triangles[:-1], provenance[:-1]
    elif case == "reversed-face":
        triangles[0] = triangles[0, ::-1]
    elif case == "reversed-solid":
        triangles = triangles[:, ::-1]
    elif case == "degenerate":
        triangles[0, 1] = triangles[0, 0]
    elif case == "nonfinite":
        vertices[0, 0] = np.nan
    else:
        triangles, provenance = triangles[:0], ()
    with pytest.raises(ValueError, match="solid mesh"):
        mass_properties(TriangularMesh(vertices, triangles, provenance), 1)


def test_empty_boolean_is_explicitly_rejected():
    node = boolean("empty", "intersect", box("first", [1, 1, 1]), transformed(box("second", [1, 1, 1]), [3, 0, 0]))
    with pytest.raises(ValueError, match="nonempty valid closed solid"):
        components(node)


@pytest.mark.parametrize("density", [0, -1, np.inf, np.nan])
def test_mass_density_requires_positive_finite_value(density):
    solid, = components(box("box", [1, 1, 1]))
    with pytest.raises(ValueError, match="density"):
        mass_properties(solid.mesh, density)


@pytest.mark.parametrize("segments", [True, 3, 4.5, np.inf])
def test_triangle_profile_rejects_invalid_subdivision(segments):
    with pytest.raises(ValueError, match="angular_segments"):
        TriangleMeshingProfile(segments)
