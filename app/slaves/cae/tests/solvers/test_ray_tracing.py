import math

import numpy as np
import pytest

from app.errors import CaeError
from app.solver_framework.geometry import GeometryService, TriangleProvenance, TriangularMesh
from app.solver_framework.models import SolverContext
from app.solvers.ray_tracing.materials import optical_material
from app.solvers.ray_tracing.physics import fresnel_amplitudes, interface_stokes, multilayer_amplitudes
from app.solvers.ray_tracing.solver import (
    EVENT_SURFACE_SCATTER,
    Detector,
    PathCollector,
    Ray,
    ThinStack,
    _collision_scene,
    _continue_interface,
    _cross_medium,
    _is_thin,
    _segment,
    _set_reflection,
    _sources,
    _trace_one,
    run,
)
from app.solvers.ray_tracing.tracing import TriangleMetadata, TriangleScene, counter_random


def optical_descriptor():
    def property_data(unit):
        return {"description": "test", "data": {"dtype": "float64", "unit": unit}}

    return {
        "name": "ray-tracing",
        "version": "0.1.0",
        "referenceLengthUnit": "m",
        "materials": [
            {
                "role": "optical",
                "properties": {
                    "optical.refractive_index": property_data("{fraction}"),
                    "optical.extinction_coefficient": property_data("1"),
                    "optical.absorption_coefficient": property_data("m-1"),
                    "optical.scattering_coefficient": property_data("m-1"),
                },
            }
        ],
    }


def material_entry(value, unit, axes=None):
    descriptor = {"dtype": "float64", "value": value, "unit": unit}
    if axes is not None:
        descriptor["axes"] = axes
    return {"value": descriptor}


def test_normal_incidence_fresnel_and_quarter_wave_stack():
    reflection_s, reflection_p, transmission_s, transmission_p = fresnel_amplitudes(1 + 0j, 1.5 + 0j, 1)
    assert abs(reflection_s) ** 2 == pytest.approx(0.04)
    assert abs(reflection_p) ** 2 == pytest.approx(0.04)
    assert abs(transmission_s) ** 2 == pytest.approx(0.96)
    assert abs(transmission_p) ** 2 == pytest.approx(0.96)

    wavelength = 550e-9
    layer_index = math.sqrt(1.5)
    amplitudes = multilayer_amplitudes(
        1 + 0j,
        [(layer_index + 0j, wavelength / (4 * layer_index))],
        1.5 + 0j,
        wavelength,
        1,
    )
    assert abs(amplitudes[0]) ** 2 < 1e-24
    assert abs(amplitudes[1]) ** 2 < 1e-24

    absorbing = multilayer_amplitudes(
        1 + 0j,
        [(1.5 - 0.1j, 1e-6)],
        1 + 0j,
        wavelength,
        1,
    )
    assert abs(absorbing[0]) ** 2 + abs(absorbing[2]) ** 2 <= 1 + 1e-12
    assert abs(absorbing[1]) ** 2 + abs(absorbing[3]) ** 2 <= 1 + 1e-12

    opaque = multilayer_amplitudes(
        1 + 0j,
        [(1.5 - 3.2j, 49e-6)],
        1 + 0j,
        532e-9,
        1,
    )
    assert all(math.isfinite(abs(value)) for value in opaque)
    assert abs(opaque[0]) ** 2 + abs(opaque[2]) ** 2 <= 1 + 1e-12
    assert abs(opaque[1]) ** 2 + abs(opaque[3]) ** 2 <= 1 + 1e-12

    absorbing_exit = fresnel_amplitudes(0.2 - 3.2j, 1 + 0j, 1)
    assert abs(absorbing_exit[0]) ** 2 + abs(absorbing_exit[2]) ** 2 <= 1 + 1e-12
    assert abs(absorbing_exit[1]) ** 2 + abs(absorbing_exit[3]) ** 2 <= 1 + 1e-12

    stokes = np.asarray([1.0, 0.2, -0.3, 0.1])
    reflected, transmitted, _basis = interface_stokes(
        stokes,
        np.asarray([0.0, 1.0, 0.0]),
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([-1.0, 0.0, 0.0]),
        1 + 0j,
        1.5 + 0j,
    )
    assert np.all(np.isfinite(reflected))
    assert np.all(np.isfinite(transmitted))
    assert reflected[0] + transmitted[0] == pytest.approx(stokes[0])


def test_frequency_material_interpolation_and_no_extrapolation():
    frequency_axis = [
        {
            "length": 2,
            "name": "frequency",
            "ticks": [3e14, 6e14],
            "unit": "Hz",
            "quantityKind": "Frequency",
        }
    ]
    world = {
        "materials": {
            "experiment": {
                "parameters": {
                    "materials": {
                        "Glass": {
                            "optical.refractive_index": material_entry([1.5, 1.7], "{fraction}", frequency_axis),
                            "optical.extinction_coefficient": material_entry([0.0, 0.02], "1", frequency_axis),
                        }
                    }
                }
            }
        }
    }
    wavelength = 299_792_458 / 4.5e14
    material = optical_material(world, optical_descriptor(), "Glass", wavelength)
    assert material.refractive_index == pytest.approx(1.6 - 0.01j)
    assert material.absorption_coefficient == pytest.approx(4 * math.pi * 0.01 / wavelength)

    with pytest.raises(CaeError, match="no sample range") as error:
        optical_material(world, optical_descriptor(), "Glass", 2e-6)
    assert error.value.code == "invalid_material"


def test_triangle_scene_returns_nearest_provenance_and_counter_random_is_stable():
    mesh = TriangularMesh(
        np.asarray([[0, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float64),
        np.asarray([[0, 1, 2]], dtype=np.int64),
        (TriangleProvenance("surface", "triangle", "front"),),
    )
    scene = TriangleScene()
    scene.add_mesh(mesh, TriangleMetadata("solid", "surface", "Glass"))
    scene.build()
    hit = scene.intersect(np.asarray([-1.0, 0.25, 0.25]), np.asarray([1.0, 0.0, 0.0]), 1e-12)
    assert hit is not None
    assert hit.distance == pytest.approx(1)
    assert hit.metadata.root_id == "surface"
    assert hit.barycentric.sum() == pytest.approx(1)
    assert counter_random(7, 1, 2, 3) == counter_random(7, 1, 2, 3)
    assert counter_random(7, 1, 2, 3) != counter_random(7, 1, 2, 4)


def test_recorded_path_is_capped_at_32_segments():
    ray = Ray(
        np.zeros(3),
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([0.0, 1.0, 0.0]),
        np.asarray([1.0, 0.0, 0.0, 0.0]),
        550e-9,
        1.0,
        0,
        vertices=[np.zeros(3)],
    )
    for index in range(40):
        _segment(ray, np.asarray([float(index + 1), 0.0, 0.0]), 0)

    assert len(ray.powers) == 32
    assert len(ray.events) == 32
    assert len(ray.vertices) == 33


def test_detected_power_observation_counts_partially_overlapping_outputs_once():
    mesh = TriangularMesh(
        np.asarray(
            [
                [1.0, -1.0, -1.0],
                [1.0, 1.0, -1.0],
                [1.0, 0.0, 1.0],
                [1.0, 3.0, -1.0],
                [1.0, 5.0, -1.0],
                [1.0, 4.0, 1.0],
            ]
        ),
        np.asarray([[0, 1, 2], [3, 4, 5]]),
        (
            TriangleProvenance("detector", "detector", "first"),
            TriangleProvenance("detector", "detector", "second"),
        ),
    )
    scene = TriangleScene()
    scene.add_mesh(mesh, TriangleMetadata("solid", "detector", "Vacuum"))
    scene.build()
    first = Detector(
        {},
        {("detector", 0)},
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([0.0, 1.0, 0.0]),
        np.asarray([0.0, 0.0, 1.0]),
        -1,
        -1,
        2,
        2,
        (1, 1),
        np.zeros((1, 1)),
    )
    expanded = Detector(
        {},
        {("detector", 0), ("detector", 1)},
        first.normal,
        first.u_axis,
        first.v_axis,
        -1,
        -1,
        6,
        2,
        (1, 1),
        np.zeros((1, 1)),
    )
    ray = Ray(
        np.zeros(3),
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([0.0, 1.0, 0.0]),
        np.asarray([1.0, 0.0, 0.0, 0.0]),
        550e-9,
        1.0,
        0,
    )
    collector = PathCollector(4)
    branches = _trace_one(
        ray,
        scene,
        {"materials": {"experiment": {"parameters": {"materials": {}}}}},
        optical_descriptor(),
        {("detector", 0): [first, expanded]},
        {},
        {},
        4,
        1e-12,
        1e-10,
        7,
        collector,
    )

    assert branches == []
    assert collector.detected_power == pytest.approx(1)
    assert float(np.sum(first.power)) == pytest.approx(1)
    assert float(np.sum(expanded.power)) == pytest.approx(1)


def test_index_matched_boundary_does_not_consume_first_specular_split():
    ray = Ray(
        np.zeros(3),
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([0.0, 1.0, 0.0]),
        np.asarray([1.0, 0.0, 0.0, 0.0]),
        550e-9,
        1.0,
        0,
        vertices=[np.zeros(3)],
    )
    branches = _continue_interface(
        ray,
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([-1.0, 0.0, 0.0]),
        np.zeros(4),
        np.asarray([1.0, 0.0, 0.0, 0.0]),
        np.asarray([-1.0, 0.0, 0.0]),
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([0.0, 1.0, 0.0]),
        None,
        None,
        [],
        None,
        8,
        1e-12,
        1e-9,
        7,
        PathCollector(8),
    )
    assert len(branches) == 1
    assert branches[0].split_done is False

    split = _continue_interface(
        branches[0],
        np.asarray([2.0, 0.0, 0.0]),
        np.asarray([-1.0, 0.0, 0.0]),
        np.asarray([0.25, 0.0, 0.0, 0.0]),
        np.asarray([0.75, 0.0, 0.0, 0.0]),
        np.asarray([-1.0, 0.0, 0.0]),
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([2.0, 0.0, 0.0]),
        np.asarray([0.0, 1.0, 0.0]),
        "Glass",
        "glass",
        [("glass", "Glass")],
        None,
        8,
        1e-12,
        1e-9,
        7,
        PathCollector(8),
    )
    assert len(split) == 2
    assert all(branch.split_done for branch in split)
    assert split[0].path_key != split[1].path_key
    transmitted = next(branch for branch in split if branch.direction[0] > 0)
    assert transmitted.medium_stack == [("glass", "Glass")]
    assert transmitted.medium_name == "Glass"


def test_first_split_respects_maximum_interactions():
    ray = Ray(
        np.zeros(3),
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([0.0, 1.0, 0.0]),
        np.asarray([1.0, 0.0, 0.0, 0.0]),
        550e-9,
        1.0,
        0,
        vertices=[np.zeros(3)],
    )
    collector = PathCollector(8)
    branches = _continue_interface(
        ray,
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([-1.0, 0.0, 0.0]),
        np.asarray([0.25, 0.0, 0.0, 0.0]),
        np.asarray([0.75, 0.0, 0.0, 0.0]),
        np.asarray([-1.0, 0.0, 0.0]),
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([1.0, 0.0, 0.0]),
        np.asarray([0.0, 1.0, 0.0]),
        None,
        None,
        [],
        None,
        1,
        1e-12,
        1e-9,
        7,
        collector,
    )

    assert branches == []
    assert len(collector.paths) == 2


def test_thin_threshold_and_nested_medium_stack_are_exact():
    assert _is_thin(math.nextafter(50e-6, 0))
    assert not _is_thin(50e-6)

    stack = _cross_medium([], None, ("outer", "Outer glass"))
    stack = _cross_medium(stack, None, ("inner", "Inner glass"))
    assert stack == [("outer", "Outer glass"), ("inner", "Inner glass")]
    assert _cross_medium(stack, "inner", None) == [("outer", "Outer glass")]
    assert _cross_medium(_cross_medium(stack, "inner", None), "outer", None) == []
    with pytest.raises(CaeError, match="must not overlap"):
        _cross_medium(stack, "outer", None)
    with pytest.raises(CaeError, match="outside all ray.domain solids"):
        _cross_medium([], "outer", None)


@pytest.mark.asyncio
async def test_shell_threshold_is_strict_and_applied_per_canonical_layer():
    child = {
        "kind": "primitive",
        "nodeId": "layer-child",
        "primitive": "box",
        "parameters": {"size": [1, 1, 1]},
    }
    roots = [
        {
            "id": "thin",
            "materialRole": "body",
            "material": {"name": "Thin"},
            "node": {
                "kind": "shell",
                "nodeId": "thin-stack/$layer-1",
                "innerOffset": 0,
                "outerOffset": 49e-6,
                "child": child,
            },
        },
        {
            "id": "threshold",
            "materialRole": "body",
            "material": {"name": "Threshold"},
            "node": {
                "kind": "transform",
                "nodeId": "threshold-transform",
                "matrix": [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                "child": {
                    "kind": "shell",
                    "nodeId": "threshold-stack/$layer-1",
                    "innerOffset": 0,
                    "outerOffset": 50e-6,
                    "child": child,
                },
            },
        },
        {
            "id": "film-a",
            "materialRole": "body",
            "material": {"name": "Film A"},
            "node": {
                "kind": "shell",
                "nodeId": "multi-stack/$layer-1",
                "innerOffset": 0,
                "outerOffset": 5e-6,
                "child": child,
            },
        },
        {
            "id": "film-b",
            "materialRole": "body",
            "material": {"name": "Film B"},
            "node": {
                "kind": "shell",
                "nodeId": "multi-stack/$layer-2",
                "innerOffset": 5e-6,
                "outerOffset": 10e-6,
                "child": child,
            },
        },
        {
            "id": "anisotropic-edge",
            "materialRole": "body",
            "material": {"name": "Anisotropic edge"},
            "node": {
                "kind": "transform",
                "nodeId": "anisotropic-transform",
                "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1.0000000000009, 0, 0, 0, 0, 1],
                "child": {
                    "kind": "shell",
                    "nodeId": "anisotropic-edge/$layer-1",
                    "innerOffset": 0,
                    "outerOffset": 50e-6 * (1 - 6e-13),
                    "child": child,
                },
            },
        },
    ]
    scene = {
        "geometryFormatVersion": 1,
        "geometryHash": "b" * 64,
        "lengthUnit": "m",
        "roots": roots,
        "geometryGroups": [],
        "surfaceGroups": [],
    }

    async def progress(_value):
        return None

    context = SolverContext({}, None, {}, {"experiment": scene}, GeometryService(), progress, optical_descriptor())
    _collision, meshes, thin = await _collision_scene(context, scene, roots)
    assert set(thin) == {"thin", "film-a", "film-b"}, {
        name: layer.maximum_thickness for name, layer in thin.items()
    }
    assert set(meshes) == {"threshold", "anisotropic-edge"}
    stacks = {
        id(metadata.payload): metadata.payload
        for metadata in _collision._metadata
        if isinstance(metadata.payload, ThinStack)
    }
    assert any([layer.root_id for layer, _material in stack.layers] == ["film-a", "film-b"] for stack in stacks.values())

    millimeter_roots = [
        {
            "id": "exact-mm",
            "materialRole": "body",
            "material": {"name": "Exact"},
            "node": {
                "kind": "shell",
                "nodeId": "exact-mm/$layer-1",
                "innerOffset": 2.0,
                "outerOffset": 2.05,
                "child": child,
            },
        },
        {
            "id": "below-mm",
            "materialRole": "body",
            "material": {"name": "Below"},
            "node": {
                "kind": "shell",
                "nodeId": "below-mm/$layer-1",
                "innerOffset": 2.0,
                "outerOffset": 2.049999999,
                "child": child,
            },
        },
    ]
    millimeter_scene = {
        **scene,
        "geometryHash": "c" * 64,
        "lengthUnit": "mm",
        "roots": millimeter_roots,
    }
    millimeter_context = SolverContext(
        {}, None, {}, {"experiment": millimeter_scene}, GeometryService(), progress, optical_descriptor()
    )
    _collision, millimeter_meshes, millimeter_thin = await _collision_scene(
        millimeter_context, millimeter_scene, millimeter_roots
    )
    assert set(millimeter_thin) == {"below-mm"}
    assert set(millimeter_meshes) == {"exact-mm"}

    reflected_root = {
        "id": "reflected-shell",
        "materialRole": "body",
        "material": {"name": "Film"},
        "node": {
            "kind": "transform",
            "nodeId": "reflection-transform",
            "matrix": [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            "child": {
                "kind": "shell",
                "nodeId": "reflected-shell/$layer-1",
                "innerOffset": 0,
                "outerOffset": 5e-6,
                "child": child,
            },
        },
    }
    reflected_scene = {
        **scene,
        "geometryHash": "d" * 64,
        "roots": [reflected_root],
    }
    reflected_layer = await GeometryService().shell_layer(reflected_scene, "reflected-shell", "m", progress)
    assert reflected_layer is not None
    reflected_triangles = reflected_layer.outer.vertices[reflected_layer.outer.triangles]
    reflected_normals = np.cross(
        reflected_triangles[:, 1] - reflected_triangles[:, 0],
        reflected_triangles[:, 2] - reflected_triangles[:, 0],
    )
    assert np.all(np.einsum("ij,ij->i", reflected_normals, np.mean(reflected_triangles, axis=1)) > 0)


@pytest.mark.asyncio
async def test_reverse_incidence_prefers_coincident_thin_stack_over_substrate_surface():
    child = {
        "kind": "primitive",
        "nodeId": "sphere-child",
        "primitive": "sphere",
        "parameters": {"radius": 1.0, "segments": 32},
    }
    roots = [
        {
            "id": "substrate",
            "materialRole": "body",
            "material": {"name": "Substrate"},
            "node": {
                "kind": "shell",
                "nodeId": "mirror-stack/$layer-1",
                "innerOffset": 0.0,
                "outerOffset": 0.2,
                "child": child,
            },
        },
        {
            "id": "film",
            "materialRole": "body",
            "material": {"name": "Film"},
            "node": {
                "kind": "shell",
                "nodeId": "mirror-stack/$layer-2",
                "innerOffset": 0.2,
                "outerOffset": 0.200005,
                "child": child,
            },
        },
    ]
    scene = {
        "geometryFormatVersion": 1,
        "geometryHash": "e" * 64,
        "lengthUnit": "m",
        "roots": roots,
        "geometryGroups": [],
        "surfaceGroups": [],
    }

    async def progress(_value):
        return None

    context = SolverContext({}, None, {}, {"experiment": scene}, GeometryService(), progress, optical_descriptor())
    collision, _meshes, _thin = await _collision_scene(context, scene, roots)
    for index in range(512):
        z_value = 1 - 2 * (index + 0.5) / 512
        radial = math.sqrt(max(0.0, 1 - z_value * z_value))
        azimuth = index * math.pi * (3 - math.sqrt(5))
        direction = np.asarray([radial * math.cos(azimuth), radial * math.sin(azimuth), z_value])
        hit = collision.intersect(direction * 1.1, direction, 1e-10)
        assert hit is not None
        assert hit.metadata.kind == "thin-stack-left"


@pytest.mark.parametrize("method", ["ray.area-source", "ray.directional-source", "ray.lambertian-source"])
@pytest.mark.asyncio
async def test_surface_source_modes_launch_from_an_outside_domain_locator(method):
    source = {
        "id": "emitter",
        "materialRole": "body",
        "material": {"name": "Vacuum"},
        "node": {
            "kind": "primitive",
            "nodeId": "emitter-box",
            "primitive": "box",
            "parameters": {"size": [0.01, 0.2, 0.2]},
        },
    }
    scene = {
        "geometryFormatVersion": 1,
        "geometryHash": method.encode().hex().ljust(64, "0")[:64],
        "lengthUnit": "m",
        "roots": [source],
        "geometryGroups": [],
        "surfaceGroups": [
            {
                "id": "@surface-group/emitter",
                "name": "emitter",
                "kind": "surface",
                "memberIds": ["emitter/surface/+X"],
                "selectors": [{"rootId": "emitter", "sourceNodeId": "emitter-box", "faceKey": "+X"}],
                "missingMemberIds": [],
            }
        ],
    }
    parameters = {
        "wavelength": {"value": 550e-9},
        "radiantFlux": {"value": 1.0},
        "rayCount": 4,
        "stokes": {"value": [1.0, 0.2, 0.1, 0.0]},
    }
    if method == "ray.lambertian-source":
        parameters["outward"] = True
    else:
        parameters["direction"] = {"value": [1.0, 0.0, 0.0]}
        if method == "ray.area-source":
            parameters["coneHalfAngle"] = {"value": 0.0}
    config = {
        "initializations": [
            {"methodId": method, "target": ["experiment.surface.emitter"], "parameters": parameters}
        ]
    }

    async def progress(_value):
        return None

    context = SolverContext(config, None, {}, {"experiment": scene}, GeometryService(), progress, optical_descriptor())
    rays, total_power = await _sources(context, config, scene, {}, {}, 13, 1e-10)

    assert len(rays) == 4
    assert total_power == pytest.approx(1)
    assert sum(ray.stokes[0] for ray in rays) == pytest.approx(1)
    assert all(np.linalg.norm(ray.direction) == pytest.approx(1) for ray in rays)
    assert all(ray.path_key == ray.source_index for ray in rays)


@pytest.mark.parametrize(
    ("kind", "parameters"),
    [
        ("abg", {"scatterFraction": {"value": 1.0}, "b": {"value": 0.02}, "g": {"value": 1.8}}),
        ("lambertian", {"scatterFraction": {"value": 1.0}}),
    ],
)
def test_surface_scatter_depolarizes_and_marks_the_path(kind, parameters):
    ray = Ray(
        np.zeros(3),
        np.asarray([-1.0, 0.0, 0.0]),
        np.asarray([0.0, 1.0, 0.0]),
        np.asarray([1.0, 0.5, 0.25, 0.1]),
        550e-9,
        1.0,
        3,
        path_key=17,
        vertices=[np.zeros(3), np.asarray([1.0, 0.0, 0.0])],
        powers=[1.0],
        events=[0],
    )
    _set_reflection(
        ray,
        ray.stokes.copy(),
        ray.direction.copy(),
        ray.basis.copy(),
        np.asarray([1.0, 0.0, 0.0]),
        (kind, parameters),
        1e-10,
        7,
    )

    assert ray.events[-1] == EVENT_SURFACE_SCATTER
    assert np.allclose(ray.stokes[1:], 0)
    assert np.linalg.norm(ray.direction) == pytest.approx(1)


@pytest.mark.asyncio
async def test_point_source_reaches_detector_and_returns_path_bundle():
    source_node = {
        "kind": "primitive",
        "nodeId": "source-box",
        "primitive": "box",
        "parameters": {"size": [0.01, 0.01, 0.01]},
    }
    detector_node = {
        "kind": "transform",
        "nodeId": "detector-transform",
        "matrix": [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        "child": {
            "kind": "primitive",
            "nodeId": "detector-box",
            "primitive": "box",
            "parameters": {"size": [0.01, 0.2, 0.2]},
        },
    }
    roots = [
        {
            "id": "source",
            "materialRole": "body",
            "material": {"name": "Vacuum"},
            "node": source_node,
        },
        {
            "id": "detector",
            "materialRole": "body",
            "material": {"name": "Vacuum"},
            "node": detector_node,
        },
    ]
    scene = {
        "geometryFormatVersion": 1,
        "geometryHash": "a" * 64,
        "lengthUnit": "m",
        "roots": roots,
        "geometryGroups": [
            {
                "id": "@geometry-group/domain",
                "name": "domain",
                "kind": "geometry",
                "memberIds": ["detector"],
                "rootIds": ["detector"],
                "missingMemberIds": [],
            },
            {
                "id": "@geometry-group/source",
                "name": "source",
                "kind": "geometry",
                "memberIds": ["source"],
                "rootIds": ["source"],
                "missingMemberIds": [],
            },
        ],
        "surfaceGroups": [
            {
                "id": "@surface-group/detector",
                "name": "detector",
                "kind": "surface",
                "memberIds": ["detector/surface/-X"],
                "selectors": [{"rootId": "detector", "sourceNodeId": "detector-box", "faceKey": "-X"}],
                "missingMemberIds": [],
            }
        ],
    }
    material = {
        "optical.refractive_index": material_entry(1.0, "{fraction}"),
        "optical.extinction_coefficient": material_entry(0.0, "1"),
    }
    world = {
        "experiment": scene,
        "materials": {
            "experiment": {"parameters": {"schemaVersion": 1, "materials": {"Vacuum": material}}, "warnings": []}
        },
    }
    config = {
        "parameters": {"seed": 7, "maxInteractions": 8, "minPowerFraction": {"value": 1e-12}, "maxPaths": 16},
        "initializations": [
            {"methodId": "ray.domain", "target": ["experiment.geometry.domain"], "parameters": {}},
            {
                "methodId": "ray.point-source",
                "target": ["experiment.geometry.source"],
                "parameters": {
                    "wavelength": {"value": 550e-9},
                    "radiantFlux": {"value": 1.0},
                    "rayCount": 4,
                    "stokes": {"value": [1, 0, 0, 0]},
                    "direction": {"value": [1, 0, 0]},
                    "coneHalfAngle": {"value": 0.0},
                },
            },
        ],
        "boundaryConditions": [],
        "outputs": [
            {
                "key": "power",
                "methodId": "ray.detector-power",
                "target": ["experiment.surface.detector"],
                "parameters": {},
            },
            {
                "key": "efficiency",
                "methodId": "ray.detector-efficiency",
                "target": ["experiment.surface.detector"],
                "parameters": {},
            },
        ],
    }

    async def progress(_value):
        return None

    context = SolverContext(config, None, {}, world, GeometryService(), progress, optical_descriptor())
    result = await run(context)
    assert result["artifacts"]["power"]["value"] == pytest.approx(1.0)
    assert result["artifacts"]["efficiency"]["value"] == pytest.approx(1.0)
    assert result["observations"]["detectedPower"] == pytest.approx(1.0)
    paths = result["state"]["rayPaths"]
    assert paths["vertices"]["value"].shape[1] == 3
    assert paths["pathOffsets"]["value"][-1] == len(paths["vertices"]["value"])
    assert len(paths["segmentPower"]["value"]) == len(paths["segmentEvent"]["value"])
    assert len(paths["pathWavelength"]["value"]) == len(paths["pathOffsets"]["value"]) - 1

    source_mesh = await context.geometry.triangular_mesh(scene, "source", "m", progress)
    with pytest.raises(CaeError, match="outside ray.domain"):
        await _sources(context, config, scene, {"source": source_mesh}, {}, 7, 1e-10)
