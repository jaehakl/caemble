from __future__ import annotations

import asyncio
from itertools import combinations

import numpy as np
import pytest

from app.kernel.resources import FileResourceCache
from app.methods.geometry import GeometryService
from app.methods.mesh import VolumeMeshingProfile
from app.methods.mesh.tetrahedral import refine_surface_mesh, triangulate_planar_domains


def _box_node(node_id: str, size: float = 1.0) -> dict[str, object]:
    return {
        "kind": "primitive",
        "nodeId": node_id,
        "primitive": "box",
        "parameters": {"size": [size, size, size]},
    }


def _translated_box(
    root_id: str,
    translation_x: float,
    translation_y: float = 0.0,
    translation_z: float = 0.0,
) -> dict[str, object]:
    return {
        "id": root_id,
        "node": {
            "kind": "transform",
            "nodeId": f"{root_id}-transform",
            "matrix": [
                1, 0, 0, translation_x,
                0, 1, 0, translation_y,
                0, 0, 1, translation_z,
                0, 0, 0, 1,
            ],
            "child": _box_node(f"{root_id}-box"),
        },
    }


def _scene(geometry_hash: str, roots: list[dict[str, object]]) -> dict[str, object]:
    return {
        "geometryHash": geometry_hash,
        "lengthUnit": "m",
        "roots": roots,
        "geometryGroups": [],
        "surfaceGroups": [],
    }


@pytest.mark.parametrize(
    ("arguments", "message"),
    [
        ({"max_element_size": 0}, "max_element_size"),
        ({"max_element_size": 1, "boundary_max_element_size": -1}, "boundary_max"),
        ({"max_element_size": 1, "optimization_steps": True}, "optimization_steps"),
        ({"max_element_size": 1, "minimum_quality": 1.1}, "minimum_quality"),
    ],
)
def test_volume_meshing_profile_rejects_invalid_controls(
    arguments: dict[str, object], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        VolumeMeshingProfile(**arguments)


def test_impractically_fine_volume_resolution_fails_before_netgen_allocation() -> None:
    scene = _scene("volume-resource-budget-v1", [{"id": "tiny", "node": _box_node("box", 0.01)}])

    with pytest.raises(RuntimeError, match="estimated minimum.*resource budget.*max_element_size"):
        asyncio.run(GeometryService().volume_mesh(
            scene,
            ("tiny",),
            "m",
            VolumeMeshingProfile(1e-6, boundary_max_element_size=1.0),
        ))


def test_surface_refinement_is_conforming_and_preserves_markers() -> None:
    points = np.asarray([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], dtype=float)
    faces = np.asarray([[0, 1, 2], [0, 2, 3]])
    markers = np.asarray([4, 9])

    refined_points, refined_faces, refined_markers = refine_surface_mesh(
        points, faces, markers, 0.5
    )

    edges = {
        tuple(sorted((int(face[start]), int(face[end]))))
        for face in refined_faces
        for start, end in ((0, 1), (1, 2), (2, 0))
    }
    assert max(
        np.linalg.norm(refined_points[start] - refined_points[end])
        for start, end in edges
    ) <= 0.5
    assert set(refined_markers) == {4, 9}
    shared_edges = {
        edge
        for edge in edges
        if sum(edge[0] in face and edge[1] in face for face in refined_faces) == 2
    }
    assert shared_edges


def test_planar_domain_arrangement_retains_mismatched_boundary_subdivisions() -> None:
    left = np.asarray([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=float)
    right = np.asarray([[1, 0], [2, 0], [2, 1], [1, 1]], dtype=float)
    required = np.asarray(
        [[0, 0.5], [1, 0.25], [1, 0.75], [2, 0.5]],
        dtype=float,
    )

    points, triangles, domains = triangulate_planar_domains(
        ((left,), (right,)),
        required,
        1e-12,
        0.5,
        0.3,
        1,
    )

    assert set(domains) == {0, 1}
    for required_point in required:
        assert np.any(np.all(np.isclose(points, required_point, atol=1e-12), axis=1))
    edge_domains: dict[tuple[int, int], set[int]] = {}
    for triangle, domain in zip(triangles, domains, strict=True):
        for start, end in ((0, 1), (1, 2), (2, 0)):
            edge = tuple(sorted((int(triangle[start]), int(triangle[end]))))
            edge_domains.setdefault(edge, set()).add(int(domain))
    shared = [
        edge
        for edge, adjacent_domains in edge_domains.items()
        if adjacent_domains == {0, 1}
    ]
    assert shared
    assert all(np.allclose(points[list(edge), 0], 1) for edge in shared)

    translation = np.asarray([1e9, -1e9])
    translated_points, translated_triangles, translated_domains = triangulate_planar_domains(
        ((left + translation,), (right + translation,)),
        required + translation,
        1e-6,
        0.5,
        0.3,
        1,
    )
    np.testing.assert_allclose(translated_points - translation, points, rtol=0, atol=1e-7)
    np.testing.assert_array_equal(translated_triangles, triangles)
    np.testing.assert_array_equal(translated_domains, domains)


def test_box_volume_mesh_preserves_boundary_provenance_quality_and_cache(tmp_path) -> None:
    scene = _scene("volume-box-cache-v1", [{"id": "solid", "node": _box_node("box")}])
    profile = VolumeMeshingProfile(0.5, boundary_max_element_size=0.5)
    first_cache = FileResourceCache(tmp_path)

    first = asyncio.run(GeometryService(cache=first_cache).volume_mesh(
        scene, ("solid",), "m", profile
    ))

    assert first.cells.shape[1] == 4
    assert first.region_ids == ("solid",)
    assert set(first.cell_region_ids) == {0}
    assert np.isclose(np.sum(first.quality.cell_volumes), 1.0)
    assert first.quality.minimum_mean_ratio > 0
    assert all(len(aliases) == 1 for aliases in first.boundary_provenance)
    assert {aliases[0].source_node_id for aliases in first.boundary_provenance} == {"box"}
    boundary_edges = first.points[first.boundary_faces][:, [1, 2, 0]] - first.points[
        first.boundary_faces
    ]
    assert np.max(np.linalg.norm(boundary_edges, axis=2)) <= 0.5
    assert first.boundary_face_indices(
        {"rootId": "solid", "sourceNodeId": "box", "surfaceIndex": 0}
    ).size > 0
    assert first.boundary_node_indices(
        {"rootId": "solid", "sourceNodeId": "box", "surfaceIndex": 0}
    ).size > 0
    assert first.region_cell_indices("solid").size == first.cells.shape[0]
    assert first_cache.stats().entry_count == 2
    cell_faces = {
        tuple(sorted(face)): cell_index
        for cell_index, cell in enumerate(first.cells)
        for face in combinations((int(vertex) for vertex in cell), 3)
    }
    for face in first.boundary_faces:
        face_points = first.points[face]
        normal = np.cross(face_points[1] - face_points[0], face_points[2] - face_points[0])
        cell_center = np.mean(first.points[first.cells[cell_faces[tuple(sorted(face))]]], axis=0)
        assert np.dot(normal, cell_center - np.mean(face_points, axis=0)) < 0

    second_cache = FileResourceCache(tmp_path)
    second = asyncio.run(GeometryService(cache=second_cache).volume_mesh(
        scene, ("solid",), "m", profile
    ))

    assert second_cache.stats().hits == 1
    np.testing.assert_array_equal(second.points, first.points)
    np.testing.assert_array_equal(second.cells, first.cells)
    np.testing.assert_array_equal(second.boundary_faces, first.boundary_faces)
    np.testing.assert_array_equal(second.cell_region_ids, first.cell_region_ids)
    np.testing.assert_array_equal(second.quality.mean_ratios, first.quality.mean_ratios)
    assert second.boundary_provenance == first.boundary_provenance
    assert not second.points.flags.writeable
    assert not second.cells.flags.writeable
    assert not second.quality.mean_ratios.flags.writeable

    with pytest.raises(RuntimeError, match="minimum mean-ratio quality"):
        asyncio.run(GeometryService().volume_mesh(
            scene,
            ("solid",),
            "m",
            VolumeMeshingProfile(0.5, minimum_quality=0.99),
        ))


def test_boolean_cavity_is_not_filled_and_keeps_cut_surface_labels() -> None:
    scene = _scene(
        "volume-cavity-v1",
        [
            {
                "id": "hollow",
                "node": {
                    "kind": "boolean",
                    "nodeId": "subtract",
                    "operation": "subtract",
                    "children": [_box_node("outer", 3.0), _box_node("hole", 1.0)],
                },
            }
        ],
    )

    mesh = asyncio.run(GeometryService().volume_mesh(
        scene, ("hollow",), "m", VolumeMeshingProfile(1.0)
    ))

    cell_centers = np.mean(mesh.points[mesh.cells], axis=1)
    assert not np.any(np.all(np.abs(cell_centers) < 0.5, axis=1))
    assert np.isclose(np.sum(mesh.quality.cell_volumes), 26.0)
    assert {
        provenance.source_node_id
        for aliases in mesh.boundary_provenance
        for provenance in aliases
    } == {"outer", "hole"}


def test_cylindrical_boolean_hole_is_quality_remeshed_without_losing_its_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scene = _scene(
        "volume-cylindrical-hole-v1",
        [
            {
                "id": "body",
                "node": {
                    "kind": "boolean",
                    "nodeId": "subtract",
                    "operation": "subtract",
                    "children": [
                        {
                            "kind": "transform",
                            "nodeId": "plate-transform",
                            "matrix": [
                                1, 0, 0, 0.5,
                                0, 1, 0, 0,
                                0, 0, 1, 0,
                                0, 0, 0, 1,
                            ],
                            "child": {
                                "kind": "primitive",
                                "nodeId": "plate",
                                "primitive": "box",
                                "parameters": {"size": [1.0, 0.6, 0.2]},
                            },
                        },
                        {
                            "kind": "transform",
                            "nodeId": "hole-transform",
                            "matrix": [
                                1, 0, 0, 0.55,
                                0, 1, 0, 0,
                                0, 0, 1, 0,
                                0, 0, 0, 1,
                            ],
                            "child": {
                                "kind": "primitive",
                                "nodeId": "hole",
                                "primitive": "cylinder",
                                "parameters": {
                                    "radius": 0.1,
                                    "radius_2": 0.1,
                                    "height": 0.4,
                                    "segments": 128,
                                },
                            },
                        },
                    ],
                },
            }
        ],
    )

    mesh = asyncio.run(GeometryService().volume_mesh(
        scene, ("body",), "m", VolumeMeshingProfile(0.15)
    ))

    expected_volume = 1.0 * 0.6 * 0.2 - 128 * np.sin(2 * np.pi / 128) * 0.1**2 * 0.2 / 2
    assert np.isclose(np.sum(mesh.quality.cell_volumes), expected_volume)
    centroids = np.mean(mesh.points[mesh.cells], axis=1)
    assert not np.any(np.sum((centroids[:, :2] - [0.55, 0]) ** 2, axis=1) < 0.1**2)
    assert mesh.quality.minimum_mean_ratio > 0
    assert {
        provenance.source_node_id
        for aliases in mesh.boundary_provenance
        for provenance in aliases
    } == {"plate", "hole"}
    boundary_edges = mesh.points[mesh.boundary_faces][:, [1, 2, 0]] - mesh.points[
        mesh.boundary_faces
    ]
    assert np.max(np.linalg.norm(boundary_edges, axis=2)) <= 0.15 * (1 + 1e-12)

    def fail_if_planar_remeshing_starts(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("planar remeshing started before the resolution preflight")

    monkeypatch.setattr(
        "app.methods.geometry.service.triangulate_planar_patch",
        fail_if_planar_remeshing_starts,
    )
    with pytest.raises(RuntimeError, match="coordinate-precision.*increase"):
        asyncio.run(GeometryService().volume_mesh(
            scene, ("body",), "m", VolumeMeshingProfile(1e-200)
        ))


def test_bonded_roots_share_one_interface_with_both_provenance_aliases() -> None:
    scene = _scene(
        "volume-bonded-boxes-v1",
        [_translated_box("left", -0.5), _translated_box("right", 0.5)],
    )

    mesh = asyncio.run(GeometryService().volume_mesh(
        scene, ("left", "right"), "m", VolumeMeshingProfile(0.6)
    ))

    assert set(mesh.cell_region_ids) == {0, 1}
    assert np.isclose(np.sum(mesh.quality.cell_volumes), 2.0)
    interface = np.asarray(
        [index for index, aliases in enumerate(mesh.boundary_provenance) if len(aliases) == 2],
        dtype=np.int64,
    )
    assert interface.size > 0
    assert all(
        tuple(provenance.root_id for provenance in mesh.boundary_provenance[index])
        == ("left", "right")
        for index in interface
    )
    assert np.all(mesh.points[mesh.boundary_faces[interface], 0] == 0)

    face_to_cells: dict[tuple[int, int, int], list[int]] = {}
    for cell_index, cell in enumerate(mesh.cells):
        for face in combinations((int(vertex) for vertex in cell), 3):
            face_to_cells.setdefault(tuple(sorted(face)), []).append(cell_index)
    for face in mesh.boundary_faces[interface]:
        adjacent = face_to_cells[tuple(sorted(int(vertex) for vertex in face))]
        assert len(adjacent) == 2
        assert {int(mesh.cell_region_ids[index]) for index in adjacent} == {0, 1}
        face_points = mesh.points[face]
        face_center = np.mean(face_points, axis=0)
        normal = np.cross(face_points[1] - face_points[0], face_points[2] - face_points[0])
        dominant_cell = next(index for index in adjacent if mesh.cell_region_ids[index] == 0)
        opposite_cell = next(index for index in adjacent if mesh.cell_region_ids[index] == 1)
        dominant_direction = (
            np.mean(mesh.points[mesh.cells[dominant_cell]], axis=0) - face_center
        )
        opposite_direction = (
            np.mean(mesh.points[mesh.cells[opposite_cell]], axis=0) - face_center
        )
        assert np.dot(normal, dominant_direction) < 0
        assert np.dot(normal, opposite_direction) > 0

    left_selector = {"rootId": "left", "sourceNodeId": "left-box", "surfaceIndex": 1}
    right_selector = {"rootId": "right", "sourceNodeId": "right-box", "surfaceIndex": 0}
    np.testing.assert_array_equal(
        mesh.boundary_face_indices(left_selector),
        mesh.boundary_face_indices(right_selector),
    )


def test_bonded_interface_welds_equivalent_floating_point_coordinates() -> None:
    roots: list[dict[str, object]] = []
    for index, center_z in enumerate((0.1, 0.3)):
        roots.append({
            "id": f"layer-{index}",
            "node": {
                "kind": "transform",
                "nodeId": f"layer-{index}-transform",
                "matrix": [
                    1, 0, 0, 0,
                    0, 1, 0, 0,
                    0, 0, 1, center_z,
                    0, 0, 0, 1,
                ],
                "child": {
                    "kind": "primitive",
                    "nodeId": f"layer-{index}-box",
                    "primitive": "box",
                    "parameters": {"size": [1.0, 0.4, 0.2]},
                },
            },
        })
    scene = _scene("volume-rounded-layer-interface-v1", roots)

    mesh = asyncio.run(GeometryService().volume_mesh(
        scene, ("layer-0", "layer-1"), "m", VolumeMeshingProfile(0.12)
    ))

    assert np.isclose(np.sum(mesh.quality.cell_volumes), 0.16)
    interface = [aliases for aliases in mesh.boundary_provenance if len(aliases) == 2]
    assert interface
    assert all(
        {alias.root_id for alias in aliases} == {"layer-0", "layer-1"}
        for aliases in interface
    )


def test_bonded_partial_planar_patch_is_overlaid_on_the_host_surface() -> None:
    scene = _scene(
        "volume-partial-interface-v1",
        [
            {"id": "large", "node": _box_node("large-box", 2.0)},
            {
                "id": "small",
                "node": {
                    "kind": "transform",
                    "nodeId": "small-transform",
                    "matrix": [
                        1, 0, 0, 0,
                        0, 1, 0, 0,
                        0, 0, 1, 1.5,
                        0, 0, 0, 1,
                    ],
                    "child": _box_node("small-box"),
                },
            },
        ],
    )

    mesh = asyncio.run(GeometryService().volume_mesh(
        scene, ("large", "small"), "m", VolumeMeshingProfile(0.5)
    ))

    assert np.isclose(np.sum(mesh.quality.cell_volumes), 9.0)
    interface = np.asarray(
        [index for index, aliases in enumerate(mesh.boundary_provenance) if len(aliases) == 2]
    )
    exposed_host = np.asarray(
        [
            index
            for index, aliases in enumerate(mesh.boundary_provenance)
            if len(aliases) == 1
            and aliases[0].root_id == "large"
            and aliases[0].surface_index == 5
        ]
    )
    assert np.all(mesh.points[mesh.boundary_faces[interface], 2] == 1)
    assert {
        tuple(provenance.root_id for provenance in mesh.boundary_provenance[index])
        for index in interface
    } == {("large", "small")}
    interface_triangles = mesh.points[mesh.boundary_faces[interface]]
    exposed_triangles = mesh.points[mesh.boundary_faces[exposed_host]]
    assert np.isclose(
        np.sum(
            np.linalg.norm(
                np.cross(
                    interface_triangles[:, 1] - interface_triangles[:, 0],
                    interface_triangles[:, 2] - interface_triangles[:, 0],
                ),
                axis=1,
            )
            / 2
        ),
        1.0,
    )
    assert np.isclose(
        np.sum(
            np.linalg.norm(
                np.cross(
                    exposed_triangles[:, 1] - exposed_triangles[:, 0],
                    exposed_triangles[:, 2] - exposed_triangles[:, 0],
                ),
                axis=1,
            )
            / 2
        ),
        3.0,
    )


def test_planar_bond_with_a_hole_preserves_interface_and_exposed_regions() -> None:
    lower_box = {
        "kind": "transform",
        "nodeId": "lower-transform",
        "matrix": [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, -0.1,
            0, 0, 0, 1,
        ],
        "child": {
            "kind": "primitive",
            "nodeId": "lower-box",
            "primitive": "box",
            "parameters": {"size": [1.0, 1.0, 0.2]},
        },
    }
    hole = {
        "kind": "primitive",
        "nodeId": "lower-hole",
        "primitive": "cylinder",
        "parameters": {
            "radius": 0.2,
            "radius_2": 0.2,
            "height": 0.4,
            "segments": 32,
        },
    }
    upper = {
        "id": "upper",
        "node": {
            "kind": "transform",
            "nodeId": "upper-transform",
            "matrix": [
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0.1,
                0, 0, 0, 1,
            ],
            "child": {
                "kind": "primitive",
                "nodeId": "upper-box",
                "primitive": "box",
                "parameters": {"size": [1.0, 1.0, 0.2]},
            },
        },
    }
    scene = _scene(
        "volume-planar-hole-interface-v1",
        [
            {
                "id": "lower",
                "node": {
                    "kind": "boolean",
                    "nodeId": "lower-subtract",
                    "operation": "subtract",
                    "children": [lower_box, hole],
                },
            },
            upper,
        ],
    )

    mesh = asyncio.run(GeometryService().volume_mesh(
        scene, ("lower", "upper"), "m", VolumeMeshingProfile(0.3)
    ))

    polygon_hole_area = 32 * np.sin(2 * np.pi / 32) * 0.2**2 / 2
    assert np.isclose(np.sum(mesh.quality.cell_volumes), 0.4 - 0.2 * polygon_hole_area)
    interface_indices = np.asarray(
        [index for index, aliases in enumerate(mesh.boundary_provenance) if len(aliases) == 2],
        dtype=np.int64,
    )
    interface_triangles = mesh.points[mesh.boundary_faces[interface_indices]]
    interface_area = np.sum(np.linalg.norm(np.cross(
        interface_triangles[:, 1] - interface_triangles[:, 0],
        interface_triangles[:, 2] - interface_triangles[:, 0],
    ), axis=1)) / 2
    assert np.isclose(interface_area, 1.0 - polygon_hole_area)
    exposed_upper = np.asarray([
        index
        for index, aliases in enumerate(mesh.boundary_provenance)
        if len(aliases) == 1
        and aliases[0].root_id == "upper"
        and np.allclose(mesh.points[mesh.boundary_faces[index], 2], 0)
    ])
    exposed_triangles = mesh.points[mesh.boundary_faces[exposed_upper]]
    exposed_area = np.sum(np.linalg.norm(np.cross(
        exposed_triangles[:, 1] - exposed_triangles[:, 0],
        exposed_triangles[:, 2] - exposed_triangles[:, 0],
    ), axis=1)) / 2
    assert np.isclose(exposed_area, polygon_hole_area)


def test_volume_mesh_rejects_roots_with_overlapping_interiors() -> None:
    scene = _scene(
        "volume-overlap-v1",
        [_translated_box("first", 0), _translated_box("second", 0.5)],
    )

    with pytest.raises(ValueError, match="overlapping interiors"):
        asyncio.run(GeometryService().volume_mesh(
            scene, ("first", "second"), "m", VolumeMeshingProfile(0.5)
        ))


@pytest.mark.parametrize(
    "translation",
    [(1.0, 1.0, 0.0), (1.0, 1.0, 1.0)],
    ids=["edge", "point"],
)
def test_volume_mesh_rejects_edge_or_point_only_root_contact(
    translation: tuple[float, float, float],
) -> None:
    scene = _scene(
        f"volume-{translation}-contact-v1",
        [
            _translated_box("first", 0),
            _translated_box("second", *translation),
        ],
    )

    with pytest.raises(ValueError, match="edge or point.*local positive-area"):
        asyncio.run(GeometryService().volume_mesh(
            scene, ("first", "second"), "m", VolumeMeshingProfile(0.5)
        ))


def test_volume_mesh_allows_three_region_t_junction_with_local_interfaces() -> None:
    scene = _scene(
        "volume-three-region-t-junction-v1",
        [
            _translated_box("left", -1),
            _translated_box("center", 0),
            _translated_box("top", 0, 1),
        ],
    )

    mesh = asyncio.run(GeometryService().volume_mesh(
        scene,
        ("left", "center", "top"),
        "m",
        VolumeMeshingProfile(0.5),
    ))

    nodes_by_region = [
        set(np.unique(mesh.cells[mesh.cell_region_ids == region]).tolist())
        for region in range(3)
    ]
    assert nodes_by_region[0] & nodes_by_region[1] & nodes_by_region[2]
    interface_root_pairs = {
        frozenset(alias.root_id for alias in aliases)
        for aliases in mesh.boundary_provenance
        if len(aliases) == 2
    }
    assert interface_root_pairs == {
        frozenset(("left", "center")),
        frozenset(("center", "top")),
    }


def test_edge_only_contact_is_rejected_even_when_roots_bond_elsewhere() -> None:
    first_components = [
        _translated_box("first-face", 0)["node"],
        _translated_box("first-edge", 0, 3)["node"],
    ]
    second_components = [
        _translated_box("second-face", 1)["node"],
        _translated_box("second-edge", 1, 4)["node"],
    ]
    scene = _scene(
        "volume-interface-locality-v1",
        [
            {
                "id": "first",
                "node": {
                    "kind": "boolean",
                    "nodeId": "first-union",
                    "operation": "union",
                    "children": first_components,
                },
            },
            {
                "id": "second",
                "node": {
                    "kind": "boolean",
                    "nodeId": "second-union",
                    "operation": "union",
                    "children": second_components,
                },
            },
        ],
    )

    with pytest.raises(ValueError, match="edge or point.*local positive-area"):
        asyncio.run(GeometryService().volume_mesh(
            scene, ("first", "second"), "m", VolumeMeshingProfile(0.5)
        ))
