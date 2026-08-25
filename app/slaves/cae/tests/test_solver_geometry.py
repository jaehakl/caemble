import copy
from collections import Counter

import pytest

import app.solver_framework.geometry.service as geometry_service_module
from app.errors import CaeError
from app.solver_framework.geometry import (
    GeometryService,
    canonical_geometry_hash,
    validate_canonical_geometry_scene,
)


def canonical_scene(node, *, selectors=()):
    draft = {
        "geometryFormatVersion": 1,
        "lengthUnit": "m",
        "roots": [{"id": "body", "materialRole": "body", "node": node}],
        "geometryGroups": [
            {
                "id": "@geometry-group/body",
                "name": "body",
                "kind": "geometry",
                "memberIds": ["body"],
                "rootIds": ["body"],
                "missingMemberIds": [],
            }
        ],
        "surfaceGroups": [
            {
                "id": "@surface-group/terminals",
                "name": "terminals",
                "kind": "surface",
                "memberIds": [
                    f"{selector['sourceNodeId']}/surface/{selector['faceKey']}"
                    for selector in selectors
                ],
                "selectors": list(selectors),
                "missingMemberIds": [],
            }
        ],
    }
    return {**draft, "geometryHash": canonical_geometry_hash(draft)}


def box_node(node_id="box"):
    return {
        "kind": "primitive",
        "nodeId": node_id,
        "primitive": "box",
        "parameters": {"size": [2, 4, 6]},
    }


def test_canonical_geometry_scene_v1_validates_exact_schema_and_semantic_selectors():
    selector = {"rootId": "body", "sourceNodeId": "box", "faceKey": "-X"}
    scene = canonical_scene(box_node(), selectors=(selector,))

    validate_canonical_geometry_scene(scene, "scene")

    with pytest.raises(CaeError, match="ordinal /surface-N"):
        invalid = canonical_scene(box_node())
        invalid["surfaceGroups"][0]["memberIds"] = ["box/surface-0"]
        validate_canonical_geometry_scene(invalid, "scene")
    with pytest.raises(CaeError, match="CanonicalGeometrySceneV1"):
        validate_canonical_geometry_scene({"parts": [], "sceneHash": "0" * 64}, "scene")


def test_canonical_geometry_rejects_non_scalar_unicode_and_oversized_json_numbers():
    invalid_unicode = canonical_scene(box_node())
    invalid_unicode["roots"][0]["id"] = "\ud800"
    with pytest.raises(CaeError, match="non-empty string") as unicode_error:
        validate_canonical_geometry_scene(invalid_unicode, "scene")
    assert unicode_error.value.code == "invalid_input"

    oversized_number = canonical_scene(box_node())
    oversized_number["roots"][0]["node"]["parameters"]["size"][0] = 10**400
    with pytest.raises(CaeError, match="finite number") as number_error:
        validate_canonical_geometry_scene(oversized_number, "scene")
    assert number_error.value.code == "invalid_input"

    rounded_integer = canonical_scene(box_node())
    rounded_integer["roots"][0]["node"]["parameters"]["size"][0] = 205798368543330730000
    rounded_draft = {key: value for key, value in rounded_integer.items() if key != "geometryHash"}
    rounded_integer["geometryHash"] = canonical_geometry_hash(rounded_draft)
    validate_canonical_geometry_scene(rounded_integer, "scene")
    assert canonical_geometry_hash({"value": 205798368543330730000}) == (
        "724e9864c175a7cf43b5e437d5b704eca0ce734527a059c7b46550e7d280674e"
    )


def test_cylinder_cap_faces_follow_nonzero_endpoint_radii():
    cone = {
        "kind": "primitive",
        "nodeId": "cone",
        "primitive": "cylinder",
        "parameters": {"radius": 2, "radius_2": 0, "height": 1, "segments": 16},
    }
    validate_canonical_geometry_scene(
        canonical_scene(
            cone,
            selectors=({"rootId": "body", "sourceNodeId": "cone", "faceKey": "Bottom"},),
        ),
        "scene",
    )
    with pytest.raises(CaeError, match="does not identify a semantic leaf face"):
        validate_canonical_geometry_scene(
            canonical_scene(
                cone,
                selectors=({"rootId": "body", "sourceNodeId": "cone", "faceKey": "Top"},),
            ),
            "scene",
        )


def test_geometry_service_exposes_tree_queries_without_meshing():
    selector = {"rootId": "body", "sourceNodeId": "box", "faceKey": "+X"}
    scene = canonical_scene(box_node(), selectors=(selector,))
    geometry = GeometryService()

    immutable_scene = geometry.scene(scene)
    assert geometry.root(scene, "body")["node"]["primitive"] == "box"
    assert geometry.geometry_group(scene, "body")["rootIds"] == ("body",)
    assert geometry.surface_group(scene, "terminals")["kind"] == "surface"
    assert geometry.selectors(scene, "terminals")[0]["faceKey"] == "+X"
    assert geometry.cached_mesh_count == 0
    with pytest.raises(TypeError):
        immutable_scene["lengthUnit"] = "mm"


def test_canonical_groups_reject_forged_resolution_divergence():
    selector = {"rootId": "body", "sourceNodeId": "box", "faceKey": "-X"}
    cases = []

    scene = canonical_scene(box_node(), selectors=(selector,))
    scene["geometryGroups"].append({**scene["geometryGroups"][0], "id": "duplicate-geometry-name"})
    cases.append(scene)

    scene = canonical_scene(box_node(), selectors=(selector,))
    scene["geometryGroups"][0]["missingMemberIds"] = ["not-a-member"]
    cases.append(scene)

    scene = canonical_scene(box_node(), selectors=(selector,))
    scene["surfaceGroups"].append({**scene["surfaceGroups"][0], "id": "duplicate-surface-name"})
    cases.append(scene)

    scene = canonical_scene(box_node(), selectors=(selector,))
    scene["surfaceGroups"][0]["missingMemberIds"] = ["not-a-member"]
    cases.append(scene)

    scene = canonical_scene(box_node(), selectors=(selector,))
    scene["surfaceGroups"][0]["selectors"] = []
    cases.append(scene)

    scene = canonical_scene(box_node(), selectors=(selector,))
    scene["surfaceGroups"][0]["selectors"][0] = {
        "rootId": "body",
        "sourceNodeId": "box",
        "faceKey": "+X",
    }
    cases.append(scene)

    for invalid in cases:
        with pytest.raises(CaeError) as error:
            validate_canonical_geometry_scene(invalid, "scene")
        assert error.value.code == "invalid_input"


def test_shell_root_member_alias_is_exact_and_duplicate_selectors_are_rejected():
    shell = {
        "kind": "shell",
        "nodeId": "coating",
        "innerOffset": 0,
        "outerOffset": 0.25,
        "child": box_node(),
    }
    selector = {"rootId": "body", "sourceNodeId": "coating", "faceKey": "inner"}
    scene = canonical_scene(shell, selectors=(selector,))
    scene["surfaceGroups"][0]["memberIds"] = ["body/surface/inner"]
    draft = {key: value for key, value in scene.items() if key != "geometryHash"}
    scene["geometryHash"] = canonical_geometry_hash(draft)
    validate_canonical_geometry_scene(scene, "scene")

    duplicate = copy.deepcopy(scene)
    duplicate["surfaceGroups"][0]["memberIds"] = ["body/surface/inner", "coating/surface/inner"]
    duplicate["surfaceGroups"][0]["selectors"] = [selector, selector]
    with pytest.raises(CaeError, match="must not contain duplicates"):
        validate_canonical_geometry_scene(duplicate, "scene")


@pytest.mark.asyncio
async def test_triangular_mesh_is_indexed_unit_scaled_and_semantically_provenanced():
    scene = canonical_scene(box_node())
    geometry = GeometryService()

    mesh = await geometry.triangular_mesh(scene, "body", "mm")

    assert mesh.vertices.shape == (8, 3)
    assert mesh.triangles.shape == (12, 3)
    assert max(abs(mesh.vertices[:, 0])) == pytest.approx(1000)
    assert Counter(item.face_key for item in mesh.triangle_provenance) == {
        "-X": 2,
        "+X": 2,
        "-Y": 2,
        "+Y": 2,
        "Bottom": 2,
        "Top": 2,
    }
    assert await geometry.triangular_mesh(scene, "body", "mm") is mesh
    assert geometry.cached_mesh_count == 1


@pytest.mark.asyncio
async def test_geometry_mesh_cache_has_an_aggregate_triangle_budget(monkeypatch):
    monkeypatch.setattr(geometry_service_module, "MAX_TRIANGLES", 20)
    scene = canonical_scene(box_node())
    geometry = GeometryService()

    first = await geometry.triangular_mesh(scene, "body", "m")
    assert await geometry.triangular_mesh(scene, "body", "m") is first
    with pytest.raises(CaeError, match="mesh cache") as error:
        await geometry.triangular_mesh(scene, "body", "mm")

    assert error.value.code == "resource_limit"
    assert geometry.cached_mesh_count == 1


@pytest.mark.asyncio
async def test_squat_frustum_side_faces_are_not_misclassified_as_caps():
    frustum = {
        "kind": "primitive",
        "nodeId": "frustum",
        "primitive": "cylinder",
        "parameters": {"radius": 1, "radius_2": 2, "height": 0.001, "segments": 16},
    }
    mesh = await GeometryService().triangular_mesh(canonical_scene(frustum), "body", "m")

    assert Counter(item.face_key for item in mesh.triangle_provenance) == {
        "Side": 32,
        "Bottom": 14,
        "Top": 14,
    }


@pytest.mark.asyncio
async def test_tiny_height_frustum_does_not_silently_absorb_side_faces():
    frustum = {
        "kind": "primitive",
        "nodeId": "frustum",
        "primitive": "cylinder",
        "parameters": {"radius": 1, "radius_2": 2, "height": 1e-13, "segments": 16},
    }
    with pytest.raises(CaeError, match="ambiguous surface provenance"):
        await GeometryService().triangular_mesh(canonical_scene(frustum), "body", "m")


@pytest.mark.asyncio
async def test_boolean_subtract_and_fiber_preserve_leaf_surface_provenance():
    subtract = {
        "kind": "boolean",
        "nodeId": "difference",
        "operation": "subtract",
        "children": [
            box_node("stock"),
            {
                "kind": "primitive",
                "nodeId": "bore",
                "primitive": "cylinder",
                "parameters": {"radius": 0.5, "radius_2": 0.5, "height": 8, "segments": 16},
            },
        ],
    }
    subtracted = await GeometryService().triangular_mesh(canonical_scene(subtract), "body", "m")
    assert any(
        item.source_node_id == "bore" and item.face_key == "Side"
        for item in subtracted.triangle_provenance
    )

    frame = {"tangent": [0, 0, 1], "normal": [1, 0, 0], "binormal": [0, 1, 0]}
    fiber = {
        "kind": "fiber",
        "nodeId": "fiber",
        "points": [[0, 0, -1], [0, 0, 1]],
        "radii": [0.2, 0.2],
        "frames": [frame, frame],
        "radialSegments": 8,
    }
    fiber_mesh = await GeometryService().triangular_mesh(canonical_scene(fiber), "body", "m")
    assert {item.face_key for item in fiber_mesh.triangle_provenance} == {
        "Start cap",
        "Side",
        "End cap",
    }


@pytest.mark.asyncio
async def test_long_thin_fiber_exceeding_float32_precision_is_rejected():
    frame = {"tangent": [1, 0, 0], "normal": [0, 1, 0], "binormal": [0, 0, 1]}
    fiber = {
        "kind": "fiber",
        "nodeId": "long-thin",
        "points": [[0, 0, 0], [1e8, 0, 0]],
        "radii": [0.1, 0.1],
        "frames": [frame, frame],
        "radialSegments": 8,
    }

    with pytest.raises(CaeError, match="Float32 indexed-mesh precision envelope") as error:
        await GeometryService().triangular_mesh(canonical_scene(fiber), "body", "m")
    assert error.value.code == "invalid_geometry"


@pytest.mark.asyncio
async def test_custom_indexed_geometry_rejects_manifold_triangle_loss():
    frame = {"tangent": [0, 0, 1], "normal": [1, 0, 0], "binormal": [0, 1, 0]}
    fiber = {
        "kind": "fiber",
        "nodeId": "collapsed-segment",
        "points": [[0, 0, 0], [0, 0, 0], [0, 0, 1]],
        "radii": [0.2, 0.2, 0.2],
        "frames": [frame, frame, frame],
        "radialSegments": 8,
    }

    with pytest.raises(CaeError, match="lost indexed-mesh triangles") as error:
        await GeometryService().triangular_mesh(canonical_scene(fiber), "body", "m")
    assert error.value.code == "invalid_geometry"


@pytest.mark.asyncio
async def test_shell_uses_distinct_shell_boundary_provenance():
    shell = {
        "kind": "shell",
        "nodeId": "coating",
        "innerOffset": 0,
        "outerOffset": 0.25,
        "child": box_node(),
    }
    mesh = await GeometryService().triangular_mesh(canonical_scene(shell), "body", "m")
    assert {(item.source_node_id, item.face_key) for item in mesh.triangle_provenance} == {
        ("coating", "inner"),
        ("coating", "outer"),
    }

    with pytest.raises(CaeError, match="does not identify a semantic leaf face"):
        validate_canonical_geometry_scene(
            canonical_scene(
                shell,
                selectors=({"rootId": "body", "sourceNodeId": "box", "faceKey": "-X"},),
            ),
            "scene",
        )


@pytest.mark.asyncio
async def test_shell_rejects_thickness_below_portable_float32_precision():
    shell = {
        "kind": "shell",
        "nodeId": "thin-layer",
        "innerOffset": 0,
        "outerOffset": 5e-8,
        "child": {
            "kind": "primitive",
            "nodeId": "body",
            "primitive": "box",
            "parameters": {"size": [2, 2, 2]},
        },
    }

    with pytest.raises(CaeError, match="portable Float32 shell precision envelope") as error:
        await GeometryService().triangular_mesh(canonical_scene(shell), "body", "m")
    assert error.value.code == "invalid_geometry"


@pytest.mark.asyncio
async def test_shell_layer_boundaries_bypass_closed_solid_precision_and_apply_outer_scale():
    shell = {
        "kind": "transform",
        "nodeId": "scaled-layer",
        "matrix": [
            2, 0, 0, 0,
            0, 3, 0, 0,
            0, 0, 4, 0,
            0, 0, 0, 1,
        ],
        "child": {
            "kind": "shell",
            "nodeId": "coating/$layer-1",
            "innerOffset": 0,
            "outerOffset": 5e-8,
            "child": box_node(),
        },
    }
    layer = await GeometryService().shell_layer(canonical_scene(shell), "body", "m")

    assert layer is not None
    assert layer.family_id == "coating"
    assert layer.inner.triangles.shape == layer.outer.triangles.shape == (12, 3)
    assert layer.minimum_thickness == pytest.approx(1e-7)
    assert layer.maximum_thickness == pytest.approx(2e-7)
    assert {(item.source_node_id, item.face_key) for item in layer.inner.triangle_provenance} == {
        ("coating/$layer-1", "inner")
    }


@pytest.mark.asyncio
async def test_shell_layer_returns_none_for_non_direct_boolean_shell():
    node = {
        "kind": "boolean",
        "nodeId": "merged",
        "operation": "union",
        "children": [
            {
                "kind": "shell",
                "nodeId": "coating/$layer-1",
                "innerOffset": 0,
                "outerOffset": 1e-6,
                "child": box_node("coated"),
            },
            {
                "kind": "transform",
                "nodeId": "other-transform",
                "matrix": [1, 0, 0, 4, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                "child": box_node("other"),
            },
        ],
    }
    assert await GeometryService().shell_layer(canonical_scene(node), "body", "m") is None


@pytest.mark.asyncio
async def test_shell_rejects_thickness_lost_at_translated_float64_mesh_coordinates():
    translated_box = {
        "kind": "transform",
        "nodeId": "translated-body",
        "matrix": [
            1, 0, 0, 1e12,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ],
        "child": {
            "kind": "primitive",
            "nodeId": "body",
            "primitive": "box",
            "parameters": {"size": [2, 2, 2]},
        },
    }
    shell = {
        "kind": "shell",
        "nodeId": "translated-thin-layer",
        "innerOffset": 0,
        "outerOffset": 1e-5,
        "child": translated_box,
    }

    with pytest.raises(CaeError, match="portable Float64 mesh precision envelope") as error:
        await GeometryService().triangular_mesh(canonical_scene(shell), "body", "m")
    assert error.value.code == "invalid_geometry"


def test_shell_checks_lazy_child_before_extracting_its_mesh(monkeypatch):
    events = []

    class LazySolid:
        def to_mesh64(self):
            events.append("mesh")
            raise RuntimeError("stop after ordering assertion")

    monkeypatch.setattr(
        geometry_service_module,
        "_check_solid",
        lambda solid, context, label: events.append((solid, context, label)),
    )
    solid = LazySolid()
    context = object()
    child = geometry_service_module._CompiledGeometry(solid, {})

    with pytest.raises(RuntimeError, match="ordering assertion"):
        geometry_service_module._shell(child, "shell", 0, 1, context)

    assert events == [(solid, context, "shell child"), "mesh"]


@pytest.mark.parametrize(
    "node",
    [
        {
            "kind": "primitive",
            "nodeId": "sphere",
            "primitive": "sphere",
            "parameters": {"radius": 1, "segments": 1001},
        },
        {
            "kind": "primitive",
            "nodeId": "curved-cylinder",
            "primitive": "curvedEdgeCylinder",
            "parameters": {
                "height": 1,
                "azimuthalCurve": [{"amplitude": 1, "phase": 0}],
                "verticalCurve": {"origin": 0, "coefficients": [1]},
                "azimuthalSegments": 2000,
                "verticalSegments": 500,
            },
        },
        {
            "kind": "primitive",
            "nodeId": "curved-sphere",
            "primitive": "curvedSurfaceSphere",
            "parameters": {
                "azimuthalCurve": [{"amplitude": 1, "phase": 0}],
                "polarCurve": [{"amplitude": 1, "phase": 0}],
                "azimuthalSegments": 2000,
                "polarSegments": 502,
            },
        },
        {
            "kind": "fiber",
            "nodeId": "fiber",
            "points": [[0, 0, index] for index in range(16)],
            "radii": [1] * 16,
            "frames": [
                {"tangent": [0, 0, 1], "normal": [1, 0, 0], "binormal": [0, 1, 0]}
            ]
            * 16,
            "radialSegments": 65_536,
        },
    ],
    ids=("sphere", "curved-edge-cylinder", "curved-surface-sphere", "fiber"),
)
def test_geometry_complexity_is_rejected_before_mesh_allocation(node):
    with pytest.raises(CaeError) as error:
        validate_canonical_geometry_scene(canonical_scene(node), "scene")
    assert error.value.code == "resource_limit"


def test_geometry_complexity_limit_applies_to_the_scene_aggregate():
    sphere = {
        "kind": "primitive",
        "primitive": "sphere",
        "parameters": {"radius": 1, "segments": 800},
    }
    draft = {
        "geometryFormatVersion": 1,
        "lengthUnit": "m",
        "roots": [
            {"id": "first", "materialRole": "body", "node": {**sphere, "nodeId": "first"}},
            {"id": "second", "materialRole": "body", "node": {**sphere, "nodeId": "second"}},
        ],
        "geometryGroups": [],
        "surfaceGroups": [],
    }
    scene = {**draft, "geometryHash": canonical_geometry_hash(draft)}
    with pytest.raises(CaeError) as error:
        validate_canonical_geometry_scene(scene, "scene")
    assert error.value.code == "resource_limit"


@pytest.mark.asyncio
async def test_boolean_preflight_limits_operands_and_pairwise_work_before_manifold(monkeypatch):
    two_spheres = {
        "kind": "boolean",
        "nodeId": "two-spheres",
        "operation": "union",
        "children": [
            {
                "kind": "primitive",
                "nodeId": f"sphere-{index}",
                "primitive": "sphere",
                "parameters": {"radius": 1, "segments": 32},
            }
            for index in range(2)
        ],
    }
    validate_canonical_geometry_scene(canonical_scene(two_spheres), "scene")

    aggregate_draft = {
        "geometryFormatVersion": 1,
        "lengthUnit": "m",
        "roots": [
            {
                "id": f"body-{root_index}",
                "materialRole": "body",
                "node": {
                    "kind": "boolean",
                    "nodeId": f"pair-{root_index}",
                    "operation": "union",
                    "children": [
                        {
                            "kind": "primitive",
                            "nodeId": f"sphere-{root_index}-{sphere_index}",
                            "primitive": "sphere",
                            "parameters": {"radius": 1, "segments": 70},
                        }
                        for sphere_index in range(2)
                    ],
                },
            }
            for root_index in range(2)
        ],
        "geometryGroups": [],
        "surfaceGroups": [],
    }
    aggregate_scene = {
        **aggregate_draft,
        "geometryHash": canonical_geometry_hash(aggregate_draft),
    }
    with pytest.raises(CaeError, match="estimated Boolean work") as aggregate_error:
        validate_canonical_geometry_scene(aggregate_scene, "scene")
    assert aggregate_error.value.code == "resource_limit"

    too_many_operands = {
        "kind": "boolean",
        "nodeId": "flat-union",
        "operation": "union",
        "children": [box_node(f"flat-box-{index}") for index in range(129)],
    }
    with pytest.raises(CaeError, match="at most 128 Boolean operands") as operand_error:
        validate_canonical_geometry_scene(canonical_scene(too_many_operands), "scene")
    assert operand_error.value.code == "resource_limit"

    level = [box_node(f"balanced-box-{index}") for index in range(2048)]
    depth = 0
    while len(level) > 1:
        level = [
            {
                "kind": "boolean",
                "nodeId": f"balanced-union-{depth}-{index // 2}",
                "operation": "union",
                "children": level[index : index + 2],
            }
            for index in range(0, len(level), 2)
        ]
        depth += 1
    excessive_work = canonical_scene(level[0])
    with pytest.raises(CaeError, match="estimated Boolean work") as work_error:
        validate_canonical_geometry_scene(excessive_work, "scene")
    assert work_error.value.code == "resource_limit"

    manifold_started = False

    def unexpected_execution_context():
        nonlocal manifold_started
        manifold_started = True
        raise AssertionError("Manifold must not start after Boolean preflight rejection")

    monkeypatch.setattr(geometry_service_module.manifold, "ExecutionContext", unexpected_execution_context)
    with pytest.raises(CaeError, match="estimated Boolean work"):
        await GeometryService().triangular_mesh(excessive_work, "body", "m")
    assert not manifold_started


@pytest.mark.asyncio
async def test_geometry_service_applies_the_same_preallocation_limit():
    sphere = {
        "kind": "primitive",
        "nodeId": "sphere",
        "primitive": "sphere",
        "parameters": {"radius": 1, "segments": 1001},
    }
    with pytest.raises(CaeError) as error:
        await GeometryService().triangular_mesh(canonical_scene(sphere), "body", "m")
    assert error.value.code == "resource_limit"


@pytest.mark.asyncio
async def test_invalid_manifold_input_maps_to_invalid_geometry():
    collapsed = {
        "kind": "transform",
        "nodeId": "collapsed",
        "matrix": [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        "child": box_node(),
    }
    with pytest.raises(CaeError) as error:
        await GeometryService().triangular_mesh(canonical_scene(collapsed), "body", "m")
    assert error.value.code == "invalid_geometry"
