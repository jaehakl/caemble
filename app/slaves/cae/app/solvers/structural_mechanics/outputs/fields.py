"""Physical mesh and stress values shared by recording and visualization."""

import numpy as np

from app.kernel.api import UnstructuredMeshValue

from ..continuum import element_response
from ..solid_fields import solid_cell_average
from ..solid_elements import SolidElements


def finite_deformation_fields(model, solution):
    """Reference-cell F/P and current Cauchy response of converged hyperelastic solids."""
    if any(element.material["model"] != "mechanics.compressible-neo-hookean@1" for element in model.elements):
        raise ValueError("finite-deformation fields require Neo-Hookean solid elements")
    fields = {"deformationGradient": [], "firstPiolaStress": [], "volumeRatio": []}
    for index in range(len(model.elements)):
        values = solid_cell_average(model, solution, index)
        for name in fields:
            fields[name].append(values[name])
    return {name: np.asarray(values) for name, values in fields.items()}


def _physical_domain(model):
    """Build the complete physical mesh for automatic visualization."""
    physical_count = len(model.points) if model.physical_node_count is None else int(model.physical_node_count)
    complete_thermal_solid = model.thermal_strain is not None and physical_count == len(model.points)
    if complete_thermal_solid:
        # Thermal solids contain only physical tet4 elements in assembly order.
        # Avoid millions of temporary Python tuples and element lookup entries.
        order = np.arange(len(model.elements))
        blocks = {"tet4": (model.elements.cells.astype(np.int32) if isinstance(model.elements, SolidElements)
                          else np.asarray([element.nodes for element in model.elements], dtype=np.int32))}
    else:
        grouped = {}
        for index, element in enumerate(model.elements):
            if np.any(element.nodes >= physical_count):
                continue
            grouped.setdefault(element.kind, []).append((index, element.nodes))
        order = [index for entries in grouped.values() for index, _ in entries]
        blocks = {}
        for kind, entries in grouped.items():
            blocks[kind] = np.asarray([nodes for _, nodes in entries], dtype=np.int32)
    if model.physical_node_count is None:
        for contact in model.contacts:
            if "faces" in contact:
                blocks.setdefault("contact-tri3", []).extend(contact["faces"])
        if "contact-tri3" in blocks and not isinstance(blocks["contact-tri3"], np.ndarray):
            blocks["contact-tri3"] = np.asarray(blocks["contact-tri3"], dtype=np.int32)
    if not blocks:
        blocks["vertex"] = np.arange(physical_count, dtype=np.int32).reshape(-1, 1)

    provenance = dict(model.provenance)
    provenance["physicalNodeCount"] = physical_count
    provenance["boundaryFaces"] = np.asarray(
        model.provenance.get("boundaryFaces", np.empty((0, 3))), dtype=np.int32,
    ).reshape(-1, 3)
    if "boundaryProvenance" in model.provenance:
        original = model.provenance["boundaryProvenance"]
        provenance["boundaryProvenance"] = {
            "offsets": np.asarray(original["offsets"], dtype=np.int32),
            "sources": np.asarray(original["sources"]),
            "rootIds": np.asarray(original["rootIds"]),
            "sourceNodeIds": np.asarray(original["sourceNodeIds"]),
            "surfaceIndices": np.asarray(original["surfaceIndices"], dtype=np.int32),
        }
    if "cellRegions" in model.provenance:
        original_regions = np.asarray(model.provenance["cellRegions"], dtype=int)[order]
        retained_regions = np.unique(original_regions)
        provenance["cellRegions"] = np.searchsorted(retained_regions, original_regions).astype(np.int32)
        provenance["regionIds"] = np.asarray(model.provenance["regionIds"])[retained_regions]
    if "quality" in model.provenance:
        provenance["quality"] = {
            name: np.asarray(values)[order]
            for name, values in model.provenance["quality"].items()
        }
    if "supportNodes" in model.provenance:
        supports = np.asarray(model.provenance["supportNodes"], dtype=int)
        supports = supports[(supports >= 0) & (supports < physical_count)]
        provenance["supportNodes"] = supports.astype(np.int32)
    if "elementBlocks" in model.provenance and not complete_thermal_solid:
        element_lookup = {element: index for index, element in enumerate(order)}
        provenance["elementBlocks"] = [
            {**block, "elementIds": np.asarray([
                element_lookup[int(index)] for index in block["elementIds"] if int(index) in element_lookup
            ], dtype=np.int32)}
            for block in model.provenance["elementBlocks"]
            if any(int(index) in element_lookup for index in block["elementIds"])
        ]
    metadata = {
        "provenance": provenance,
        "nodeIds": model.node_ids[:physical_count],
        "nodeSets": model.node_sets,
        "faceSets": model.face_sets,
    }
    for name in (
        "boundaryFaces", "cellRegions", "regionIds", "supportNodes", "loadPoints",
        "loadVectors", "quality", "boundaryProvenance",
        "assemblyIdentity", "parentCellIds", "parentNodeIds",
    ):
        if name in provenance:
            metadata[name] = provenance[name]
    if model.boundary_regions:
        metadata["boundaryRegions"] = {
            name: np.intersect1d(
                model.node_ids[np.asarray(region["nodes"], dtype=int)], model.node_ids[:physical_count],
            )
            for name, region in model.boundary_regions.items()
        }
    domain = UnstructuredMeshValue(model.points[:physical_count], blocks, "m", model.identity, metadata)
    return domain, order


def _stress_tensor(values):
    values = np.asarray(values)
    return np.array([
        [values[0], values[3], values[5]],
        [values[3], values[1], values[4]],
        [values[5], values[4], values[2]],
    ])


def _tet_stress(model, solution, index):
    element = model.elements[index]
    if solution.bubble is not None:
        return solid_cell_average(model, solution, index)["cauchyStress"]
    result = solution.stresses[index]
    if result is None:
        if element.material["model"] == "mechanics.compressible-neo-hookean@1":
            raise ValueError("Neo-Hookean output requires the converged formulation stress")
        result = element_response(
            "tet4", model.points[element.nodes],
            solution.displacement[element.nodes, :3].ravel(), element.material["C"],
        )[1]
    values = np.asarray(result)
    if values.ndim != 2 or values.shape[1] != 6:
        raise ValueError("solid resultants require six-component tet4 stress")
    return _stress_tensor(values.mean(axis=0))
