"""Particle-source preparation and frozen Material-pair coefficients."""

import numpy as np
from scipy.spatial import cKDTree

from app.kernel.api import ContentKey
from app.kernel.api.world import material_model_by_name, interaction_model_by_name
from app.methods.geometry import TriangularMesh
from app.methods.particles.geometry import selected_roots
from app.methods.particles.sampling import SurfaceQuery, sample_mesh_lattice
from app.methods.particles.time import parameter


def model_request(invocation):
    roots, parameters = {}, {}
    for rule in invocation.config["initializations"]:
        if rule["methodId"] != "dem.body":
            continue
        values = {name: parameter(value) for name, value in rule["parameters"].items()}
        if values["kind"] not in {"particles", "fixed-wall"}:
            raise ValueError("dem.body kind must be particles or fixed-wall")
        for key, root in selected_roots(invocation.world, rule).items():
            if key in roots:
                raise ValueError(f"DEM Geometry {key!r} is initialized more than once")
            roots[key], parameters[key] = root, values
    gravity = np.asarray(parameter(invocation.config["parameters"].get("gravity", [0, 0, 0])), dtype=float)
    if gravity.shape != (3,) or not np.all(np.isfinite(gravity)):
        raise ValueError("DEM gravity must be a finite world vector")
    physical = {source: {"lengthUnit": invocation.world[source]["lengthUnit"],
                         "materials": invocation.world["materials"][source]} for source in ("experiment", "task")}
    identity = str(ContentKey.from_parts("dem-1.0.0", roots, parameters, physical,
        invocation.world.get("materialSelections", {}), invocation.world.get("interactions", {}),
        invocation.world.get("interactionSelections", {}), invocation.world.get("interactionDefaults", {}), gravity))
    return roots, parameters, gravity, identity


async def build_model(invocation, request):
    roots, parameters, gravity, identity = request
    positions, velocity, omega, masses, radii, material_indices, provenance, walls = ([] for _ in range(8))
    materials, material_keys = [], {}
    for key, root in sorted(roots.items()):
        source, root_id = key
        values = parameters[key]
        if not root.get("material"):
            raise ValueError(f"DEM Geometry {root_id!r} requires a Material")
        name = root["material"]["name"]
        material_key = source, name
        if material_key not in material_keys:
            material_keys[material_key] = len(materials)
            materials.append({"source": source, "task": invocation.task_name if source == "task" else None,
                              "name": name, "definition": invocation.world["materials"][source][name]})
        material_index = material_keys[material_key]
        mesh = await invocation.geometry.triangular_mesh(invocation.world[source], root_id, "m", progress=invocation.progress)
        if values["kind"] == "fixed-wall":
            walls.append({"id": f"{source}:{root_id}", "materialIndex": material_index,
                          "vertices": mesh.vertices, "triangles": mesh.triangles,
                          "features": tuple(f"{p.source_node_id}:{p.surface_index}" for p in mesh.triangle_provenance)})
            continue
        material = material_model_by_name(invocation.world, name, "body", "density", source)
        if material is None or material["model"] != "mechanics.mass-density@1":
            raise ValueError(f"DEM particle Geometry {root_id!r}, Material {name!r} requires mechanics.mass-density@1")
        density = float(parameter(material["parameters"]["density"]))
        radius = float(values.get("radius", 0))
        spacing = float(values.get("spacing", 2 * radius))
        if radius <= 0 or density <= 0 or not np.isfinite(radius + density) or spacing < 2 * radius:
            raise ValueError("DEM particles require positive radius/density and spacing at least the diameter")
        generated = await sample_mesh_lattice(mesh, spacing, clearance=radius)
        if not len(generated):
            raise ValueError(f"DEM Geometry {root_id!r} contains no complete particles at the requested radius")
        count = len(generated)
        positions.extend(generated)
        velocity.extend(np.broadcast_to(values.get("velocity", [0, 0, 0]), (count, 3)))
        omega.extend(np.broadcast_to(values.get("angularVelocity", [0, 0, 0]), (count, 3)))
        masses.extend(np.full(count, density * 4 * np.pi * radius**3 / 3))
        radii.extend(np.full(count, radius))
        material_indices.extend([material_index] * count)
        provenance.extend([f"{source}:{root_id}"] * count)
    if not positions:
        raise ValueError("DEM requires at least one particle source")
    radius = np.asarray(radii)
    mass = np.asarray(masses)
    coefficients, prepared_models = {}, {}
    used = set(material_indices)
    wall_materials = {wall["materialIndex"] for wall in walls}
    pairs = {tuple(sorted((first, second))) for first in used for second in used | wall_materials}
    for first, second in sorted(pairs):
        names = materials[first]["name"], materials[second]["name"]
        contact = interaction_model_by_name(invocation.world, *names, "contact", "contact")
        friction = interaction_model_by_name(invocation.world, *names, "contact", "friction")
        if contact is None or contact["model"] != "contact.linear-spring-damper@1" or friction is None:
            raise ValueError("DEM requires its frozen Catalog default or selected contact and friction models")
        prepared_models[f"{first}:{second}"] = {"contact": contact, "friction": friction}
        coefficients[f"{first}:{second}"] = np.array([
            *(float(parameter(contact["parameters"][name])) for name in ("kn", "kt", "cn", "ct")),
            *(float(parameter(friction["parameters"][name])) for name in ("muStatic", "muDynamic"))])
    model = {"identity": identity, "mass": mass, "radius": radius, "inertia": .4 * mass * radius**2,
             "particleIds": np.arange(len(mass), dtype=np.int32),
             "materialIndices": np.asarray(material_indices, dtype=np.int32), "materials": tuple(materials),
             "provenance": {"rootIds": tuple(provenance)}, "walls": tuple(walls),
             "coefficients": coefficients, "preparedModels": prepared_models, "gravity": gravity}
    state = {"positions": np.asarray(positions), "velocity": np.asarray(velocity, dtype=float),
             "angularVelocity": np.asarray(omega, dtype=float), "contactHistory": {}, "frictionDissipation": 0.0}
    tree = cKDTree(state["positions"])
    for first, second in tree.query_pairs(2 * radius.max()):
        if np.linalg.norm(state["positions"][first] - state["positions"][second]) < (radius[first] + radius[second]) * (1 - 1e-9):
            raise ValueError("DEM particle sources produce overlapping particles")
    for wall in wall_queries(model):
        closest, distance, normal, _ = wall["query"].closest(state["positions"])
        if np.any((distance < radius * (1 - 1e-9)) | (np.einsum("ij,ij->i", state["positions"] - closest, normal) < -1e-10)):
            raise ValueError("DEM particles initially overlap a fixed wall")
    return model, state


def wall_queries(model):
    result = []
    for wall in model["walls"]:
        query = SurfaceQuery(TriangularMesh(wall["vertices"], wall["triangles"], ()),
                             surface_keys=wall["features"] or None)
        result.append({"id": wall["id"], "materialIndex": wall["materialIndex"], "query": query})
    return result
