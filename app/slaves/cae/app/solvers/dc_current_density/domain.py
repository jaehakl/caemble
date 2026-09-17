"""Electrical material regions and named equipotential terminals."""

from dataclasses import dataclass

import numpy as np

from app.kernel.api.world import geometry_parts, material_model, scalar_parameter
from app.methods.mesh.models import VolumeMeshingProfile
from app.methods.mesh.subdomain import VolumeSubdomain, build_volume_subdomain
from .materials import evaluate_conductivity


@dataclass(frozen=True)
class DcDomain:
    mesh: VolumeSubdomain
    conductivity: np.ndarray
    fixed: dict
    terminals: dict


async def build_dc_domain(invocation):
    scene = invocation.world["experiment"]
    rules = invocation.config["initializations"]
    mesh_rule = next(rule for rule in rules if rule["methodId"] == "dc.mesh")
    assembly = {part["id"] for target in mesh_rule["target"] for part in geometry_parts(scene, target.split(".", 2)[2])}
    p = mesh_rule["parameters"]
    sizes, layers = {}, {}
    for rule in rules:
        if rule["methodId"] == "dc.region-mesh":
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
        if rule["methodId"] == "dc.conductor":
            for target in rule["target"]:
                for part in geometry_parts(scene, target.split(".", 2)[2]):
                    if part["id"] in parts:
                        raise ValueError("conductor regions must be selected exactly once")
                    parts[part["id"]] = part
    mesh = await build_volume_subdomain(invocation.geometry, scene, assembly, parts, profile, invocation.progress)
    models = {}
    for root, part in parts.items():
        model = material_model(invocation.world, part, "conductor", "conduction")
        if model is None or model["model"] not in ("electrical.ohmic-conduction@1", "electrical.linear-resistivity@1"):
            raise ValueError("conductor requires an electrical conduction model")
        models[root] = model
    temperature = invocation.inputs.get("temperature")
    conductivity = evaluate_conductivity(mesh, models, None if temperature is None else temperature.value)
    fixed, terminals = {}, {}
    for rule in invocation.config["boundaryConditions"]:
        selectors = [s for target in rule["target"] for group in scene["surfaceGroups"] if group["name"] == target.split(".", 2)[2] for s in group["selectors"]]
        nodes = np.unique(mesh.surface_faces(selectors))
        if rule["methodId"] == "dc.insulation":
            continue
        name = rule["parameters"]["name"]
        if name in terminals:
            raise ValueError("terminal names must be unique")
        voltage = scalar_parameter(rule["parameters"]["voltage"])
        if rule["methodId"] == "dc.pulsed-potential":
            from .time import pulse_voltage
            voltage = pulse_voltage(invocation.inputs.get("stepControl"), mesh.field_domain, rule["parameters"])
        if any(int(node) in fixed for node in nodes):
            raise ValueError("potential terminals must not share nodes")
        terminals[name] = {"nodes": nodes, "voltage": voltage}
        fixed.update((int(node), voltage) for node in nodes)
    return DcDomain(mesh, conductivity, fixed, terminals)
