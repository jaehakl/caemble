"""Prepare the optical scene, launch sources, trace rays, and publish results."""

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult, StatePatch
from app.kernel.api.world import experiment_scene, geometry_parts, scalar_parameter, single_method, target_group

from .domain import THIN_LAYER_LIMIT, build_collision_scene
from .formulation import launch_sources, trace_rays
from .outputs import build_detectors, build_ray_outputs


async def run(invocation: SolverInvocation) -> SolverResult:
    config = invocation.config
    scene = experiment_scene(invocation.world)
    domain_rule = single_method(config, "initializations", "ray.domain")
    parts = geometry_parts(scene, target_group(domain_rule, "geometry"))
    collision_scene, meshes = await build_collision_scene(invocation, scene, parts)
    epsilon = max(1e-12, collision_scene.diagonal * 1e-10)
    seed = int(scalar_parameter(config["parameters"]["seed"]))

    detectors = build_detectors(config, scene, meshes)
    launched, source_power = await launch_sources(invocation, config, scene, meshes, seed, epsilon)
    paths = await trace_rays(invocation, scene, collision_scene, meshes, launched, detectors, seed, epsilon)

    path_bundle = paths.bundle()
    artifacts = await build_ray_outputs(
        config, detectors, source_power, path_bundle, invocation.progress, invocation.descriptor,
    )
    return SolverResult(
        state_patch=StatePatch().put("rayPaths", path_bundle),
        artifacts=artifacts,
        observations={
            "launchedRays": len(launched),
            "recordedPaths": len(paths.paths),
            "detectedPower": paths.detected_power,
            "thinLayerThresholdMeters": THIN_LAYER_LIMIT,
        },
    )


def prepare_brief(invocation):
    from copy import deepcopy
    config = deepcopy(dict(invocation.config))
    for rule in config["initializations"]:
        values = rule["parameters"]
        if "rayCount" in values:
            value = values["rayCount"]
            count = max(1, int(value["value"] if isinstance(value, dict) else value) // 100)
            values["rayCount"] = {**value, "value": count} if isinstance(value, dict) else count
    return config


implementation = SolverImplementation(abi_version=3, run=run, prepare_brief=prepare_brief)

__all__ = ["implementation"]
