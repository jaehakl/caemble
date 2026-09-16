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
