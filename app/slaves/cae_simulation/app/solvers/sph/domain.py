"""Generate a single frozen fluid and verify the exact planar channel walls."""

import numpy as np

from app.kernel.api import ContentKey
from app.kernel.api.world import material_model
from app.methods.particles.geometry import resolve_box, selected_roots
from app.methods.particles.sampling import sample_mesh_lattice
from app.methods.particles.time import parameter


def model_request(invocation):
    roots = {}
    for rule in invocation.config["initializations"]:
        if rule["methodId"] == "sph.body":
            kind = parameter(rule["parameters"].get("kind", "fluid"))
            if kind not in {"fluid", "fixed-wall"}:
                raise ValueError("sph.body kind must be fluid or fixed-wall")
            for key, root in selected_roots(invocation.world, rule).items():
                if key in roots:
                    raise ValueError("each SPH Geometry root may be initialized once")
                roots[key] = (root, kind, rule["parameters"])
    domains = [rule for rule in invocation.config["initializations"] if rule["methodId"] == "sph.domain"]
    if len(domains) != 1 or not any(kind == "fluid" for _, kind, _ in roots.values()):
        raise ValueError("SPH requires fluid Geometry and exactly one sph.domain Box")
    origin, size = resolve_box(invocation.world, domains[0])
    rules = [rule for rule in invocation.config["initializations"] if rule["methodId"] == "sph.initial-motion"]
    rules += list(invocation.config.get("boundaryConditions", ()))
    physical = {key: parameter(invocation.config.get("parameters", {}).get(key, default)) for key, default in
                (("hFactor", 1.3), ("soundSpeed", 10.0), ("densityExponent", 7.0))}
    units = {source: invocation.world[source]["lengthUnit"] for source, _ in roots}
    fingerprint = str(ContentKey.from_parts("sph.model.v1", roots, units, origin, size, domains[0]["parameters"],
                                           rules, physical, invocation.world["materials"], invocation.world["materialSelections"]))
    return roots, domains[0], origin, size, rules, physical, fingerprint


def _face_area(triangle, tangents, origin, size):
    """Area of an actual triangle clipped to the domain's rectangular face."""
    polygon = [point[tangents].copy() for point in triangle]
    for axis in range(2):
        for bound, sign in ((origin[tangents[axis]], 1.0), (origin[tangents[axis]] + size[tangents[axis]], -1.0)):
            result = []
            for start, end in zip(polygon, polygon[1:] + polygon[:1]):
                start_distance, end_distance = sign * (start[axis] - bound), sign * (end[axis] - bound)
                if (start_distance >= 0) != (end_distance >= 0):
                    result.append(start + start_distance / (start_distance - end_distance) * (end - start))
                if end_distance >= 0:
                    result.append(end)
            polygon = result
            if not polygon:
                return 0.0
    polygon = np.asarray(polygon)
    return 0.5 * abs(np.sum(polygon[:, 0] * np.roll(polygon[:, 1], -1) - polygon[:, 1] * np.roll(polygon[:, 0], -1)))


def wall_faces(mesh, origin, size):
    triangles = np.asarray(mesh.vertices)[np.asarray(mesh.triangles)]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    normals /= np.linalg.norm(normals, axis=1)[:, None]
    if np.any(np.max(np.abs(normals), axis=1) < 1 - 1e-10):
        raise ValueError("SPH v1 fixed walls require world-axis-aligned planar surfaces")
    tolerance = 1e-9 * np.max(size)
    # Check the actual surfaces, so a Boolean container surrounding the fluid
    # is not mistaken for a solid filling its bounding box.
    for triangle, normal in zip(triangles, normals, strict=True):
        axis = int(np.argmax(np.abs(normal)))
        coordinate = triangle[0, axis]
        tangents = [other for other in range(3) if other != axis]
        if origin[axis] + tolerance < coordinate < origin[axis] + size[axis] - tolerance:
            if _face_area(triangle, tangents, origin, size) > tolerance**2:
                raise ValueError("SPH fixed wall Geometry must remain outside the fluid domain")
    covered = set()
    for axis in range(3):
        tangents = [other for other in range(3) if other != axis]
        for side in (0, 1):
            coordinate = origin[axis] + side * size[axis]
            coplanar = np.all(np.abs(triangles[:, :, axis] - coordinate) <= tolerance, axis=1)
            coplanar &= normals[:, axis] * (1 - 2 * side) > 1 - 1e-10
            area = sum(_face_area(triangle, tangents, origin, size) for triangle in triangles[coplanar])
            if np.isclose(area, np.prod(size[tangents]), rtol=1e-8, atol=tolerance**2):
                covered.add((axis, side))
    if not covered:
        raise ValueError("SPH fixed wall must cover a complete domain face with its actual canonical surface")
    return covered


async def build_model(invocation, request):
    roots, domain_rule, origin, size, rules, physical, identity = request
    positions, material_records, root_slices, spacings = [], [], {}, []
    selected_fluid = None
    covered = set()
    for (source, root_id), (root, kind, parameters) in sorted(roots.items()):
        if invocation.cancellation is not None:
            invocation.cancellation.raise_if_cancelled()
        mesh = await invocation.geometry.triangular_mesh(invocation.world[source], root_id, "m", progress=invocation.progress)
        if kind == "fixed-wall":
            covered.update(wall_faces(mesh, origin, size))
            continue
        model = material_model(invocation.world, root, "body", "fluid", source)
        if model is None or model["model"] != "fluidDynamics.newtonian-fluid@1":
            raise ValueError(f"SPH fluid {root_id!r} requires fluidDynamics.newtonian-fluid@1")
        material_name = root["material"]["name"]
        material_key = (source, material_name)
        if selected_fluid is not None and material_key != selected_fluid:
            raise ValueError("SPH v1 supports one fluid Material")
        selected_fluid = material_key
        if "spacing" not in parameters:
            raise ValueError("SPH fluid initialization requires particle spacing")
        spacing = float(parameter(parameters["spacing"]))
        points = await sample_mesh_lattice(mesh, spacing)
        if not len(points):
            raise ValueError(f"SPH fluid Geometry {root_id!r} generated no particles")
        if np.any(points <= origin) or np.any(points >= origin + size):
            raise ValueError("SPH particles must initially lie strictly within the domain Box")
        start = sum(len(block) for block in positions)
        root_slices[source, root_id] = slice(start, start + len(points))
        positions.append(points)
        spacings.append(spacing)
        if not material_records:
            material_records.append({"source": source, "task": invocation.task_name if source == "task" else None,
                                     "name": material_name, "definition": invocation.world["materials"][source][material_name]})
            density = float(parameter(model["parameters"]["density"]))
            viscosity = float(parameter(model["parameters"]["dynamicViscosity"]))
    if not np.allclose(spacings, spacings[0], rtol=0, atol=1e-12 * spacings[0]):
        raise ValueError("SPH v1 uses one fixed particle spacing and smoothing length")
    periodic = np.asarray([bool(parameter(domain_rule["parameters"].get(f"periodic{axis}", False))) for axis in "XYZ"])
    for axis in np.flatnonzero(~periodic):
        if any((axis, side) not in covered for side in (0, 1)):
            raise ValueError("each nonperiodic SPH domain face requires a matching fixed-wall Geometry")
    if any(periodic[axis] for axis, _ in covered):
        raise ValueError("an SPH periodic face cannot also have a fixed wall")
    points = np.concatenate(positions)
    velocity, gravity = np.zeros_like(points), np.zeros(3)
    initialized = set()
    for rule in rules:
        targets = selected_roots(invocation.world, rule)
        if not targets or any(key not in root_slices for key in targets):
            raise ValueError(f"{rule['methodId']} must target initialized fluid Geometry")
        parameters = rule["parameters"]
        if rule["methodId"] == "sph.initial-motion":
            if initialized.intersection(targets):
                raise ValueError("SPH initial velocity may be specified once per fluid root")
            initialized.update(targets)
            for key in targets:
                velocity[root_slices[key]] = parameter(parameters.get("velocity", [0, 0, 0]))
        elif rule["methodId"] == "sph.gravity":
            if set(targets) != set(root_slices):
                raise ValueError("SPH gravity must apply to the entire single-phase fluid")
            gravity += np.asarray(parameter(parameters["acceleration"]), dtype=float)
        else:
            raise ValueError(f"unsupported SPH boundary method {rule['methodId']!r}")
    h = float(physical["hFactor"]) * spacings[0]
    if min(density, h, float(physical["soundSpeed"]), float(physical["densityExponent"])) <= 0 or viscosity < 0:
        raise ValueError("SPH density, smoothing and sound speed must be positive; viscosity must be nonnegative")
    if np.any(periodic & (2 * h >= size)):
        raise ValueError("SPH periodic lengths must exceed the kernel support radius 2h")
    settings = {"h": h, "origin": origin, "size": size, "periodic": periodic, "gravity": gravity,
                "density": density, "viscosity": viscosity, "soundSpeed": float(physical["soundSpeed"]),
                "exponent": float(physical["densityExponent"])}
    model = {"identity": identity, "settings": settings, "mass": np.full(len(points), density * spacings[0]**3),
             "particleIds": np.arange(len(points), dtype=np.int32), "materialIndices": np.zeros(len(points), dtype=np.int32),
             "materials": tuple(material_records), "provenance": {"rootIds": tuple(
                 f"{source}:{root}" for (source, root), selected in root_slices.items()
                 for _ in range(selected.stop - selected.start))}}
    return model, {"positions": points, "velocity": velocity, "density": np.full(len(points), density)}
