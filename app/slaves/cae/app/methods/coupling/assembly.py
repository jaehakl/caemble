"""Exact scalar field transfer between subsets of one immutable volume assembly."""

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
    order = np.argsort(target_ids)
    sorted_ids = target_ids[order]
    positions = np.searchsorted(sorted_ids, source_ids)
    if (len(np.unique(source_ids)) != len(source_ids) or len(np.unique(target_ids)) != len(target_ids)
            or np.any(positions >= len(sorted_ids)) or not np.array_equal(sorted_ids[positions], source_ids)):
        raise ValueError("source elements must map uniquely into the target assembly domain")
    selected = order[positions]
    if (tuple(source.metadata["regionIds"]) != tuple(target.metadata["regionIds"])
            or not np.array_equal(np.asarray(source.metadata["cellRegions"]), np.asarray(target.metadata["cellRegions"])[selected])
            or source.unit != target.unit):
        raise ValueError("assembly element/material correspondence differs")
    values = np.asarray(field.values)
    if values.shape != (len(source_ids),) or not np.isfinite(values).all():
        raise ValueError("cell field must contain one finite scalar average per native cell")
    source_nodes = np.asarray(source.metadata["parentNodeIds"])
    target_nodes = np.asarray(target.metadata["parentNodeIds"])
    for start in range(0, len(source_ids), 65536):
        selection = slice(start, start + 65536)
        source_cells = source.cells["tet4"][selection]
        target_cells = target.cells["tet4"][selected[selection]]
        if (not np.array_equal(source_nodes[source_cells], target_nodes[target_cells])
                or not np.array_equal(source.points[source_cells], target.points[target_cells])):
            raise ValueError("assembly element/material correspondence differs")
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
        raise ValueError("nodal field does not cover the target assembly domain")
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
        raise ValueError("nodal field must contain one finite scalar per native node")
    offset = convert_ucum_value(0, field.unit, unit)
    scale = convert_ucum_value(1, field.unit, unit) - offset
    return values[selected_nodes] * scale + offset


def transfer_assembly_element_nodal_field(field, target, *, quantity_kind, unit):
    """Return four scalar values per tet, preserving each side of split interfaces.

    Original node IDs may repeat on split interfaces. Element IDs and each
    element's ordered corners identify the values without merging those nodes.
    The consuming solver specifies the required quantity and output unit.
    """
    if (not isinstance(field, FieldValue) or not isinstance(field.domain, UnstructuredMeshValue)
            or str(field.location) != "node"):
        raise ValueError("assembly transfer requires an unstructured scalar nodal field")
    if field.quantity_kind != quantity_kind:
        raise ValueError("assembly transfer quantity does not match the requested physical field")
    source = field.domain
    if (set(source.cells) != {"tet4"} or set(target.cells) != {"tet4"}
            or not source.metadata.get("assemblyIdentity")
            or source.metadata["assemblyIdentity"] != target.metadata.get("assemblyIdentity")):
        raise ValueError("field belongs to a different assembly or unsupported mesh")
    source_ids = np.asarray(source.metadata["parentCellIds"], dtype=np.int64)
    target_ids = np.asarray(target.metadata["parentCellIds"], dtype=np.int64)
    order = np.argsort(source_ids)
    sorted_ids = source_ids[order]
    positions = np.searchsorted(sorted_ids, target_ids)
    if (len(np.unique(source_ids)) != len(source_ids) or len(np.unique(target_ids)) != len(target_ids)
            or np.any(positions >= len(sorted_ids)) or not np.array_equal(sorted_ids[positions], target_ids)):
        raise ValueError("nodal field does not uniquely cover the required assembly elements")
    if tuple(source.metadata["regionIds"]) != tuple(target.metadata["regionIds"]) or source.unit != target.unit:
        raise ValueError("assembly material correspondence differs")
    selected = order[positions]
    source_nodes = np.asarray(source.metadata["parentNodeIds"])
    target_nodes = np.asarray(target.metadata["parentNodeIds"])
    values = np.asarray(field.values)
    if values.shape != (len(source_nodes),) or not np.isfinite(values).all():
        raise ValueError("nodal field must have one finite value per native node")
    if not np.array_equal(np.asarray(source.metadata["cellRegions"])[selected], target.metadata["cellRegions"]):
        raise ValueError("assembly material correspondence differs")
    result = np.empty((len(target_ids), 4))
    offset = convert_ucum_value(0, field.unit, unit)
    scale = convert_ucum_value(1, field.unit, unit) - offset
    for start in range(0, len(target_ids), 65536):
        selection = slice(start, start + 65536)
        source_cells = source.cells["tet4"][selected[selection]]
        target_cells = target.cells["tet4"][selection]
        if (not np.array_equal(source_nodes[source_cells], target_nodes[target_cells])
                or not np.array_equal(source.points[source_cells], target.points[target_cells])):
            raise ValueError("assembly element/node correspondence differs")
        result[selection] = values[source_cells] * scale + offset
    return result
