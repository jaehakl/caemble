"""Thermal material domains, prescribed temperatures, fluxes and convection."""

from dataclasses import dataclass

import numpy as np

from app.kernel.api.world import geometry_parts, material_model, scalar_parameter
from app.methods.mesh.models import VolumeMeshingProfile
from app.methods.mesh.subdomain import build_volume_subdomain
from .interfaces import prepare_interfaces


@dataclass(frozen=True)
class HeatDomain:
    mesh: object
    conductivity: np.ndarray
    fixed: dict
    boundaries: tuple
    interfaces: tuple = ()
    volumetric_capacity: object = None


async def build_heat_domain(invocation):
    scene = invocation.world["experiment"]
    rules = invocation.config["initializations"]
    mesh_rule = next(rule for rule in rules if rule["methodId"] == "heat.mesh")
    assembly = {part["id"] for target in mesh_rule["target"] for part in geometry_parts(scene, target.split(".", 2)[2])}
    p = mesh_rule["parameters"]
    sizes, layers = {}, {}
    for rule in rules:
        if rule["methodId"] == "heat.region-mesh":
            for target in rule["target"]:
                for part in geometry_parts(scene, target.split(".", 2)[2]):
                    if part["id"] in sizes:
                        raise ValueError("region mesh rules must not overlap")
                    sizes[part["id"]] = scalar_parameter(rule["parameters"]["maxElementSize"])
                    layers[part["id"]] = int(scalar_parameter(rule["parameters"].get("layerSubdivisions", 1)))
    axis = p.get("layerAxis", "none")
    axis = None if axis == "none" else "xyz".index(axis)
    profile = VolumeMeshingProfile(scalar_parameter(p["maxElementSize"]), region_max_element_sizes=tuple(sizes.items()),
                                    layer_axis=axis, layer_subdivisions=tuple(layers.items()) if axis is not None else ())
    parts = {}
    for rule in rules:
        if rule["methodId"] == "heat.body":
            for target in rule["target"]:
                for part in geometry_parts(scene, target.split(".", 2)[2]):
                    if part["id"] in parts:
                        raise ValueError("thermal regions must be selected exactly once")
                    parts[part["id"]] = part
    mesh = await build_volume_subdomain(invocation.geometry, scene, assembly, parts, profile, invocation.progress)
    tensors = {}
    for root, part in parts.items():
        model = material_model(invocation.world, part, "thermalDomain", "conduction")
        if model is None or model["model"] != "heat.fourier-conduction@1":
            raise ValueError("thermalDomain requires heat.fourier-conduction@1")
        tensor = np.asarray(model["parameters"]["k"]["value"], dtype=float).reshape(3, 3)
        value = float(np.trace(tensor) / 3)
        if not np.isfinite(value) or value <= 0 or not np.allclose(tensor, np.eye(3) * value, rtol=1e-10, atol=0):
            raise ValueError("Heat requires positive isotropic conductivity in each material region")
        tensors[root] = tensor
    conductivity = np.asarray([tensors[mesh.assembly.region_ids[r]] for r in mesh.field_domain.metadata["cellRegions"]])
    original_mesh = mesh
    mesh, interfaces, traces = prepare_interfaces(invocation, mesh, parts)
    capacity = None
    if invocation.config["parameters"].get("analysis", "steady") == "transient":
        capacities = {}
        for root, part in parts.items():
            model = material_model(invocation.world, part, "thermalDomain", "capacity")
            if model is None or model["model"] != "heat.constant-heat-capacity@1":
                raise ValueError("transient Heat requires an explicit heat-capacity model in every region")
            density, specific = (scalar_parameter(model["parameters"][key]) for key in ("density", "specificHeat"))
            if min(density, specific) <= 0:
                raise ValueError("density and specific heat must be positive")
            capacities[root] = density * specific
        capacity = np.asarray([capacities[mesh.assembly.region_ids[r]] for r in mesh.field_domain.metadata["cellRegions"]])
    fixed, boundaries, used_faces = {}, [], set()
    for rule in invocation.config["boundaryConditions"]:
        if rule["methodId"] == "heat.interface":
            continue
        selectors = [s for target in rule["target"] for group in scene["surfaceGroups"] if group["name"] == target.split(".", 2)[2] for s in group["selectors"]]
        faces = original_mesh.surface_faces(selectors)
        if traces is not None:
            faces = np.asarray([traces[tuple(sorted(face))][0][1] for face in faces])
        keys = {tuple(sorted(face)) for face in faces}
        if used_faces & keys:
            raise ValueError("thermal boundary rules must not overlap faces")
        used_faces.update(keys)
        method = rule["methodId"]
        p = {key: scalar_parameter(value) for key, value in rule["parameters"].items()}
        if method == "heat.fixed-temperature":
            for node in np.unique(faces):
                if int(node) in fixed and fixed[int(node)] != p["temperature"]:
                    raise ValueError("conflicting fixed temperatures meet at a node")
                fixed[int(node)] = p["temperature"]
        elif method == "heat.convection" and p["coefficient"] <= 0:
            raise ValueError("Robin heat-transfer coefficient must be positive")
        boundaries.append((method, faces, p))
    return HeatDomain(mesh, conductivity, fixed, tuple(boundaries), interfaces, capacity)
