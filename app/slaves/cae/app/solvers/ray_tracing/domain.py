from __future__ import annotations

from typing import Any
from app.methods.geometry import TriangularMesh
from app.methods.rays import SurfaceSampler, TriangleMetadata, TriangleScene
from app.kernel.api import SolverInvocation

THIN_LAYER_LIMIT = 50e-6


async def build_collision_scene(context: SolverInvocation, scene: dict[str, Any], parts: list[dict[str, Any]]) -> tuple[TriangleScene, dict[str, TriangularMesh]]:
    collision = TriangleScene()
    meshes = {}
    for index, part in enumerate(parts):
        root_id = part["id"]
        mesh = await context.geometry.triangular_mesh(scene, root_id, context.descriptor["referenceLengthUnit"], context.progress)
        meshes[root_id] = mesh
        collision.add_mesh(mesh, TriangleMetadata("solid", root_id, part["material"]["name"]))
        await context.progress({"stage": "ray-geometry", "completed": index+1, "total": len(parts)})
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
