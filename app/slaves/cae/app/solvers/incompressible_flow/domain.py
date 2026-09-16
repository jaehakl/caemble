"""Resolve the frozen fluid material and physical boundary faces of a CSG volume."""

from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

from app.kernel.api import ContentKey
from app.kernel.api.world import geometry_parts, material_model
from app.methods.finite_volume.tetrahedral import FaceMesh, create_fv_mesh
from app.methods.mesh.models import VolumeMeshingProfile
from .periodic import apply_periodic, boundary_patches, freeze_periodic, split_gravity


def parameter(value):
    return value["value"] if isinstance(value, Mapping) else value


@dataclass(frozen=True)
class FlowDomain:
    mesh: FaceMesh
    density: float
    viscosity: float
    gravity: np.ndarray
    boundary_velocity: np.ndarray
    boundary_pressure: np.ndarray
    identity: str
    metadata: dict
    surface_regions: dict | None = None
    boundary_roles: np.ndarray | None = None
    boundary_patches: dict | None = None
    periodic_topology: dict | None = None


def prepare_boundaries(mesh, regions, rules, analysis="steady-stokes"):
    """Unassigned exterior faces are walls; explicit conditions may not overlap."""
    velocity = np.full((len(mesh.faces), 3), np.nan)
    pressure = np.full(len(mesh.faces), np.nan)
    exterior = mesh.neighbour < 0
    velocity[exterior] = 0.0
    assigned = np.zeros(len(mesh.faces), dtype=bool)
    periodic = np.zeros(len(mesh.faces), dtype=bool)
    for rule in rules:
        selected = []
        for target in rule["target"]:
            indices = regions.get(target)
            if indices is None or not len(indices):
                raise ValueError(f"flow boundary target {target!r} has no fluid boundary")
            selected.extend(indices)
        faces = np.unique(np.asarray(selected, dtype=int))
        if not len(faces):
            raise ValueError("flow boundary conditions require a nonempty surface selection")
        if np.any(assigned[faces]):
            conflict = int(faces[np.flatnonzero(assigned[faces])[0]])
            raise ValueError(f"flow boundary conditions overlap at face {conflict}, "
                             f"position {mesh.face_centers[conflict].tolist()}")
        assigned[faces] = True
        method = rule["methodId"]
        values = rule.get("parameters", {})
        if method == "flow.no-slip":
            velocity[faces] = 0.0
        elif method == "flow.velocity-inlet":
            prescribed = np.asarray(parameter(values["velocity"]), dtype=float)
            if prescribed.shape != (3,) or not np.all(np.isfinite(prescribed)):
                raise ValueError("flow velocity must be a finite world Cartesian vector")
            velocity[faces] = prescribed
        elif method == "flow.pressure-open":
            prescribed = float(parameter(values["pressure"]))
            if not np.isfinite(prescribed):
                raise ValueError("flow opening pressure must be finite gauge pressure in Pa")
            pressure[faces] = prescribed
            velocity[faces] = np.nan
        elif method == "flow.periodic":
            if len(rule["target"]) != 2:
                raise ValueError("flow.periodic requires exactly two ordered surface targets")
            periodic[faces] = True
            velocity[faces] = np.nan
        else:
            raise ValueError(f"unsupported flow boundary condition {method!r}")
    prescribed_velocity = exterior & np.isfinite(velocity[:, 0])
    if not np.any(prescribed_velocity) and not (analysis == "transient-navier-stokes" and np.all(periodic[exterior])):
        if np.all(periodic[exterior]):
            raise ValueError("steady periodic flow requires a no-slip or prescribed velocity boundary to determine mean velocity")
        raise ValueError("all pressure-open boundaries leave the Stokes velocity undetermined; "
                         "a no-slip or prescribed velocity boundary is required")
    if not np.any(np.isfinite(pressure)):
        fluxes = np.einsum("ij,ij->i", velocity[prescribed_velocity], mesh.area_vectors[prescribed_velocity])
        if abs(float(fluxes.sum())) > 1e-10 * max(float(np.abs(fluxes).sum()), np.finfo(float).tiny):
            raise ValueError(f"closed flow boundary has incompatible net prescribed volume flux {fluxes.sum():g} m3/s")
    return velocity, pressure


def resolve_surface_regions(scene, source, mesh, metadata):
    """Resolve selectors to the preserved canonical physical boundary order."""
    provenance = metadata["boundaryProvenance"]
    lookup = {}
    for boundary in range(len(mesh.boundary_face_map)):
        for index in range(provenance["offsets"][boundary], provenance["offsets"][boundary + 1]):
            key = (str(provenance["rootIds"][index]), str(provenance["sourceNodeIds"][index]),
                   int(provenance["surfaceIndices"][index]))
            lookup.setdefault(key, set()).add(boundary)
    result = {}
    for group in scene["surfaceGroups"]:
        selected = set()
        for selector in group["selectors"]:
            selected.update(lookup.get((selector["rootId"], selector["sourceNodeId"], selector["surfaceIndex"]), ()))
        result[f"{source}.surface.{group['name']}"] = np.asarray(sorted(selected), dtype=np.int64)
    return result


def domain_request(invocation, controls=None):
    """Identify selected physics independently of observation roots and scene hashes."""
    rules = [rule for rule in invocation.config["initializations"] if rule["methodId"] == "flow.fluid"]
    if len(rules) != 1 or len(rules[0]["target"]) != 1:
        raise ValueError("incompressible flow requires exactly one homogeneous fluid geometry target")
    source, _, group = rules[0]["target"][0].split(".", 2)
    scene = invocation.world[source]
    parts = geometry_parts(scene, group)
    if len(parts) != 1:
        raise ValueError("incompressible flow requires one connected fluid CSG root")
    part = parts[0]
    material = material_model(invocation.world, part, "fluidDomain", "constitutive", source)
    if material is None or material["model"] != "fluidDynamics.newtonian-fluid@1":
        raise ValueError("fluidDomain requires fluidDynamics.newtonian-fluid@1")
    density = float(parameter(material["parameters"]["density"]))
    viscosity = float(parameter(material["parameters"]["dynamicViscosity"]))
    if not np.isfinite(density) or not np.isfinite(viscosity) or min(density, viscosity) <= 0:
        raise ValueError("Stokes density and dynamic viscosity must be finite and positive")
    parameters = invocation.config["parameters"]
    resolution = float(parameter(parameters["spatialResolution"]))
    gravity = np.asarray(parameter(parameters.get("gravity", [0., 0., 0.])), dtype=float)
    if gravity.shape != (3,) or not np.all(np.isfinite(gravity)):
        raise ValueError("gravity must be a finite world Cartesian acceleration vector")
    boundaries = []
    for rule in invocation.config["boundaryConditions"]:
        selectors = []
        for target in rule["target"]:
            target_source, kind, name = target.split(".", 2)
            if target_source != source or kind != "surface":
                raise ValueError(f"flow boundary target {target!r} has no fluid boundary")
            matches = [surface for surface in scene["surfaceGroups"] if surface["name"] == name]
            fluid_selectors = [selector for surface in matches for selector in surface["selectors"]
                               if selector["rootId"] == part["id"]]
            if not fluid_selectors:
                raise ValueError(f"flow boundary target {target!r} has no fluid boundary")
            selectors.extend(fluid_selectors)
        boundaries.append((rule["methodId"], selectors, rule.get("parameters", {})))
    identity = str(ContentKey.from_parts("incompressible-flow.model.v3", source, part["id"],
        part["node"], scene["lengthUnit"], material, resolution, gravity, boundaries,
        parameter(parameters.get("analysis", "steady-stokes")), controls or {}))
    return {"source": source, "scene": scene, "part": part, "density": density,
            "viscosity": viscosity, "gravity": gravity, "resolution": resolution, "identity": identity}


async def build_domain(invocation, request=None):
    request = domain_request(invocation) if request is None else request
    source, scene, part = request["source"], request["scene"], request["part"]
    if invocation.cancellation is not None:
        invocation.cancellation.raise_if_cancelled()
    volume = await invocation.geometry.volume_mesh(
        scene, [part["id"]], "m", VolumeMeshingProfile(request["resolution"]), progress=invocation.progress,
    )
    if invocation.cancellation is not None:
        invocation.cancellation.raise_if_cancelled()
    mesh = create_fv_mesh(volume.points, volume.cells, volume.boundary_faces)
    regions = {}
    for surface in scene["surfaceGroups"]:
        selected = [volume.boundary_face_indices(selector) for selector in surface["selectors"]]
        indices = np.unique(np.concatenate(selected)) if selected else np.empty(0, dtype=int)
        regions[f"{source}.surface.{surface['name']}"] = mesh.boundary_face_map[indices]
    analysis = parameter(invocation.config["parameters"].get("analysis", "steady-stokes"))
    velocity, pressure = prepare_boundaries(mesh, regions, invocation.config["boundaryConditions"], analysis)
    boundary_ids = mesh.boundary_face_map
    roles = np.full(len(boundary_ids), "wall", dtype="<U13")
    roles[np.isfinite(pressure[boundary_ids])] = "pressure-open"
    roles[np.any(velocity[boundary_ids] != 0, axis=1) & np.all(np.isfinite(velocity[boundary_ids]), axis=1)] = "velocity"
    roles[~np.isfinite(pressure[boundary_ids]) & ~np.all(np.isfinite(velocity[boundary_ids]), axis=1)] = "periodic"
    # A stationary explicitly prescribed velocity remains a velocity condition,
    # not an automatically selected solid wall for traction export.
    for rule in invocation.config["boundaryConditions"]:
        if rule["methodId"] == "flow.velocity-inlet":
            selected = np.concatenate([regions[target] for target in rule["target"]])
            roles[np.isin(boundary_ids, selected)] = "velocity"
    pairs = [{"sourceFaces": regions[rule["target"][0]], "targetFaces": regions[rule["target"][1]],
              "translation": parameter(rule["parameters"]["translation"])}
             for rule in invocation.config["boundaryConditions"] if rule["methodId"] == "flow.periodic"]
    mesh = apply_periodic(mesh, pairs, invocation.cancellation)
    velocity, pressure = velocity[mesh.interface_owner_faces], pressure[mesh.interface_owner_faces]
    aliases = [entry for entries in volume.boundary_provenance for entry in entries]
    metadata = {
        "nodeIds": np.arange(len(mesh.points), dtype=np.int64),
        "boundaryFaces": np.asarray(volume.boundary_faces, dtype=np.int32),
        "cellRegions": np.asarray(volume.cell_region_ids, dtype=np.int32),
        "regionIds": np.asarray([f"{source}:{root}" for root in volume.region_ids]),
        "supportNodes": np.empty(0, dtype=np.int32),
        "loadPoints": np.empty((0, 3)),
        "loadVectors": np.empty((0, 3)),
        "quality": {"cellVolumes": mesh.cell_volumes, "meanRatios": volume.quality.mean_ratios,
                    "maximumNonorthogonality": mesh.maximum_nonorthogonality,
                    "maximumSkewness": mesh.maximum_skewness},
        "boundaryProvenance": {
            "offsets": np.asarray([0, *np.cumsum([len(entries) for entries in volume.boundary_provenance])], dtype=np.int32),
            "sources": np.asarray([source] * len(aliases)),
            "rootIds": np.asarray([entry.root_id for entry in aliases]),
            "sourceNodeIds": np.asarray([entry.source_node_id for entry in aliases]),
            "surfaceIndices": np.asarray([entry.surface_index for entry in aliases], dtype=np.int32),
        },
        "provenance": {"source": source, "geometryHash": scene["geometryHash"], "rootId": part["id"]},
        "analysis": analysis,
        "pressureReference": "pressure-boundaries" if np.any(np.isfinite(pressure)) else "volume-mean-zero",
    }
    hydrostatic_gravity, driving_acceleration = split_gravity(mesh, request["gravity"])
    metadata.update(pressureReferencePoint=np.average(mesh.cell_centers, axis=0, weights=mesh.cell_volumes),
                    hydrostaticGravity=hydrostatic_gravity, drivingAcceleration=driving_acceleration)
    surface_regions = resolve_surface_regions(scene, source, mesh, metadata)
    return FlowDomain(mesh, request["density"], request["viscosity"], request["gravity"],
                      velocity, pressure, request["identity"], metadata, surface_regions, roles,
                      boundary_patches(mesh), freeze_periodic(mesh))
