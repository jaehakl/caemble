"""Generate material points, an independent grid and frozen fixed-node masks."""

import numpy as np

from app.kernel.api import ContentKey
from app.kernel.api.world import material_model
from app.methods.particles.geometry import resolve_box, selected_roots
from app.methods.particles.sampling import closest_surface, sample_mesh_lattice
from app.methods.particles.time import parameter
from app.methods.structured.rasterize import rasterize_mesh_cell_centers

from .formulation import stencil


def model_request(invocation):
    roots = {}
    for rule in invocation.config["initializations"]:
        if rule["methodId"] == "mpm.body":
            kind = parameter(rule["parameters"].get("kind", "particles"))
            if kind not in {"particles", "fixed-wall"}:
                raise ValueError("mpm.body kind must be particles or fixed-wall")
            for key, root in selected_roots(invocation.world, rule).items():
                if key in roots:
                    raise ValueError("each MPM Geometry root may be initialized once")
                roots[key] = (root, kind, rule["parameters"])
    grids = [rule for rule in invocation.config["initializations"] if rule["methodId"] == "mpm.grid"]
    if len(grids) != 1 or not any(kind == "particles" for _, kind, _ in roots.values()):
        raise ValueError("MPM requires material-point Geometry and exactly one mpm.grid Box")
    origin, size = resolve_box(invocation.world, grids[0])
    rules = [rule for rule in invocation.config["initializations"] if rule["methodId"] == "mpm.initial-motion"]
    rules += list(invocation.config.get("boundaryConditions", ()))
    units = {source: invocation.world[source]["lengthUnit"] for source, _ in roots}
    identity = str(ContentKey.from_parts("mpm.model.v1", roots, units, origin, size, grids[0]["parameters"], rules,
                                        invocation.world["materials"], invocation.world["materialSelections"]))
    return roots, grids[0], origin, size, rules, identity


async def build_model(invocation, request):
    roots, grid_rule, origin, size, rules, identity = request
    cells = np.asarray(parameter(grid_rule["parameters"]["gridShape"]))
    if cells.shape != (3,) or np.any(cells < 1) or np.any(cells != np.floor(cells)):
        raise ValueError("MPM gridShape requires three positive integer cell counts")
    widths = size / cells
    if not np.allclose(widths, widths[0], rtol=1e-10, atol=0):
        raise ValueError("MPM v1 requires cubic background grid cells")
    spacing, shape = float(widths[0]), tuple((cells.astype(int) + 1).tolist())
    axes = tuple(origin[axis] + np.arange(count) * spacing for axis, count in enumerate(shape))
    grid_points = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
    fixed = np.zeros(shape, dtype=bool)
    points, reference_volume, root_slices, material_records = [], [], {}, []
    selected_material = None
    for (source, root_id), (root, kind, parameters) in sorted(roots.items()):
        if invocation.cancellation is not None:
            invocation.cancellation.raise_if_cancelled()
        mesh = await invocation.geometry.triangular_mesh(invocation.world[source], root_id, "m", progress=invocation.progress)
        if kind == "fixed-wall":
            mask = np.ascontiguousarray((await rasterize_mesh_cell_centers(mesh, *axes)).transpose(2, 1, 0))
            lower, upper = np.min(mesh.vertices, axis=0), np.max(mesh.vertices, axis=0)
            candidate = np.flatnonzero(np.all((grid_points >= lower - spacing * 1e-9) & (grid_points <= upper + spacing * 1e-9), axis=1))
            if len(candidate):
                _, distance, _, _ = closest_surface(mesh, grid_points[candidate])
                mask.reshape(-1)[candidate[distance <= spacing * 1e-9]] = True
            fixed |= mask
            continue
        material = material_model(invocation.world, root, "body", "constitutive", source)
        if material is None or material["model"] != "mechanics.compressible-neo-hookean@1":
            raise ValueError(f"MPM solid {root_id!r} requires mechanics.compressible-neo-hookean@1")
        material_name = root["material"]["name"]
        if selected_material is not None and selected_material != (source, material_name):
            raise ValueError("MPM v1 supports one solid Material")
        selected_material = (source, material_name)
        if "spacing" not in parameters:
            raise ValueError("MPM particle initialization requires spacing")
        particle_spacing = float(parameter(parameters["spacing"]))
        generated = await sample_mesh_lattice(mesh, particle_spacing)
        if not len(generated):
            raise ValueError(f"MPM Geometry {root_id!r} generated no particles")
        start = sum(len(block) for block in points)
        root_slices[source, root_id] = slice(start, start + len(generated))
        points.append(generated)
        reference_volume.append(np.full(len(generated), particle_spacing**3))
        if not material_records:
            material_records.append({"source": source, "task": invocation.task_name if source == "task" else None,
                                     "name": material_name, "definition": invocation.world["materials"][source][material_name]})
            density, young, poisson = (float(parameter(material["parameters"][name])) for name in ("density", "E", "nu"))
    if density <= 0 or young <= 0 or not -1 < poisson < 0.5:
        raise ValueError("MPM Neo-Hookean material requires density > 0, E > 0 and -1 < nu < 0.5")
    positions, volumes = np.concatenate(points), np.concatenate(reference_volume)
    stencil(positions, origin, spacing, shape)
    velocity, affine, gravity = np.zeros_like(positions), np.zeros((len(positions), 3, 3)), np.zeros(3)
    initialized = set()
    for rule in rules:
        targets = selected_roots(invocation.world, rule)
        if not targets or any(key not in root_slices for key in targets):
            raise ValueError(f"{rule['methodId']} must target initialized material-point Geometry")
        parameters = rule["parameters"]
        if rule["methodId"] == "mpm.initial-motion":
            if initialized.intersection(targets):
                raise ValueError("MPM initial motion may be specified once per solid root")
            initialized.update(targets)
            for key in targets:
                selected = root_slices[key]
                gradient = np.asarray(parameter(parameters.get("velocityGradient", np.zeros((3, 3)))))
                center = np.mean(positions[selected], axis=0)
                velocity[selected] = parameter(parameters.get("velocity", [0, 0, 0])) + (positions[selected] - center) @ gradient.T
                affine[selected] = gradient
        elif rule["methodId"] == "mpm.gravity":
            if set(targets) != set(root_slices):
                raise ValueError("MPM gravity must apply to all material points")
            gravity += np.asarray(parameter(parameters["acceleration"]), dtype=float)
        else:
            raise ValueError(f"unsupported MPM boundary method {rule['methodId']!r}")
    settings = {"origin": origin, "spacing": spacing, "shape": shape, "density": density,
                "shear": young / (2 * (1 + poisson)), "lame": young * poisson / ((1 + poisson) * (1 - 2 * poisson)),
                "gravity": gravity, "fixedNodes": np.flatnonzero(fixed)}
    model = {"identity": identity, "settings": settings, "mass": density * volumes, "referenceVolume": volumes,
             "particleIds": np.arange(len(positions), dtype=np.int32), "materialIndices": np.zeros(len(positions), dtype=np.int32),
             "materials": tuple(material_records), "provenance": {"rootIds": tuple(
                 f"{source}:{root}" for (source, root), selected in root_slices.items()
                 for _ in range(selected.stop - selected.start))}}
    return model, {"positions": positions, "velocity": velocity, "deformationGradient": np.broadcast_to(np.eye(3), (len(positions), 3, 3)).copy(),
                   "affineVelocityGradient": affine}
