from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from app.methods.geometry import ShellLayerGeometry, TriangularMesh
from app.methods.rays import SurfaceSampler, TriangleMetadata, TriangleScene
from app.runtime_kernel.api import SolverInvocation

THIN_LAYER_LIMIT = 50e-6


@dataclass(frozen=True, slots=True)
class ThinStack:
    layers: tuple[tuple[ShellLayerGeometry, str], ...]
    left_material: str | None
    left_root: str | None
    right_material: str | None
    right_root: str | None


async def build_collision_scene(
    context: SolverInvocation,
    scene: dict[str, Any],
    parts: list[dict[str, Any]],
) -> tuple[TriangleScene, dict[str, TriangularMesh]]:
    collision = TriangleScene()
    meshes: dict[str, TriangularMesh] = {}
    thin_roots: dict[str, ShellLayerGeometry] = {}
    shell_layers: dict[str, tuple[ShellLayerGeometry, str]] = {}
    materials_by_root: dict[str, str] = {}
    for index, part in enumerate(parts):
        root_id = part["id"]
        layer = await context.geometry.shell_layer(
            scene,
            root_id,
            context.descriptor["referenceLengthUnit"],
            context.progress,
        )
        material_name = part["material"]["name"]
        materials_by_root[root_id] = material_name
        if layer is not None:
            shell_layers[root_id] = (layer, material_name)
        if layer is not None and is_thin(layer.maximum_thickness):
            thin_roots[root_id] = layer
        else:
            mesh = await context.geometry.triangular_mesh(
                scene,
                root_id,
                context.descriptor["referenceLengthUnit"],
                context.progress,
            )
            meshes[root_id] = mesh
        await context.progress({"stage": "ray-geometry", "completed": index + 1, "total": len(parts)})

    families: dict[str, list[tuple[ShellLayerGeometry, str]]] = {}
    for layer, material_name in shell_layers.values():
        families.setdefault(layer.family_id, []).append((layer, material_name))
    for family in families.values():
        ordered = sorted(family, key=lambda item: item[0].inner_offset)
        first = 0
        while first < len(ordered):
            if ordered[first][0].root_id not in thin_roots:
                first += 1
                continue
            last = first
            while (
                last + 1 < len(ordered)
                and ordered[last + 1][0].root_id in thin_roots
                and math.isclose(
                    ordered[last][0].outer_offset,
                    ordered[last + 1][0].inner_offset,
                    rel_tol=1e-12,
                    abs_tol=1e-15,
                )
            ):
                last += 1
            left = ordered[first - 1] if first > 0 and math.isclose(
                ordered[first - 1][0].outer_offset,
                ordered[first][0].inner_offset,
                rel_tol=1e-12,
                abs_tol=1e-15,
            ) else None
            right = ordered[last + 1] if last + 1 < len(ordered) and math.isclose(
                ordered[last][0].outer_offset,
                ordered[last + 1][0].inner_offset,
                rel_tol=1e-12,
                abs_tol=1e-15,
            ) else None
            stack = ThinStack(
                tuple(ordered[first : last + 1]),
                left[1] if left is not None else None,
                left[0].root_id if left is not None else None,
                right[1] if right is not None else None,
                right[0].root_id if right is not None else None,
            )
            collision.add_mesh(
                stack.layers[0][0].inner,
                TriangleMetadata("thin-stack-left", stack.layers[0][0].root_id, payload=stack),
            )
            collision.add_mesh(
                stack.layers[-1][0].outer,
                TriangleMetadata("thin-stack-right", stack.layers[-1][0].root_id, payload=stack),
            )
            first = last + 1
    for root_id, mesh in meshes.items():
        collision.add_mesh(mesh, TriangleMetadata("solid", root_id, materials_by_root[root_id]))
    collision.build()
    return collision, meshes


def surface_sampler(
    scene: dict[str, Any],
    group_name: str,
    meshes: dict[str, TriangularMesh],
) -> SurfaceSampler:
    selector = selectors(scene, group_name)[0]
    mesh = meshes[selector["rootId"]]
    return SurfaceSampler(mesh, mesh.triangle_indices(selector))


def surface_triangle_keys(
    scene: dict[str, Any],
    group_name: str,
    meshes: dict[str, TriangularMesh],
) -> set[tuple[str, int]]:
    result: set[tuple[str, int]] = set()
    for selector in selectors(scene, group_name):
        root_id = selector["rootId"]
        indices = meshes[root_id].triangle_indices(selector)
        result.update((root_id, int(index)) for index in indices)
    return result


def selectors(scene: dict[str, Any], group_name: str) -> tuple[dict[str, Any], ...]:
    group = next(group for group in scene["surfaceGroups"] if group["name"] == group_name)
    return tuple(group["selectors"])


def is_thin(thickness: float) -> bool:
    return thickness < THIN_LAYER_LIMIT
