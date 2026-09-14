"""Prepare immutable mass properties, reference meshes and root-level loads."""

from collections.abc import Mapping

import numpy as np

from app.kernel.api import ContentKey
from app.kernel.api.units import convert_ucum_value
from app.kernel.api.world import geometry_parts, material_model
from app.methods.geometry import TriangleMeshingProfile, TriangularMesh, mass_properties
from app.methods.rigid import quaternion_from_matrix, quaternion_to_matrix


def parameter(value):
    return value["value"] if isinstance(value, Mapping) else value


def selected_roots(invocation, rule):
    """Resolve existing Geometry groups, retaining source scope and root identity."""
    selected = {}
    for target in rule["target"]:
        source, kind, group = target.split(".", 2)
        if kind != "geometry":
            raise ValueError(f"{rule['methodId']} requires Geometry targets")
        for root in geometry_parts(invocation.world[source], group):
            selected[source, root["id"]] = root
    return selected


def model_request(invocation):
    """Only physical inputs identify a model; observation Boxes never enter its key."""
    roots = {}
    for rule in invocation.config["initializations"]:
        if rule["methodId"] != "rigid.body":
            continue
        for key, root in selected_roots(invocation, rule).items():
            if key in roots:
                raise ValueError(f"rigid body root {key!r} is selected more than once")
            roots[key] = root
    if not roots:
        raise ValueError("rigid_body requires at least one rigid.body Geometry target")
    segments = int(parameter(invocation.config["parameters"].get("massAngularSegments", 256)))
    materials = {}
    for (source, root_id), root in roots.items():
        selected = material_model(invocation.world, root, "body", "density", source)
        if selected is None or selected["model"] != "mechanics.mass-density@1":
            raise ValueError(f"rigid body {root_id!r} requires mechanics.mass-density@1")
        materials[source, root_id] = selected
    rules = [rule for rule in invocation.config["initializations"]
             if rule["methodId"] == "rigid.initial-motion"]
    rules.extend(invocation.config["boundaryConditions"])
    resolved = []
    for rule in rules:
        keys = tuple(sorted(selected_roots(invocation, rule)))
        if not keys or any(key not in roots for key in keys):
            raise ValueError(f"{rule['methodId']} must target initialized rigid body roots")
        resolved.append((rule["methodId"], keys, rule["parameters"]))
    units = {source: invocation.world[source]["lengthUnit"] for source, _ in roots}
    identity = str(ContentKey.from_parts("rigid.model.v1", roots, materials, units, segments, resolved))
    return roots, materials, resolved, segments, identity


def reference_frame(node, scale):
    """Extract a right-handed root frame; stretch/reflection stays in the solid."""
    transform = np.eye(4)
    while node["kind"] in {"transform", "instance"}:
        transform = transform @ np.asarray(node["matrix"], dtype=float).reshape(4, 4)
        node = node["child"]
    left, _, right = np.linalg.svd(transform[:3, :3])
    handedness = np.diag([1., 1., np.linalg.det(left @ right)])
    return transform[:3, 3] * scale, left @ handedness @ right


async def build_model(invocation, request):
    roots, materials, rules, segments, identity = request
    body_ids, root_ids, sources = [], [], []
    masses, densities, centers, inertias = [], [], [], []
    positions, orientations, vertices, triangles = [], [], [], []
    vertex_offsets, triangle_offsets = [0], [0]
    root_bodies = {}
    for key, root in sorted(roots.items()):
        source, root_id = key
        if invocation.cancellation is not None:
            invocation.cancellation.raise_if_cancelled()
        scene = invocation.world[source]
        scale = convert_ucum_value(1., scene["lengthUnit"], "m")
        origin, rotation = reference_frame(root["node"], scale)
        density = float(parameter(materials[key]["parameters"]["density"]))
        components = await invocation.geometry.solid_components(
            scene, root_id, "m", profile=TriangleMeshingProfile(angular_segments=segments),
            progress=invocation.progress,
        )
        root_bodies[key] = []
        for component in components:
            local_vertices = (component.mesh.vertices - origin) @ rotation
            local_mesh = TriangularMesh(local_vertices, component.mesh.triangles,
                                        component.mesh.triangle_provenance)
            try:
                properties = mass_properties(local_mesh, density)
            except ValueError as error:
                raise ValueError(f"rigid body {source}:{root_id} has invalid mass properties: {error}") from error
            root_bodies[key].append(len(body_ids))
            body_ids.append(f"{source}:{root_id}:{component.identity}")
            root_ids.append(root_id)
            sources.append(source)
            masses.append(properties.mass)
            densities.append(density)
            centers.append(properties.center)
            inertias.append(properties.inertia)
            positions.append(origin + rotation @ properties.center)
            orientations.append(quaternion_from_matrix(rotation))
            vertices.append(local_vertices)
            triangles.append(component.mesh.triangles + vertex_offsets[-1])
            vertex_offsets.append(vertex_offsets[-1] + len(local_vertices))
            triangle_offsets.append(triangle_offsets[-1] + len(component.mesh.triangles))
    count = len(body_ids)
    model = {
        "identity": identity, "bodyIds": tuple(body_ids), "rootIds": tuple(root_ids),
        "sources": tuple(sources), "masses": np.asarray(masses), "densities": np.asarray(densities),
        "localCenters": np.asarray(centers), "inertias": np.asarray(inertias),
        "vertices": np.concatenate(vertices), "triangles": np.concatenate(triangles),
        "vertexOffsets": np.asarray(vertex_offsets, dtype=np.int64),
        "triangleOffsets": np.asarray(triangle_offsets, dtype=np.int64),
        "force": np.zeros((count, 3)), "torque": np.zeros((count, 3)),
    }
    model["inverseInertias"] = np.linalg.inv(model["inertias"])
    velocity, omega = np.zeros((count, 3)), np.zeros((count, 3))
    initialized = set()
    attachment_indices, arms, forces = [], [], []
    for method, keys, values in rules:
        indices = np.asarray([body for key in keys for body in root_bodies[key]], dtype=int)
        values = {name: parameter(value) for name, value in values.items()}
        if method == "rigid.initial-motion":
            if initialized.intersection(indices):
                raise ValueError("each body may have only one rigid.initial-motion initialization")
            initialized.update(indices)
            velocity[indices] = values.get("velocity", [0., 0., 0.])
            omega[indices] = values.get("angularVelocity", [0., 0., 0.])
        elif method == "rigid.gravity":
            model["force"][indices] += model["masses"][indices, None] * np.asarray(values["acceleration"])
        elif method == "rigid.force":
            model["force"][indices] += values["force"]
        elif method == "rigid.torque":
            model["torque"][indices] += values["torque"]
        elif method == "rigid.point-force":
            attachment_indices.extend(indices)
            arms.extend(np.asarray(values["point"]) - model["localCenters"][indices])
            forces.extend(np.broadcast_to(values["force"], (len(indices), 3)))
        else:
            raise ValueError(f"unsupported rigid method {method!r}")
    model["attachmentBodyIndices"] = np.asarray(attachment_indices, dtype=np.int64)
    model["attachmentArms"] = np.asarray(arms, dtype=float).reshape(-1, 3)
    model["attachmentForces"] = np.asarray(forces, dtype=float).reshape(-1, 3)
    orientation = np.asarray(orientations)
    rotations = quaternion_to_matrix(orientation)
    momentum = np.einsum("bij,bjk,bkl,bl->bi", rotations, model["inertias"],
                         rotations.swapaxes(-1, -2), omega)
    for value in model.values():
        if isinstance(value, np.ndarray):
            value.setflags(write=False)
    return model, {"position": np.asarray(positions), "velocity": velocity,
                   "orientation": orientation, "angularMomentum": momentum}
