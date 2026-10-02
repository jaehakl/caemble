from __future__ import annotations

from app.kernel.api import SolverInvocation
from app.methods.geometry.analytic import SurfaceRef
from app.methods.rays.analytic import AnalyticScene
from app.methods.rays.sampling import AnalyticSurfaceSampler

THIN_LAYER_LIMIT = 50e-6


async def build_collision_scene(context: SolverInvocation, scene, parts):
    solids = {}
    for index, part in enumerate(parts):
        root_id = part["id"]
        solids[root_id] = await context.geometry.continuous_solid(
            scene, root_id, context.descriptor["referenceLengthUnit"], context.progress
        )
        await context.progress(
            {"stage": "ray-geometry", "completed": index + 1, "total": len(parts)}
        )
    return AnalyticScene(solids.values()), solids


def surface_sampler(scene, group_name, solids):
    return AnalyticSurfaceSampler(solids, selectors(scene, group_name))


def surface_keys(scene, group_name, solids):
    selected = {
        SurfaceRef(s["rootId"], s["sourceNodeId"], s["surfaceIndex"])
        for s in selectors(scene, group_name)
    }
    return {
        patch.reference
        for solid in solids.values()
        for patch in solid.patches
        if patch.reference in selected
        and solid.boundary_possible(patch, *patch.enclosure())
    }


def selectors(scene, group_name):
    group = next(
        group for group in scene["surfaceGroups"] if group["name"] == group_name
    )
    return tuple(group["selectors"])
