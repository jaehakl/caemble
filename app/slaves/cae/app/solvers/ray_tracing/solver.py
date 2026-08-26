from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from app.errors import CaeError
from app.solver_framework.geometry import ShellLayerGeometry, TriangularMesh
from app.solver_framework.models import SolverContext
from app.solver_framework.world import (
    experiment_scene,
    geometry_part,
    geometry_parts,
    scalar_parameter,
    single_method,
    target_group,
)

from .materials import OpticalMaterial, optical_material
from .physics import (
    abg_direction,
    cone_direction,
    cosine_hemisphere,
    henyey_greenstein,
    interface_stokes,
    multilayer_stokes,
    perpendicular,
    reflect,
    refract,
    unit_vector,
)
from .tracing import SurfaceSampler, TriangleMetadata, TriangleScene, counter_random, vector_parameter

THIN_LAYER_LIMIT = 50e-6
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


@dataclass(frozen=True, slots=True)
class ThinStack:
    layers: tuple[tuple[ShellLayerGeometry, str], ...]
    left_material: str | None
    left_root: str | None
    right_material: str | None
    right_root: str | None


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
            vertices=[point.copy() for point in self.vertices],
            powers=list(self.powers),
            events=list(self.events),
        )


@dataclass(slots=True)
class Detector:
    output: dict[str, Any]
    triangle_keys: set[tuple[str, int]]
    normal: np.ndarray[Any, Any]
    u_axis: np.ndarray[Any, Any]
    v_axis: np.ndarray[Any, Any]
    minimum_u: float
    minimum_v: float
    extent_u: float
    extent_v: float
    shape: tuple[int, int]
    power: np.ndarray[Any, Any]

    def deposit(self, position: np.ndarray[Any, Any], value: float) -> None:
        u_value = float(np.dot(position, self.u_axis))
        v_value = float(np.dot(position, self.v_axis))
        column = min(self.shape[1] - 1, max(0, int((u_value - self.minimum_u) / self.extent_u * self.shape[1])))
        row = min(self.shape[0] - 1, max(0, int((v_value - self.minimum_v) / self.extent_v * self.shape[0])))
        self.power[row, column] += value


@dataclass(slots=True)
class PathCollector:
    maximum_paths: int
    paths: list[Ray] = field(default_factory=list)
    detected_power: float = 0.0

    def finish(self, ray: Ray) -> None:
        if len(self.paths) < self.maximum_paths and len(ray.vertices) >= 2:
            self.paths.append(ray)

    def bundle(self) -> dict[str, Any]:
        vertices: list[np.ndarray[Any, Any]] = []
        offsets = [0]
        powers: list[float] = []
        path_wavelengths: list[float] = []
        events: list[int] = []
        for path in self.paths:
            vertices.extend(path.vertices)
            offsets.append(len(vertices))
            powers.extend(path.powers)
            path_wavelengths.append(path.wavelength)
            events.extend(path.events)
        vertex_values = np.asarray(vertices, dtype=np.float32).reshape((-1, 3))
        offsets_values = np.asarray(offsets, dtype=np.uint32)
        power_values = np.asarray(powers, dtype=np.float32)
        wavelength_values = np.asarray(path_wavelengths, dtype=np.float32)
        event_values = np.asarray(events, dtype=np.uint8)
        return {
            "vertices": {
                "value": vertex_values,
                "axes": [{"implicitOrdinal": True}, {"ticks": ["x", "y", "z"]}],
            },
            "pathOffsets": {"value": offsets_values, "axes": [{"implicitOrdinal": True}]},
            "segmentPower": {"value": power_values, "axes": [{"implicitOrdinal": True}]},
            "pathWavelength": {"value": wavelength_values, "axes": [{"implicitOrdinal": True}]},
            "segmentEvent": {"value": event_values, "axes": [{"implicitOrdinal": True}]},
        }


async def run(context: SolverContext) -> dict[str, Any]:
    scene = experiment_scene(context.world)
    config = context.config
    seed = _integer(config["parameters"]["seed"])
    maximum_interactions = _integer(config["parameters"]["maxInteractions"])
    maximum_paths = _integer(config["parameters"]["maxPaths"])
    minimum_power_fraction = scalar_parameter(config["parameters"]["minPowerFraction"])

    domain_rule = single_method(config, "initializations", "ray.domain")
    parts = geometry_parts(scene, target_group(domain_rule, "geometry"))
    collision_scene, meshes = await _collision_scene(context, scene, parts)
    epsilon = max(1e-12, collision_scene.diagonal * 1e-10)
    surface_scatter = _surface_scatter(config, scene, meshes)
    bulk_scatter = _bulk_scatter(config, scene)
    detectors = _detectors(config, scene, meshes)
    detector_by_triangle: dict[tuple[str, int], list[Detector]] = {}
    for detector in detectors:
        for triangle_key in detector.triangle_keys:
            detector_by_triangle.setdefault(triangle_key, []).append(detector)

    launched, total_source_power = await _sources(
        context,
        config,
        scene,
        meshes,
        seed,
        epsilon,
    )
    await context.progress({"stage": "trace", "completed": 0, "total": len(launched)})
    collector = PathCollector(maximum_paths)
    queue = deque(launched)
    processed = 0
    scheduled = len(launched)
    while queue:
        ray = queue.popleft()
        threshold = ray.source_power * minimum_power_fraction
        branches = _trace_one(
            ray,
            collision_scene,
            context.world,
            context.descriptor,
            detector_by_triangle,
            surface_scatter,
            bulk_scatter,
            maximum_interactions,
            threshold,
            epsilon,
            seed,
            collector,
        )
        queue.extend(branches)
        processed += 1
        scheduled += len(branches)
        if processed % 128 == 0 or not queue:
            await context.progress({"stage": "trace", "completed": processed, "total": scheduled})

    artifacts: dict[str, Any] = {}
    for index, detector in enumerate(detectors):
        output = detector.output
        method = output["methodId"]
        key = output["key"]
        detected_power = float(np.sum(detector.power))
        if method == "ray.detector-power":
            artifacts[key] = {"value": detected_power}
        elif method == "ray.detector-efficiency":
            artifacts[key] = {"value": detected_power / total_source_power if total_source_power > 0 else 0.0}
        elif method == "ray.detector-irradiance":
            pixel_area = detector.extent_u * detector.extent_v / math.prod(detector.shape)
            u_ticks = detector.minimum_u + (np.arange(detector.shape[1]) + 0.5) * detector.extent_u / detector.shape[1]
            v_ticks = detector.minimum_v + (np.arange(detector.shape[0]) + 0.5) * detector.extent_v / detector.shape[0]
            artifacts[key] = {
                "value": detector.power / pixel_area,
                "axes": [{"ticks": v_ticks.tolist()}, {"ticks": u_ticks.tolist()}],
            }
        await context.progress({"stage": "output", "completed": index + 1, "total": len(detectors)})
    return {
        "state": {"rayPaths": collector.bundle()},
        "artifacts": artifacts,
        "observations": {
            "launchedRays": len(launched),
            "recordedPaths": len(collector.paths),
            "detectedPower": collector.detected_power,
            "thinLayerThresholdMeters": THIN_LAYER_LIMIT,
        },
    }


async def _collision_scene(
    context: SolverContext,
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
        material_name = _material_name(part)
        materials_by_root[root_id] = material_name
        if layer is not None:
            shell_layers[root_id] = (layer, material_name)
        if layer is not None and _is_thin(layer.maximum_thickness):
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
        collision.add_mesh(
            mesh,
            TriangleMetadata("solid", root_id, materials_by_root[root_id]),
        )
    collision.build()
    return collision, meshes


def _trace_one(
    ray: Ray,
    scene: TriangleScene,
    world: dict[str, Any],
    descriptor: dict[str, Any],
    detectors: dict[tuple[str, int], list[Detector]],
    surface_scatter: dict[tuple[str, int], tuple[str, dict[str, Any]]],
    bulk_scatter: dict[str, float],
    maximum_interactions: int,
    threshold: float,
    epsilon: float,
    seed: int,
    collector: PathCollector,
) -> list[Ray]:
    if not ray.vertices:
        ray.vertices.append(ray.origin.copy())
    hit = scene.intersect(ray.origin, ray.direction, epsilon)
    escape_distance = max(scene.diagonal, epsilon * 100)
    if hit is None:
        _segment(ray, ray.origin + ray.direction * escape_distance, EVENT_ESCAPE)
        collector.finish(ray)
        return []
    medium = optical_material(world, descriptor, ray.medium_name, ray.wavelength)
    travel = hit.distance
    anisotropy = bulk_scatter.get(ray.medium_root) if ray.medium_root is not None else None
    if anisotropy is not None and medium.scattering_coefficient > 0:
        random_value = max(1e-15, counter_random(seed, ray.path_key, ray.interactions, 20))
        scatter_distance = -math.log(random_value) / medium.scattering_coefficient
        if scatter_distance < travel:
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
            ray.origin = position + ray.direction * epsilon
            ray.interactions += 1
            if ray.interactions >= maximum_interactions:
                _segment(ray, ray.origin + ray.direction * epsilon, EVENT_MAX_BOUNCES)
                collector.finish(ray)
                return []
            return [ray]
    ray.stokes *= math.exp(-medium.absorption_coefficient * travel)
    if ray.stokes[0] <= threshold:
        _segment(ray, hit.position, EVENT_POWER_CUTOFF)
        collector.finish(ray)
        return []
    detector_hits = detectors.get((hit.metadata.root_id, hit.local_triangle_index), [])
    if detector_hits:
        _segment(ray, hit.position, EVENT_DETECTOR)
        collector.detected_power += float(ray.stokes[0])
        for detector in detector_hits:
            detector.deposit(hit.position, float(ray.stokes[0]))
        collector.finish(ray)
        return []
    if ray.interactions >= maximum_interactions:
        _segment(ray, hit.position, EVENT_MAX_BOUNCES)
        collector.finish(ray)
        return []

    if hit.metadata.kind.startswith("thin-stack"):
        stack = hit.metadata.payload
        (
            reflected,
            transmitted,
            s_axis,
            transmitted_direction,
            transmission_position,
            target_name,
            target_root,
            target_stack,
        ) = _thin_interaction(
            ray, hit, stack, world, descriptor
        )
    else:
        entering = float(np.dot(ray.direction, hit.normal)) < 0
        normal = hit.normal if entering else -hit.normal
        target_stack = _cross_medium(
            ray.medium_stack,
            None if entering else hit.metadata.root_id,
            (hit.metadata.root_id, hit.metadata.material_name) if entering else None,
        )
        target_root = target_stack[-1][0] if target_stack else None
        target_name = target_stack[-1][1] if target_stack else None
        incident = optical_material(world, descriptor, ray.medium_name, ray.wavelength)
        target = optical_material(world, descriptor, target_name, ray.wavelength)
        reflected, transmitted, s_axis = interface_stokes(
            ray.stokes,
            ray.basis,
            ray.direction,
            normal,
            incident.refractive_index,
            target.refractive_index,
        )
        transmitted_direction = refract(
            ray.direction,
            normal,
            max(1e-12, incident.refractive_index.real),
            max(1e-12, target.refractive_index.real),
        )
        transmission_position = hit.position
    reflected_direction = reflect(ray.direction, hit.normal)
    scatter = surface_scatter.get((hit.metadata.root_id, hit.local_triangle_index))
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
        epsilon,
        seed,
        collector,
    )


def _thin_interaction(
    ray: Ray,
    hit: Any,
    stack: ThinStack,
    world: dict[str, Any],
    descriptor: dict[str, Any],
) -> tuple[
    np.ndarray[Any, Any],
    np.ndarray[Any, Any],
    np.ndarray[Any, Any],
    np.ndarray[Any, Any] | None,
    np.ndarray[Any, Any],
    str | None,
    str | None,
    list[tuple[str, str]],
]:
    from_left = hit.metadata.kind == "thin-stack-left"
    normal = -hit.normal if from_left else hit.normal
    ordered = stack.layers if from_left else tuple(reversed(stack.layers))
    incident_name = stack.left_material if from_left else stack.right_material
    incident_root = stack.left_root if from_left else stack.right_root
    adjacent_target_name = stack.right_material if from_left else stack.left_material
    adjacent_target_root = stack.right_root if from_left else stack.left_root
    if ray.medium_name is not None:
        incident_name = ray.medium_name
    target_stack = _cross_medium(
        ray.medium_stack,
        incident_root,
        (adjacent_target_root, adjacent_target_name)
        if adjacent_target_root is not None and adjacent_target_name is not None
        else None,
    )
    target_root = target_stack[-1][0] if target_stack else None
    target_name = target_stack[-1][1] if target_stack else None
    incident = optical_material(world, descriptor, incident_name, ray.wavelength)
    target = optical_material(world, descriptor, target_name, ray.wavelength)
    layer_values: list[tuple[complex, float]] = []
    for layer, material_name in ordered:
        material = optical_material(world, descriptor, material_name, ray.wavelength)
        if layer.minimum_thickness == layer.maximum_thickness:
            thickness = layer.maximum_thickness
        else:
            first_mesh = layer.inner if from_left else layer.outer
            second_mesh = layer.outer if from_left else layer.inner
            first_triangle = first_mesh.vertices[first_mesh.triangles[hit.local_triangle_index]]
            second_triangle = second_mesh.vertices[second_mesh.triangles[hit.local_triangle_index]]
            first_point = hit.barycentric @ first_triangle
            second_point = hit.barycentric @ second_triangle
            thickness = abs(float(np.dot(second_point - first_point, hit.normal)))
        if not math.isfinite(thickness) or thickness <= 0 or not _is_thin(thickness):
            raise CaeError("invalid_geometry", "adaptive thin shell thickness changed outside the TMM envelope")
        layer_values.append((material.refractive_index, thickness))
    reflected, transmitted, s_axis = multilayer_stokes(
        ray.stokes,
        ray.basis,
        ray.direction,
        normal,
        incident.refractive_index,
        layer_values,
        target.refractive_index,
        ray.wavelength,
    )
    transmitted_direction = refract(
        ray.direction,
        normal,
        max(1e-12, incident.refractive_index.real),
        max(1e-12, target.refractive_index.real),
    )
    exit_mesh = stack.layers[-1][0].outer if from_left else stack.layers[0][0].inner
    exit_triangle = exit_mesh.vertices[exit_mesh.triangles[hit.local_triangle_index]]
    transmission_position = hit.barycentric @ exit_triangle
    return (
        reflected,
        transmitted,
        s_axis,
        transmitted_direction,
        transmission_position,
        target_name,
        target_root,
        target_stack,
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
    epsilon: float,
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
            _set_reflection(reflected_ray, reflected, reflected_direction, s_axis, normal, scatter, epsilon, seed)
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
            transmitted_ray.origin = transmission_position + transmitted_direction * epsilon
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
        _set_reflection(ray, ray.stokes, reflected_direction, s_axis, normal, scatter, epsilon, seed)
        ray.events[-1] = EVENT_REFLECTION if scatter is None else ray.events[-1]
    else:
        ray.stokes = transmitted * (total / transmitted_power)
        ray.direction = transmitted_direction
        ray.basis = s_axis
        ray.medium_name = target_name
        ray.medium_root = target_root
        ray.medium_stack = list(target_stack)
        ray.origin = transmission_position + ray.direction * epsilon
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
    epsilon: float,
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
    ray.origin = ray.vertices[-1] + ray.direction * epsilon


async def _sources(
    context: SolverContext,
    config: dict[str, Any],
    scene: dict[str, Any],
    meshes: dict[str, TriangularMesh],
    seed: int,
    epsilon: float,
) -> tuple[list[Ray], float]:
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
    source_meshes = dict(meshes)
    total_power = 0.0
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
            mesh = await context.geometry.triangular_mesh(
                scene,
                part["id"],
                context.descriptor["referenceLengthUnit"],
                context.progress,
            )
            vertices = mesh.vertices
            center = (np.min(vertices, axis=0) + np.max(vertices, axis=0)) / 2
        else:
            group_name = target_group(rule, "surface")
            selectors = _selectors(scene, group_name)
            root_id = selectors[0]["rootId"]
            source_meshes[root_id] = await context.geometry.triangular_mesh(
                scene,
                root_id,
                context.descriptor["referenceLengthUnit"],
                context.progress,
            )
            sampler = _surface_sampler(scene, group_name, source_meshes)
        for local_index in range(count):
            if center is not None:
                origin = center.copy()
            else:
                origin, sampled_normal = sampler.sample(
                    counter_random(seed, rule_index, local_index, 0),
                    counter_random(seed, rule_index, local_index, 1),
                    counter_random(seed, rule_index, local_index, 2),
                )
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
            if sampler is not None:
                origin = origin + direction * epsilon
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
        total_power += flux
    return rays, total_power


def _surface_scatter(
    config: dict[str, Any],
    scene: dict[str, Any],
    meshes: dict[str, TriangularMesh],
) -> dict[tuple[str, int], tuple[str, dict[str, Any]]]:
    result: dict[tuple[str, int], tuple[str, dict[str, Any]]] = {}
    for rule in config["boundaryConditions"]:
        method = rule["methodId"]
        if method not in {"ray.abg-scatter", "ray.lambertian-scatter"}:
            continue
        parameters = rule["parameters"]
        for key in _surface_triangle_keys(scene, target_group(rule, "surface"), meshes):
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


def _detectors(
    config: dict[str, Any],
    scene: dict[str, Any],
    meshes: dict[str, TriangularMesh],
) -> list[Detector]:
    result: list[Detector] = []
    outputs = config["outputs"]
    for output in outputs:
        method = output["methodId"]
        group_name = target_group(output, "surface")
        keys = _surface_triangle_keys(scene, group_name, meshes)
        triangles = []
        for root_id, triangle_index in keys:
            mesh = meshes[root_id]
            triangles.append(mesh.vertices[mesh.triangles[triangle_index]])
        triangle_values = np.asarray(triangles, dtype=np.float64)
        crosses = np.cross(
            triangle_values[:, 1] - triangle_values[:, 0],
            triangle_values[:, 2] - triangle_values[:, 0],
        )
        lengths = np.linalg.norm(crosses, axis=1)
        normals = crosses / lengths[:, None]
        normal = normals[0]
        points = triangle_values.reshape((-1, 3))
        u_axis = perpendicular(normal)
        v_axis = np.cross(normal, u_axis)
        u_values = points @ u_axis
        v_values = points @ v_axis
        extent_u = float(np.ptp(u_values))
        extent_v = float(np.ptp(v_values))
        shape = (1, 1)
        if method == "ray.detector-irradiance":
            shape_values = _array(output["parameters"]["pixelShape"])
            shape = (
                _integer(shape_values[0]),
                _integer(shape_values[1]),
            )
        result.append(
            Detector(
                output,
                keys,
                normal,
                u_axis,
                v_axis,
                float(np.min(u_values)),
                float(np.min(v_values)),
                extent_u,
                extent_v,
                shape,
                np.zeros(shape, dtype=np.float64),
            )
        )
    return result


def _surface_sampler(scene: dict[str, Any], group_name: str, meshes: dict[str, TriangularMesh]) -> SurfaceSampler:
    selector = _selectors(scene, group_name)[0]
    mesh = meshes[selector["rootId"]]
    indices = mesh.triangle_indices(selector)
    return SurfaceSampler(mesh, indices)


def _surface_triangle_keys(
    scene: dict[str, Any], group_name: str, meshes: dict[str, TriangularMesh]
) -> set[tuple[str, int]]:
    result: set[tuple[str, int]] = set()
    for selector in _selectors(scene, group_name):
        root_id = selector["rootId"]
        mesh = meshes[root_id]
        indices = mesh.triangle_indices(selector)
        result.update((root_id, int(index)) for index in indices)
    return result


def _selectors(scene: dict[str, Any], group_name: str) -> tuple[dict[str, Any], ...]:
    group = next(group for group in scene["surfaceGroups"] if group["name"] == group_name)
    return tuple(group["selectors"])


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


def _material_name(part: dict[str, Any]) -> str:
    return part["material"]["name"]


def _is_thin(thickness: float) -> bool:
    return thickness < THIN_LAYER_LIMIT


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
