from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np
import pytest

from app.runtime_kernel.api import BundleValue, FieldValue, StructuredGridValue, UnstructuredMeshValue
from app.runtime_kernel.resources import ArtifactStore, ResourceStore
from app.runtime_kernel.transport.recording import materialize_record_value
from app.tensor import decode_attachment_tensors, encode_recorded_data
from tests.recording_fixtures import MESH_FIELD_SCHEMA


def decode_record(schema: Mapping[str, Any], encoded: dict[str, Any], attachments: list[Any]) -> Any:
    if "dtype" not in schema:
        return {name: decode_record(member, encoded[name], attachments) for name, member in schema.items()}
    if encoded["storage"]["kind"] == "inline":
        return np.asarray(encoded["storage"]["value"], dtype=str if schema["dtype"] == "string" else schema["dtype"])
    return decode_attachment_tensors({"dtype": schema["dtype"], "value": encoded}, attachments)["value"]


@pytest.mark.parametrize("node_count", [4, 10000])
def test_mesh_field_record_roundtrip_preserves_domain_and_physical_meaning(node_count: int) -> None:
    resources = ResourceStore()
    artifacts = ArtifactStore(resources)
    leases = []
    points = np.arange(node_count * 3, dtype=np.float64).reshape(-1, 3)
    cells = np.arange(node_count, dtype=np.int64).reshape(-1, 4)
    temperatures = np.linspace(290.0, 310.0, node_count)
    field = FieldValue(
        UnstructuredMeshValue(
            points, {"tetra4": cells}, "m", "deformed-domain",
            {"sourceIdentity": "original-domain", "unrecorded": "not selected"},
        ),
        "node", "thermodynamics.Temperature", "K", temperatures,
    )
    handle = artifacts.publish(
        field, producer_task="deform", solver_name="fixture", solver_version="1.0.0",
        output_name="temperature", artifact_type="fixture/temperature", state_revision=1,
        copy_arrays=False,
    )
    try:
        recorded = materialize_record_value(
            handle, MESH_FIELD_SCHEMA, resources=resources, artifacts=artifacts, owner="record", leases=leases,
        )
        assert recorded["values"] is resources.resolve(handle.resource_ref).values
        assert recorded["domain"]["metadata"] == {"sourceIdentity": "original-domain"}
        artifacts.release(handle)
        encoded, attachments, _ = encode_recorded_data("mesh", MESH_FIELD_SCHEMA, recorded, 1)
        assert bool(attachments) is (node_count == 10000)
        decoded = decode_record(MESH_FIELD_SCHEMA, encoded, attachments)
        np.testing.assert_array_equal(decoded["domain"]["points"], points)
        np.testing.assert_array_equal(decoded["domain"]["cells"]["tetra4"], cells)
        np.testing.assert_array_equal(decoded["values"], temperatures)
        assert decoded["domain"]["identity"].item() == "deformed-domain"
        assert decoded["domain"]["metadata"]["sourceIdentity"].item() == "original-domain"
        assert decoded["domain"]["lengthUnit"].item() == "m"
        assert decoded["location"].item() == "node"
        assert decoded["quantity"].item() == "thermodynamics.Temperature"
        assert decoded["valueUnit"].item() == "K"
    finally:
        for lease in reversed(leases):
            resources.release(lease)
        artifacts.close()
        assert resources.stats().resource_count == 0
        resources.close()


def test_structured_field_leaf_retains_axes_and_group_uses_coordinates() -> None:
    resources = ResourceStore()
    artifacts = ArtifactStore(resources)
    coordinates = np.arange(3, dtype=np.float64)
    values = np.ones(3)
    field = FieldValue(StructuredGridValue((3,), (coordinates,), "m", "grid"), "cell", "Length", "m", values)
    try:
        leaf = materialize_record_value(
            field, {"dtype": "float64"}, resources=resources, artifacts=artifacts, owner="record", leases=[],
        )
        assert leaf["value"] is values
        assert leaf["axes"][0]["ticks"] is coordinates
        schema = {
            "domain": {"shape": {"dtype": "int64"}, "coordinates": {"axis0": {"dtype": "float64"}}},
            "values": {"dtype": "float64"},
        }
        group = materialize_record_value(
            field, schema, resources=resources, artifacts=artifacts, owner="record", leases=[],
        )
        assert group["domain"]["coordinates"]["axis0"] is coordinates
        assert group["domain"]["shape"] == (3,)
        with pytest.raises(KeyError, match="components"):
            materialize_record_value(
                field, {"components": {"dtype": "string"}},
                resources=resources, artifacts=artifacts, owner="record", leases=[],
            )
    finally:
        artifacts.close()
        resources.close()


def test_ordinary_record_group_does_not_silently_drop_unknown_members() -> None:
    resources = ResourceStore()
    artifacts = ArtifactStore(resources)
    try:
        recorded = materialize_record_value(
            {"declared": 1, "unknown": 2}, {"declared": {"dtype": "int64"}},
            resources=resources, artifacts=artifacts, owner="record", leases=[],
        )
        assert recorded == {"declared": 1, "unknown": 2}
    finally:
        artifacts.close()
        resources.close()


def test_legacy_bundle_tensor_axes_are_values_not_nested_schemas() -> None:
    resources = ResourceStore()
    artifacts = ArtifactStore(resources)
    ticks = np.arange(3, dtype=np.float64)
    values = np.ones(3)
    bundle = BundleValue("fixture/rays", {"vertices": {
        "value": values, "axes": [{"name": "vertex", "ticks": ticks}],
    }})
    schema = {"vertices": {"dtype": "float64", "axes": ({"name": "vertex"},)}}
    try:
        recorded = materialize_record_value(
            bundle, schema, resources=resources, artifacts=artifacts, owner="record", leases=[],
        )
        assert recorded["vertices"]["value"] is values
        assert recorded["vertices"]["axes"][0]["ticks"] is ticks
        assert recorded["vertices"]["axes"][0]["name"] == "vertex"
    finally:
        artifacts.close()
        resources.close()
