"""Exact scalar cell transfer between subsets of one immutable volume assembly."""

import numpy as np

from app.kernel.api import FieldValue, UnstructuredMeshValue
from app.kernel.api.units import convert_ucum_value


def transfer_assembly_cell_field(field, target, *, quantity_kind, unit):
    if not isinstance(field, FieldValue) or not isinstance(field.domain, UnstructuredMeshValue) or str(field.location) != "cell":
        raise ValueError("assembly transfer requires an unstructured scalar cell field")
    if field.quantity_kind != quantity_kind:
        raise ValueError("assembly transfer quantity does not match the requested physical field")
    source = field.domain
    if not source.metadata.get("assemblyIdentity") or source.metadata["assemblyIdentity"] != target.metadata.get("assemblyIdentity"):
        raise ValueError("field belongs to a different assembly; nonmatching mesh transfer is unsupported")
    source_ids = np.asarray(source.metadata["parentCellIds"], dtype=np.int64)
    target_ids = np.asarray(target.metadata["parentCellIds"], dtype=np.int64)
    positions = {int(cell): index for index, cell in enumerate(target_ids)}
    if len(np.unique(source_ids)) != len(source_ids) or any(int(cell) not in positions for cell in source_ids):
        raise ValueError("source elements must map uniquely into the target assembly domain")
    selected = np.asarray([positions[int(cell)] for cell in source_ids])
    source_nodes = np.asarray(source.metadata["parentNodeIds"])[source.cells["tet4"]]
    target_nodes = np.asarray(target.metadata["parentNodeIds"])[target.cells["tet4"]][selected]
    if (not np.array_equal(source_nodes, target_nodes)
            or tuple(source.metadata["regionIds"]) != tuple(target.metadata["regionIds"])
            or not np.array_equal(np.asarray(source.metadata["cellRegions"]), np.asarray(target.metadata["cellRegions"])[selected])
            or source.unit != target.unit
            or not np.array_equal(source.points[source.cells["tet4"]], target.points[target.cells["tet4"]][selected])):
        raise ValueError("assembly element/material correspondence differs")
    values = np.asarray(field.values)
    if values.shape != (len(source_ids),):
        raise ValueError("heat source must contain one scalar average per native cell")
    result = np.zeros(len(target_ids), dtype=np.float64)
    result[selected] = values * convert_ucum_value(1, field.unit, unit)
    return result


def transfer_assembly_nodal_field(field, target, *, quantity_kind, unit):
    """Select a fully covered nodal field without interpolating between meshes."""
    if not isinstance(field, FieldValue) or not isinstance(field.domain, UnstructuredMeshValue) or str(field.location) != "node":
        raise ValueError("assembly transfer requires an unstructured scalar nodal field")
    source = field.domain
    if set(source.cells) != {"tet4"} or set(target.cells) != {"tet4"}:
        raise ValueError("assembly nodal transfer supports only the common tet4 mesh")
    if field.quantity_kind != quantity_kind:
        raise ValueError("assembly transfer quantity does not match the requested physical field")
    if not source.metadata.get("assemblyIdentity") or source.metadata["assemblyIdentity"] != target.metadata.get("assemblyIdentity"):
        raise ValueError("field belongs to a different assembly; nonmatching mesh transfer is unsupported")
    source_cells = np.asarray(source.metadata["parentCellIds"], dtype=np.int64)
    target_cells = np.asarray(target.metadata["parentCellIds"], dtype=np.int64)
    source_nodes = np.asarray(source.metadata["parentNodeIds"], dtype=np.int64)
    target_nodes = np.asarray(target.metadata["parentNodeIds"], dtype=np.int64)
    if any(len(np.unique(ids)) != len(ids) for ids in (source_cells, target_cells, source_nodes, target_nodes)):
        raise ValueError("assembly element and node IDs must be unique")
    cells = {int(value): index for index, value in enumerate(source_cells)}
    nodes = {int(value): index for index, value in enumerate(source_nodes)}
    if any(int(value) not in cells for value in target_cells) or any(int(value) not in nodes for value in target_nodes):
        raise ValueError("temperature field does not cover the structural assembly domain")
    selected_cells = np.asarray([cells[int(value)] for value in target_cells])
    selected_nodes = np.asarray([nodes[int(value)] for value in target_nodes])
    if (source.unit != target.unit
            or not np.array_equal(source.points[selected_nodes], target.points)
            or not np.array_equal(source_nodes[source.cells["tet4"]][selected_cells], target_nodes[target.cells["tet4"]])
            or tuple(source.metadata["regionIds"]) != tuple(target.metadata["regionIds"])
            or not np.array_equal(np.asarray(source.metadata["cellRegions"])[selected_cells], target.metadata["cellRegions"])):
        raise ValueError("assembly element/material correspondence differs")
    values = np.asarray(field.values)
    if values.shape != (len(source_nodes),) or not np.isfinite(values).all():
        raise ValueError("temperature must contain one finite scalar per native node")
    offset = convert_ucum_value(0, field.unit, unit)
    scale = convert_ucum_value(1, field.unit, unit) - offset
    return values[selected_nodes] * scale + offset
