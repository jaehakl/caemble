"""Result meaning survives native projection and both tensor transport paths."""

from dataclasses import replace

import numpy as np
import pytest

from app.kernel.api import FieldValue, UnstructuredMeshValue
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.resources import ArtifactStore, ResourceStore
from app.kernel.transport.recording import materialize_record_value
from app.kernel.transport.tensor import encode_recorded_data, encode_tensor
from caemble_catalog.result_metadata import validate_result_metadata
from tests.test_box_grid_outputs import data, grid
from app.methods.fields.box_grid import pack_box_grid


METADATA = {
    "pressureOffset": {"dtype": "float64", "quantityKind": "Pressure", "unit": "Pa"},
    "momentOrigin": {"dtype": "float64", "quantityKind": "Length", "unit": "m", "shape": [3]},
    "surfaceTargets": {"dtype": "string", "shape": [None]},
    "contribution": {"dtype": "string", "values": ["total", "pressure", "viscous"]},
}
VALUES = {"pressureOffset": -14., "momentOrigin": [1., 2., 3.], "surfaceTargets": ["experiment.surface.wall"], "contribution": "total"}


@pytest.mark.parametrize("count", [2, 20000])
def test_box_metadata_survives_artifact_projection_inline_and_attachment(count):
    profile = {**data(), "metadata": METADATA}
    value = pack_box_grid(grid(shape=(count, 1, 1)), profile, -np.ones(count))
    value["metadata"] = VALUES
    validate_artifact_payload(value, profile, "load")
    resources, leases = ResourceStore(), []
    artifacts = ArtifactStore(resources)
    try:
        handle = artifacts.publish(value, producer_task="fluid", solver_name="fixture", solver_version="1.0.0",
                                   output_name="load", artifact_type="fixture/load@1", state_revision=1)
        projected = materialize_record_value(handle, profile, resources=resources, artifacts=artifacts, owner="record", leases=leases)
        artifacts.release(handle)
        encoded, attachments, _ = encode_tensor("load", profile, projected, 1)
        assert encoded["metadata"] == VALUES
        assert bool(attachments) == (count == 20000)
        assert encoded["boxGrid"] == value["boxGrid"]
    finally:
        for lease in leases:
            resources.release(lease)
        artifacts.close()
        assert resources.stats().resource_count == 0
        resources.close()


@pytest.mark.parametrize("count", [0, 1, 10000])
@pytest.mark.parametrize("quantity", ["Pressure", "mechanics.Traction"])
def test_surface_field_projection_keeps_triangles_time_and_declared_metadata(count, quantity):
    mesh = UnstructuredMeshValue(np.arange(count * 9, dtype=float).reshape(-1, 3),
                                 {"tri3": np.arange(count * 3, dtype=np.int32).reshape(-1, 3)}, "m", "surface")
    field = FieldValue(mesh, "cell", quantity, "Pa", np.ones((count, 1, 3)), basis=np.eye(3), components=("x", "y", "z"),
                       metadata={**VALUES, "extra": "native only", "sampleAxes": [{"axis": 1, "name": "time", "unit": "s", "ticks": [0.0375]}]})
    contract = {"dtype": "float64", "quantityKind": quantity, "unit": "Pa", "tensorOrder": 0,
                "axes": [{"name": "cell"}, {"name": "time", "length": 1, "unit": "s", "quantityKind": "Time"}, {"length": 3}],
                "metadata": METADATA, "mesh": {"version": 1, "cellType": "tri3"}}
    validate_artifact_payload(field, contract, "surface", require_spatial_field=True)
    with pytest.raises(ValueError, match="metadata"):
        validate_artifact_payload(replace(field, metadata={}), contract, "surface")
    schema = {"domain": {"points": {"dtype": "float64", "axes": [{}, {"length": 3}]},
                         "cells": {"tri3": {"dtype": "int32", "axes": [{}, {"length": 3}]}}},
              "values": {key: contract[key] for key in ("dtype", "axes")},
              "metadata": {name: {"dtype": member["dtype"], **({"axes": [{} for _ in member["shape"]]} if member.get("shape") else {})}
                           for name, member in METADATA.items()}}
    resources = ResourceStore()
    artifacts = ArtifactStore(resources)
    leases = []
    try:
        handle = artifacts.publish(field, producer_task="fluid", solver_name="fixture", solver_version="1.0.0",
                                   output_name="surface", artifact_type="fixture/surface@1", state_revision=1)
        projected = materialize_record_value(handle, schema, resources=resources, artifacts=artifacts, owner="test", leases=leases)
        artifacts.release(handle)
        assert set(projected["metadata"]) == set(METADATA)
        encoded, attachments, _ = encode_recorded_data("surface", schema, projected, 1)
        assert encoded["values"]["shape"] == [count, 1, 3]
        assert encoded["values"]["axes"][1] == {"name": "time", "unit": "s", "ticks": [0.0375]}
        assert encoded["domain"]["cells"]["tri3"]["shape"] == [count, 3]
        assert bool(attachments) == (count == 10000)
    finally:
        for lease in leases:
            resources.release(lease)
        artifacts.close()
        assert resources.stats().resource_count == 0
        resources.close()


@pytest.mark.parametrize("patch", [{"pressureOffset": float("nan")}, {"momentOrigin": [1, 2]},
                                  {"surfaceTargets": [1]}, {"contribution": "unknown"}, {"extra": 1}])
def test_result_metadata_rejects_invalid_values_and_undeclared_fields(patch):
    with pytest.raises(ValueError, match="metadata"):
        validate_result_metadata(METADATA, {**VALUES, **patch})
