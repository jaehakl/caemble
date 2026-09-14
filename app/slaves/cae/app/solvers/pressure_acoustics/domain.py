"""Build an independent fluid mesh from canonical Geometry and Material inputs."""

import hashlib
from collections.abc import Mapping

import numpy as np

from app.kernel.api.world import geometry_parts, material_model
from app.methods.geometry.surfaces import select_boundary_region
from app.methods.mesh.models import VolumeMeshingProfile

from .model import AcousticModel


def parameter(value):
    return value["value"] if isinstance(value, Mapping) else value


async def build_geometry_model(invocation):
    fluid_rules = [rule for rule in invocation.config["initializations"] if rule["methodId"] == "acoustics.fluid"]
    if len(fluid_rules) != 1 or len(fluid_rules[0]["target"]) != 1:
        raise ValueError("pressure acoustics requires one homogeneous fluid geometry target")
    source, _, group = fluid_rules[0]["target"][0].split(".", 2)
    scene = invocation.world[source]
    parts = geometry_parts(scene, group)
    if len(parts) != 1:
        raise ValueError("pressure acoustics currently requires one connected fluid root")
    part = parts[0]
    material = material_model(invocation.world, part, "fluidDomain", "constitutive", source)
    if material is None or material["model"] != "acoustics.homogeneous-fluid@1":
        raise ValueError("fluidDomain requires acoustics.homogeneous-fluid@1")
    density = float(parameter(material["parameters"]["density"]))
    sound_speed = float(parameter(material["parameters"]["soundSpeed"]))
    if not np.isfinite(density) or not np.isfinite(sound_speed) or min(density, sound_speed) <= 0:
        raise ValueError("fluid density and sound speed must be finite and positive")
    resolution = float(parameter(invocation.config["parameters"]["spatialResolution"]))
    mesh = await invocation.geometry.volume_mesh(
        scene, [part["id"]], "m", VolumeMeshingProfile(resolution), progress=invocation.progress,
    )
    aliases = [tuple((source, alias.root_id, alias.source_node_id, alias.surface_index) for alias in entries)
               for entries in mesh.boundary_provenance]
    regions = {}
    for surface in scene["surfaceGroups"]:
        selectors = {(source, item["rootId"], item["sourceNodeId"], item["surfaceIndex"])
                     for item in surface["selectors"]}
        region = select_boundary_region(mesh.points, mesh.boundary_faces, aliases, selectors)
        if region is not None:
            regions[f"{source}.surface.{surface['name']}"] = region
    flat = [alias for entries in aliases for alias in entries]
    boundary_provenance = {
        "offsets": np.asarray([0, *np.cumsum([len(entries) for entries in aliases])], dtype=np.int32),
        "sources": np.asarray([item[0] for item in flat]),
        "rootIds": np.asarray([item[1] for item in flat]),
        "sourceNodeIds": np.asarray([item[2] for item in flat]),
        "surfaceIndices": np.asarray([item[3] for item in flat], dtype=np.int32),
    }
    identity = hashlib.sha256(f"{source}:{scene['geometryHash']}:{part['id']}:{resolution}".encode()).hexdigest()
    metadata = {
        "nodeIds": np.arange(len(mesh.points), dtype=np.int64),
        "boundaryFaces": mesh.boundary_faces.astype(np.int32),
        "cellRegions": mesh.cell_region_ids.astype(np.int32),
        "regionIds": np.asarray([f"{source}:{root}" for root in mesh.region_ids]),
        "supportNodes": np.empty(0, dtype=np.int32),
        "loadPoints": np.empty((0, 3)), "loadVectors": np.empty((0, 3)),
        "quality": {"cellVolumes": mesh.quality.cell_volumes, "meanRatios": mesh.quality.mean_ratios},
        "boundaryProvenance": boundary_provenance,
        "provenance": {"source": source, "geometryHash": scene["geometryHash"], "rootId": part["id"]},
    }
    return AcousticModel(mesh.points, mesh.cells, regions, density, sound_speed, identity, metadata)
