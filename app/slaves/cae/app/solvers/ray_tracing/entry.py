"""Prepare the optical scene, launch sources, trace rays, and publish results."""

import numpy as np

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult, StatePatch
from app.kernel.api.world import experiment_scene, geometry_parts, scalar_parameter, single_method, target_group

from .domain import THIN_LAYER_LIMIT, build_collision_scene
from .formulation import launch_sources, trace_rays
from .outputs import build_detectors, build_volume_tallies
from .detector import build_detector_tallies, launched_power_artifacts


async def run(invocation: SolverInvocation) -> SolverResult:
    config = invocation.config
    scene = experiment_scene(invocation.world)
    domain_rule = single_method(config, "initializations", "ray.domain")
    parts = geometry_parts(scene, target_group(domain_rule, "geometry"))
    collision_scene, solids = await build_collision_scene(invocation, scene, parts)
    seed = int(scalar_parameter(config["parameters"]["seed"]))

    detectors = build_detectors(config, scene, solids)
    launched, launched_power = await launch_sources(invocation, config, scene, solids, seed)
    tallies = build_volume_tallies(config, invocation.descriptor, [ray.wavelength for ray in launched])
    detector_tallies = build_detector_tallies(config, invocation.descriptor, np.asarray(sorted(launched_power)), scene, solids, detectors)
    paths = await trace_rays(invocation, scene, collision_scene, solids, launched, detectors, seed, tallies, detector_tallies)

    path_bundle = paths.bundle()
    return SolverResult(
        state_patch=StatePatch().put("rayPaths", path_bundle),
        artifacts={**{tally.key: tally.artifact() for tally in [*tallies, *detector_tallies]},
                   **launched_power_artifacts(config, invocation.descriptor, launched_power)},
        visualizations={"paths": path_bundle},
        observations={
            "launchedRays": len(launched),
            "recordedPaths": len(paths.paths),
            "detectedPower": paths.detected_power,
            "thinLayerThresholdMeters": THIN_LAYER_LIMIT,
        },
    )


implementation = SolverImplementation(abi_version=3, run=run)

__all__ = ["implementation"]
