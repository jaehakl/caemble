from __future__ import annotations

import math
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from app.kernel.api.errors import CaeError
from app.methods.geometry.analytic import AnalyticSolid, SurfaceRef
from app.methods.geometry.extrema import solid_bounds
from app.methods.optics import (
    abg_direction,
    cone_direction,
    cosine_hemisphere,
    henyey_greenstein,
    interface_stokes,
    multilayer_stokes,
    perpendicular,
    polarization_basis_change,
    reflect,
    refract,
    unit_vector,
)
from app.methods.rays import counter_random, vector_parameter
from app.methods.rays.analytic import AnalyticScene, AnalyticHit
from app.kernel.api import SolverInvocation
from app.kernel.api.world import (
    geometry_part,
    geometry_parts,
    scalar_parameter,
    target_group,
)

from .domain import (
    selectors,
    surface_sampler,
    surface_keys,
)
from .grating import build_gratings, diffracted_direction
from .thin_film import surface_films, film_layers
from .materials import optical_material
from .outputs import Detector, PathCollector, VolumeTally
from .detector import DetectorTally
from .paraxial import build_lenses

EVENT_REFLECTION = 0
EVENT_REFRACTION = 1
EVENT_SCATTERING = 2
EVENT_SURFACE_SCATTER = 3
EVENT_BULK_SCATTER = 4
EVENT_DETECTOR = 5
EVENT_ABSORPTION = 6
EVENT_ESCAPE = 7
EVENT_POWER_CUTOFF = 8
EVENT_MAX_BOUNCES = 9
EVENT_ROULETTE = 10
EVENT_DIFFRACTION = 11
EVENT_PARAXIAL_TRANSFER = 12


@dataclass(slots=True)
class Ray:
    origin: np.ndarray[Any, Any]
    direction: np.ndarray[Any, Any]
    basis: np.ndarray[Any, Any]
    stokes: np.ndarray[Any, Any]
    wavelength: float
    source_power: float
    source_index: int
    medium_name: str | None = None
    medium_root: str | None = None
    medium_stack: list[tuple[str, str]] = field(default_factory=list)
    path_key: int = 0
    interactions: int = 0
    split_done: bool = False
    last_hit: AnalyticHit | None = None
    vertices: list[np.ndarray[Any, Any]] = field(default_factory=list)
    powers: list[float] = field(default_factory=list)
    events: list[int] = field(default_factory=list)

    def branch(self) -> Ray:
        return Ray(
            origin=self.origin.copy(),
            direction=self.direction.copy(),
            basis=self.basis.copy(),
            stokes=self.stokes.copy(),
            wavelength=self.wavelength,
            source_power=self.source_power,
            source_index=self.source_index,
            medium_name=self.medium_name,
            medium_root=self.medium_root,
            medium_stack=list(self.medium_stack),
            path_key=self.path_key,
            interactions=self.interactions,
            split_done=self.split_done,
            last_hit=self.last_hit,
            vertices=[point.copy() for point in self.vertices],
            powers=list(self.powers),
            events=list(self.events),
        )


@dataclass(slots=True)
class PreparedTrace:
    collision_scene: AnalyticScene
    world: Any
    descriptor: Any
    detectors: dict
    surface_scatter: dict
    bulk_scatter: dict
    gratings: dict
    maximum_interactions: int
    maximum_paths: int
    minimum_power_fraction: float
    seed: int
    films: dict
    tally_definitions: list
    detector_definitions: list = field(default_factory=list)
    lenses: dict = field(default_factory=dict)


def prepare_trace(context, scene, collision_scene, solids, detectors, seed, tallies, detector_tallies=()):
    config = context.config
    maximum_interactions = _integer(config["parameters"]["maxInteractions"])
    maximum_paths = _integer(config["parameters"]["maxPaths"])
    minimum_power_fraction = scalar_parameter(config["parameters"]["minPowerFraction"])
    surface_scatter = _surface_scatter(config, scene, solids)
    bulk_scatter = _bulk_scatter(config, scene)
    gratings = build_gratings(config, scene, solids)
    detector_by_surface: dict[SurfaceRef, list[Detector]] = {}
    for detector in detectors:
        for surface_key in detector.surface_keys:
            detector_by_surface.setdefault(surface_key, []).append(detector)

    films = surface_films(context, scene, solids, set(gratings) | set(detector_by_surface))

    return PreparedTrace(collision_scene, context.world, context.descriptor, detector_by_surface,
                         surface_scatter, bulk_scatter, gratings, maximum_interactions,
                         maximum_paths, minimum_power_fraction, seed, films,
                         [(t.key, t.grid, t.data, t.frequencies) for t in tallies],
                         [(t.key, t.grid, t.data, t.frequencies, t.surface) for t in detector_tallies],
                         build_lenses(config, scene, solids))


def initialize_trace(prepared):
    # Prepared analytic solids and optical rules are reused for every batch.
    for solid in prepared.collision_scene.solids:
        solid.minimum.flags.writeable = False
        solid.maximum.flags.writeable = False
    for _, _, _, frequencies in prepared.tally_definitions:
        frequencies.flags.writeable = False
    return prepared


def trace_batch(prepared: PreparedTrace, batch, cancellation=None) -> PathCollector:
    offset, launched = batch
    collector = PathCollector(prepared.maximum_paths, seed=prepared.seed,
                              tallies=[VolumeTally(*definition) for definition in prepared.tally_definitions],
                              detector_tallies=[DetectorTally(*definition) for definition in prepared.detector_definitions])
    queue = deque((ray, 0, offset + index, ()) for index, ray in enumerate(launched))
    while queue:
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        ray, depth, root, ancestry = queue.popleft()
        # Queue depth is deliberately independent of physical interactions:
        # a tangent requeue, for example, does not increment interactions.
        collector.current_order = (depth, root, ancestry)
        collector.finish_index = 0
        branches = _trace_one(
            ray, prepared.collision_scene, prepared.world, prepared.descriptor,
            prepared.detectors, prepared.surface_scatter, prepared.bulk_scatter,
            prepared.gratings, prepared.maximum_interactions,
            ray.source_power * prepared.minimum_power_fraction, prepared.seed,
            collector, prepared.films, prepared.lenses,
        )
        queue.extend((branch, depth + 1, root, (*ancestry, index))
                     for index, branch in enumerate(branches))
    return collector


async def trace_rays(
    context: SolverInvocation,
    scene: dict[str, Any],
    collision_scene: AnalyticScene,
    solids: dict[str, AnalyticSolid],
    launched: list[Ray],
    detectors: list[Detector],
    seed: int,
    tallies: list[Any] | None = None,
    detector_tallies: list[Any] | None = None,
) -> PathCollector:
    from contextlib import aclosing
    from time import perf_counter

    started = perf_counter()
    tallies = [] if tallies is None else tallies
    detector_tallies = [] if detector_tallies is None else detector_tallies
    prepared = prepare_trace(context, scene, collision_scene, solids, detectors, seed, tallies, detector_tallies)
    collector = PathCollector(prepared.maximum_paths, seed=seed, tallies=tallies, detector_tallies=detector_tallies)
    batches = ((offset, launched[offset:offset + 128]) for offset in range(0, len(launched), 128))
    workers = 1
    if context.execution is not None and len(launched) >= 512:
        # Per-worker tally plus up to two outstanding transfer/result arrays.
        private_bytes = 3 * sum(t.values.nbytes for t in [*tallies, *detector_tallies])
        workers = context.execution.batch_workers((len(launched) + 127) // 128, private_bytes)
    preparation_seconds = perf_counter() - started
    completed = 0
    merge_seconds = 0.0
    if context.progress is not None:
        await context.progress({"stage": "trace", "completed": 0, "total": len(launched)})
    if workers > 1:
        results = context.execution.map_batches(
            __name__ + ":initialize_trace", __name__ + ":trace_batch", prepared, batches, workers)
        async with aclosing(results):
            async for result in results:
                merge_started = perf_counter()
                collector.merge(result)
                merge_seconds += perf_counter() - merge_started
                completed = min(len(launched), completed + 128)
                if context.progress is not None:
                    await context.progress({"stage": "trace", "completed": completed, "total": len(launched)})
    else:
        for batch in batches:
            result = trace_batch(prepared, batch, context.cancellation)
            merge_started = perf_counter()
            collector.merge(result)
            merge_seconds += perf_counter() - merge_started
            completed += len(batch[1])
            if context.progress is not None:
                await context.progress({"stage": "trace", "completed": completed, "total": len(launched)})
    if context.progress is not None:
        await context.progress({"stage": "trace", "completed": completed, "total": len(launched),
                                "workers": workers, "prepareSeconds": preparation_seconds,
                                "mergeSeconds": merge_seconds, "seconds": perf_counter() - started})
    return collector


def _trace_one(
    ray: Ray,
    scene: AnalyticScene,
    world: dict[str, Any],
    descriptor: dict[str, Any],
    detectors: dict[SurfaceRef, list[Detector]],
    surface_scatter: dict[SurfaceRef, tuple[str, dict[str, Any]]],
    bulk_scatter: dict[str, float],
    gratings: dict[SurfaceRef, dict[str, Any]],
    maximum_interactions: int,
    threshold: float,
    seed: int,
    collector: PathCollector,
    films: dict | None = None,
    lenses: dict | None = None,
) -> list[Ray]:
    if not ray.vertices:
        ray.vertices.append(ray.origin.copy())
    hit = scene.intersect(ray.origin, ray.direction, 0.0, previous=ray.last_hit)
    escape_distance = scene.diagonal
    if hit is None:
        medium = optical_material(world, ray.medium_name, ray.wavelength)
        score_distance = escape_distance
        for tally in collector.tallies:
            interval = tally.interval(ray.origin, ray.direction)
            if interval is not None:
                score_distance = max(score_distance, interval[1])
        collector.score(ray.origin, ray.direction, score_distance, float(ray.stokes[0]), medium.absorption_coefficient, ray.wavelength)
        _segment(ray, ray.origin + ray.direction * escape_distance, EVENT_ESCAPE)
        collector.finish(ray)
        return []
    medium = optical_material(world, ray.medium_name, ray.wavelength)
    travel = hit.distance
    anisotropy = bulk_scatter.get(ray.medium_root) if ray.medium_root is not None else None
    if anisotropy is not None and medium.scattering_coefficient > 0:
        random_value = max(1e-15, counter_random(seed, ray.path_key, ray.interactions, 20))
        scatter_distance = -math.log(random_value) / medium.scattering_coefficient
        if scatter_distance < travel:
            collector.score(ray.origin, ray.direction, scatter_distance, float(ray.stokes[0]), medium.absorption_coefficient, ray.wavelength)
            ray.stokes *= math.exp(-medium.absorption_coefficient * scatter_distance)
            position = ray.origin + ray.direction * scatter_distance
            if ray.stokes[0] <= threshold:
                _segment(ray, position, EVENT_POWER_CUTOFF)
                collector.finish(ray)
                return []
            _segment(ray, position, EVENT_BULK_SCATTER)
            ray.direction = henyey_greenstein(
                ray.direction,
                anisotropy,
                counter_random(seed, ray.path_key, ray.interactions, 21),
                counter_random(seed, ray.path_key, ray.interactions, 22),
            )
            ray.basis = perpendicular(ray.direction)
            ray.stokes[1:] = 0
            ray.origin = position
            ray.last_hit = None
            ray.interactions += 1
            if ray.interactions >= maximum_interactions:
                _segment(ray, ray.origin, EVENT_MAX_BOUNCES)
                collector.finish(ray)
                return []
            return [ray]
    collector.score(ray.origin, ray.direction, travel, float(ray.stokes[0]), medium.absorption_coefficient, ray.wavelength)
    ray.stokes *= math.exp(-medium.absorption_coefficient * travel)
    if ray.stokes[0] <= threshold:
        _segment(ray, hit.position, EVENT_POWER_CUTOFF)
        collector.finish(ray)
        return []
    ray.last_hit = hit
    detector_hits = detectors.get(hit.surface_ref, [])
    if detector_hits:
        _segment(ray, hit.position, EVENT_DETECTOR)
        collector.detected_power += float(ray.stokes[0])
        for tally in collector.detector_tallies:
            if tally.surface == hit.surface_ref:
                tally.score_hit(hit.position, float(ray.stokes[0]), ray.wavelength)
        collector.finish(ray)
        return []
    if ray.interactions >= maximum_interactions:
        _segment(ray, hit.position, EVENT_MAX_BOUNCES)
        collector.finish(ray)
        return []

    if hit.crossing_kind == "touch":
        ray.origin = hit.position.copy()
        return [ray]

    lens = (lenses or {}).get(hit.metadata.root_id)
    if lens is not None:
        if ray.medium_stack:
            raise ValueError('Paraxial lens requires air on both sides')
        transfer = lens.transfer(hit.position, ray.direction) if hit.surface_ref.surface_index in (0, 2) else None
        if transfer is None or lens.transmission == 0:
            _segment(ray, hit.position, EVENT_ABSORPTION)
            collector.finish(ray)
            return []
        position, direction = transfer
        _segment(ray, hit.position, EVENT_REFRACTION)
        # Parallel transport the polarization basis; the ideal lens has no diattenuation.
        cross = np.cross(ray.direction, direction)
        cosine = float(np.dot(ray.direction, direction))
        sine = float(np.linalg.norm(cross))
        if sine > 0:
            axis = cross / sine
            ray.basis = unit_vector(ray.basis * cosine + np.cross(axis, ray.basis) * sine
                                   + axis * np.dot(axis, ray.basis) * (1 - cosine))
        ray.stokes *= lens.transmission
        # A marked jump, never a volume tally or a drawn physical internal ray.
        _segment(ray, position, EVENT_PARAXIAL_TRANSFER)
        ray.origin, ray.direction = position, direction
        ray.last_hit = lens.exit_hit(hit, position, direction)
        ray.interactions += 1
        return [ray]

    grating = gratings.get(hit.surface_ref)
    if grating is not None:
        transmitted_stack = list(ray.medium_stack)
        target_index = medium.refractive_index.real
        if any(efficiency > 0 for efficiency in _array(grating['transmittedEfficiencies'])):
            entering = hit.crossing_kind == 'enter'
            transmitted_stack = _cross_medium(ray.medium_stack, None if entering else hit.metadata.root_id,
                                             (hit.metadata.root_id, hit.metadata.material_name) if entering else None)
            target_name = transmitted_stack[-1][1] if transmitted_stack else None
            target_index = optical_material(world, target_name, ray.wavelength).refractive_index.real
        return _diffract(ray, hit, grating, medium.refractive_index.real, threshold, collector,
                         target_index=target_index, target_stack=transmitted_stack)

    entering = hit.crossing_kind == "enter"
    normal = hit.normal if entering else -hit.normal
    target_stack = _cross_medium(
        ray.medium_stack, None if entering else hit.metadata.root_id,
        (hit.metadata.root_id, hit.metadata.material_name) if entering else None,
    )
    target_root = target_stack[-1][0] if target_stack else None
    target_name = target_stack[-1][1] if target_stack else None
    incident = optical_material(world, ray.medium_name, ray.wavelength)
    target = optical_material(world, target_name, ray.wavelength)
    film = (films or {}).get(hit.surface_ref)
    if film is None:
        reflected, transmitted, s_axis = interface_stokes(
            ray.stokes, ray.basis, ray.direction, normal, incident.refractive_index, target.refractive_index,
        )
    else:
        layers = film_layers(film, ray.wavelength)
        if not entering:
            layers.reverse()
        reflected, transmitted, s_axis = multilayer_stokes(
            ray.stokes, ray.basis, ray.direction, normal, incident.refractive_index, layers, target.refractive_index, ray.wavelength,
        )
    transmitted_direction = refract(ray.direction, normal, max(1e-12, incident.refractive_index.real), max(1e-12, target.refractive_index.real))
    transmission_position = hit.position
    reflected_direction = reflect(ray.direction, hit.normal)
    scatter = surface_scatter.get(hit.surface_ref)
    return _continue_interface(
        ray,
        hit.position,
        hit.normal,
        reflected,
        transmitted,
        reflected_direction,
        transmitted_direction,
        transmission_position,
        s_axis,
        target_name,
        target_root,
        target_stack,
        scatter,
        maximum_interactions,
        threshold,
        seed,
        collector,
    )


def _continue_interface(
    ray: Ray,
    position: np.ndarray[Any, Any],
    normal: np.ndarray[Any, Any],
    reflected: np.ndarray[Any, Any],
    transmitted: np.ndarray[Any, Any],
    reflected_direction: np.ndarray[Any, Any],
    transmitted_direction: np.ndarray[Any, Any] | None,
    transmission_position: np.ndarray[Any, Any],
    s_axis: np.ndarray[Any, Any],
    target_name: str | None,
    target_root: str | None,
    target_stack: list[tuple[str, str]],
    scatter: tuple[str, dict[str, Any]] | None,
    maximum_interactions: int,
    threshold: float,
    seed: int,
    collector: PathCollector,
) -> list[Ray]:
    reflected_power = max(0.0, float(reflected[0]))
    transmitted_power = max(0.0, float(transmitted[0])) if transmitted_direction is not None else 0.0
    if reflected_power + transmitted_power <= threshold:
        _segment(ray, position, EVENT_ABSORPTION)
        collector.finish(ray)
        return []
    ray.interactions += 1
    if not ray.split_done:
        result: list[Ray] = []
        retains_reflection = reflected_power > threshold
        retains_transmission = transmitted_power > threshold and transmitted_direction is not None
        is_split = retains_reflection and retains_transmission
        if retains_reflection:
            reflected_ray = ray.branch()
            if is_split:
                reflected_ray.path_key = _branch_key(ray.path_key, 0)
            _segment(reflected_ray, position, EVENT_REFLECTION)
            _set_reflection(reflected_ray, reflected, reflected_direction, s_axis, normal, scatter, seed)
            result.append(reflected_ray)
        if retains_transmission and transmitted_direction is not None:
            transmitted_ray = ray.branch()
            if is_split:
                transmitted_ray.path_key = _branch_key(ray.path_key, 1)
            _segment(transmitted_ray, position, EVENT_REFRACTION)
            transmitted_ray.stokes = transmitted
            transmitted_ray.direction = transmitted_direction
            transmitted_ray.basis = s_axis
            transmitted_ray.medium_name = target_name
            transmitted_ray.medium_root = target_root
            transmitted_ray.medium_stack = list(target_stack)
            transmitted_ray.origin = transmission_position.copy()
            result.append(transmitted_ray)
        if len(result) > 1:
            for branch in result:
                branch.split_done = True
        if result and ray.interactions >= maximum_interactions:
            for branch in result:
                collector.finish(branch)
            return []
        if not result:
            _segment(ray, position, EVENT_ABSORPTION)
            collector.finish(ray)
        return result
    total = reflected_power + transmitted_power
    choose_reflection = transmitted_direction is None or counter_random(
        seed, ray.path_key, ray.interactions, 30
    ) < reflected_power / total
    _segment(ray, position, EVENT_ROULETTE)
    if choose_reflection:
        ray.stokes = reflected * (total / reflected_power)
        _set_reflection(ray, ray.stokes, reflected_direction, s_axis, normal, scatter, seed)
        ray.events[-1] = EVENT_REFLECTION if scatter is None else ray.events[-1]
    else:
        ray.stokes = transmitted * (total / transmitted_power)
        ray.direction = transmitted_direction
        ray.basis = s_axis
        ray.medium_name = target_name
        ray.medium_root = target_root
        ray.medium_stack = list(target_stack)
        ray.origin = transmission_position.copy()
        ray.events[-1] = EVENT_REFRACTION
    if ray.interactions >= maximum_interactions:
        collector.finish(ray)
        return []
    return [ray]


def _set_reflection(
    ray: Ray,
    stokes: np.ndarray[Any, Any],
    direction: np.ndarray[Any, Any],
    s_axis: np.ndarray[Any, Any],
    normal: np.ndarray[Any, Any],
    scatter: tuple[str, dict[str, Any]] | None,
    seed: int,
) -> None:
    ray.stokes = stokes
    ray.direction = direction
    ray.basis = s_axis
    event = EVENT_REFLECTION
    if scatter is not None:
        kind, parameters = scatter
        fraction = scalar_parameter(parameters["scatterFraction"])
        if counter_random(seed, ray.path_key, ray.interactions, 40) < fraction:
            if kind == "abg":
                ray.direction = abg_direction(
                    direction,
                    normal if float(np.dot(direction, normal)) > 0 else -normal,
                    scalar_parameter(parameters["b"]),
                    scalar_parameter(parameters["g"]),
                    counter_random(seed, ray.path_key, ray.interactions, 41),
                    counter_random(seed, ray.path_key, ray.interactions, 42),
                )
            else:
                hemisphere_normal = normal if float(np.dot(direction, normal)) > 0 else -normal
                ray.direction = cosine_hemisphere(
                    hemisphere_normal,
                    counter_random(seed, ray.path_key, ray.interactions, 41),
                    counter_random(seed, ray.path_key, ray.interactions, 42),
                )
            ray.basis = perpendicular(ray.direction)
            ray.stokes[1:] = 0
            event = EVENT_SURFACE_SCATTER
    if ray.events:
        ray.events[-1] = event
    ray.origin = ray.vertices[-1].copy()


async def launch_sources(
    context: SolverInvocation,
    config: Mapping[str, Any],
    scene: dict[str, Any],
    solids: dict[str, AnalyticSolid],
    seed: int,
) -> tuple[list[Ray], dict[float, float]]:
    rules = [
        rule
        for rule in config["initializations"]
        if rule["methodId"] in {
            "ray.point-source",
            "ray.area-source",
            "ray.directional-source",
            "ray.lambertian-source",
        }
    ]
    rays: list[Ray] = []
    source_solids = dict(solids)
    launched_power = {}
    source_index = 0
    for rule_index, rule in enumerate(rules):
        parameters = rule["parameters"]
        wavelength = scalar_parameter(parameters["wavelength"])
        flux = scalar_parameter(parameters["radiantFlux"])
        count = _integer(parameters["rayCount"])
        stokes = _stokes(parameters["stokes"], flux / count)
        method = rule["methodId"]
        sampler = None
        center = None
        if method == "ray.point-source":
            part = geometry_part(scene, target_group(rule, "geometry"))
            solid = await context.geometry.continuous_solid(
                scene, part["id"], context.descriptor["referenceLengthUnit"], context.progress,
            )
            minimum, maximum = solid_bounds(solid)
            center = (minimum + maximum) / 2
        else:
            group_name = target_group(rule, "surface")
            for selector in selectors(scene, group_name):
                root_id = selector["rootId"]
                if root_id not in source_solids:
                    source_solids[root_id] = await context.geometry.continuous_solid(
                        scene, root_id, context.descriptor["referenceLengthUnit"], context.progress,
                    )
            sampler = surface_sampler(scene, group_name, source_solids)
        for local_index in range(count):
            if center is not None:
                origin = center.copy()
            else:
                origin, sampled_normal = sampler.sample(seed, rule_index, local_index)
            if method in {"ray.point-source", "ray.area-source"}:
                direction = cone_direction(
                    vector_parameter(parameters["direction"], "source direction"),
                    scalar_parameter(parameters["coneHalfAngle"]),
                    counter_random(seed, rule_index, local_index, 3),
                    counter_random(seed, rule_index, local_index, 4),
                )
            elif method == "ray.directional-source":
                direction = vector_parameter(parameters["direction"], "source direction")
            else:
                outward = parameters["outward"]
                direction = cosine_hemisphere(
                    sampled_normal * (1 if outward else -1),
                    counter_random(seed, rule_index, local_index, 3),
                    counter_random(seed, rule_index, local_index, 4),
                )
            rays.append(
                Ray(
                    origin,
                    direction,
                    perpendicular(direction),
                    stokes.copy(),
                    wavelength,
                    flux / count,
                    source_index,
                    path_key=source_index,
                )
            )
            source_index += 1
        frequency = 299792458.0 / wavelength
        launched_power[frequency] = launched_power.get(frequency, 0.0) + flux
    return rays, launched_power


def _surface_scatter(
    config: dict[str, Any],
    scene: dict[str, Any],
    solids: dict[str, AnalyticSolid],
) -> dict[SurfaceRef, tuple[str, dict[str, Any]]]:
    result: dict[SurfaceRef, tuple[str, dict[str, Any]]] = {}
    for rule in config["boundaryConditions"]:
        method = rule["methodId"]
        if method not in {"ray.abg-scatter", "ray.lambertian-scatter"}:
            continue
        parameters = rule["parameters"]
        for key in surface_keys(scene, target_group(rule, "surface"), solids):
            result[key] = ("abg" if method == "ray.abg-scatter" else "lambertian", parameters)
    return result


def _bulk_scatter(config: dict[str, Any], scene: dict[str, Any]) -> dict[str, float]:
    result: dict[str, float] = {}
    for rule in config["boundaryConditions"]:
        if rule["methodId"] != "ray.hg-medium":
            continue
        anisotropy = scalar_parameter(rule["parameters"]["anisotropy"])
        for part in geometry_parts(scene, target_group(rule, "geometry")):
            result[part["id"]] = anisotropy
    return result


def _segment(ray: Ray, endpoint: np.ndarray[Any, Any], event: int) -> None:
    ray.powers.append(max(0.0, float(ray.stokes[0])))
    ray.events.append(event)
    ray.vertices.append(np.asarray(endpoint, dtype=np.float64).copy())


def _stokes(value: Any, power: float) -> np.ndarray[Any, Any]:
    result = np.asarray(_array(value), dtype=np.float64)
    return result * (power / result[0])


def _array(value: Any) -> list[Any]:
    raw = value.get("value") if isinstance(value, dict) else value
    if isinstance(raw, np.ndarray):
        raw = raw.tolist()
    return list(raw)


def _integer(value: Any) -> int:
    raw = value.get("value") if isinstance(value, dict) else value
    return int(raw)


def _cross_medium(
    stack: list[tuple[str, str]],
    exiting_root: str | None,
    entering: tuple[str, str | None] | None,
) -> list[tuple[str, str]]:
    result = list(stack)
    if exiting_root is not None:
        if not result:
            raise CaeError(
                "invalid_geometry",
                f"ray exited inactive medium {exiting_root!r}; emitter positions must be outside all ray.domain solids",
            )
        if result[-1][0] != exiting_root:
            raise CaeError(
                "invalid_geometry",
                "ray.domain solids may be nested but must not overlap",
            )
        result.pop()
    if entering is not None:
        root_id, material_name = entering
        if material_name is None:
            raise CaeError("invalid_material", f"ray domain part {root_id!r} requires a Material")
        if any(item[0] == root_id for item in result):
            raise CaeError("invalid_geometry", f"ray entered active medium {root_id!r} twice")
        result.append((root_id, material_name))
    return result


def _branch_key(parent: int, branch: int) -> int:
    value = (parent ^ (0xD1B54A32D192ED03 + branch * 0x9E3779B97F4A7C15)) & 0xFFFFFFFFFFFFFFFF
    value = ((value ^ (value >> 30)) * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
    value = ((value ^ (value >> 27)) * 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
    return value ^ (value >> 31)


def _diffract(
    ray: Ray,
    hit: Any,
    parameters: dict[str, Any],
    refractive_index: float,
    threshold: float,
    collector: PathCollector,
    *,
    target_index: float,
    target_stack: list[tuple[str, str]],
) -> list[Ray]:
    normal = hit.normal
    groove = vector_parameter(parameters["grooveDirection"], "grating groove direction")
    groove = unit_vector(groove - np.dot(groove, normal) * normal)
    incident_basis = unit_vector(groove - np.dot(groove, ray.direction) * ray.direction)
    local_stokes = polarization_basis_change(ray.stokes, ray.basis, ray.direction, incident_basis)
    spacing = scalar_parameter(parameters["spacing"])
    branches = []
    produced = False
    orders = _array(parameters['orders'])
    for transmission, name in [(False, 'reflectedEfficiencies'), (True, 'transmittedEfficiencies')]:
        for index, (order, efficiency) in enumerate(zip(orders, _array(parameters[name]))):
            if efficiency <= 0:
                continue
            direction = diffracted_direction(ray.direction, normal, groove, ray.wavelength, spacing, order,
                                            incident_index=refractive_index,
                                            outgoing_index=target_index if transmission else refractive_index,
                                            transmission=transmission)
            if direction is None:
                continue
            produced = True
            branch = ray.branch()
            branch.path_key = _branch_key(ray.path_key, index + 2 + (len(orders) if transmission else 0))
            _segment(branch, hit.position, EVENT_DIFFRACTION)
            branch.stokes = local_stokes * efficiency
            branch.direction = direction
            basis = groove - np.dot(groove, direction) * direction
            branch.basis = unit_vector(basis) if np.linalg.norm(basis) > 1e-12 else perpendicular(direction)
            branch.origin = hit.position.copy()
            branch.interactions += 1
            if transmission:
                branch.medium_stack = list(target_stack)
                branch.medium_root, branch.medium_name = target_stack[-1] if target_stack else (None, None)
            if branch.stokes[0] <= threshold:
                _segment(branch, branch.origin, EVENT_POWER_CUTOFF)
                collector.finish(branch)
            else:
                branches.append(branch)
    if not produced:
        _segment(ray, hit.position, EVENT_ABSORPTION)
        collector.finish(ray)
    return branches
