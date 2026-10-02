"""Native complex mesh sweeps retain explicit coordinates through recording and leases."""
import copy

import numpy as np
import pytest

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue
from app.kernel.api.errors import CaeError
from app.kernel.resources import ArtifactStore, ResourceStore
from app.kernel.transport.recording import materialize_record_value
from app.kernel.transport.tensor import decode_attachment_tensors, encode_recorded_data


@pytest.mark.parametrize("location,components,quantity", [
    ("node", 3, "kinematics.Displacement"), ("cell", 6, "mechanics.StressTensor"),
    ("cell", 6, "Pressure"), ("node", 1, "Pressure"),
])
@pytest.mark.parametrize("samples", [2, 3000])
def test_harmonic_mesh_bundle_roundtrip(location, components, quantity, samples):
    frequencies = np.arange(samples, dtype=np.float64) + 17.0
    count = 4 if location == "node" else 1
    values = (np.arange(count * samples * components).reshape(count, samples, components) * (1 + 2j)).astype(np.complex64)
    domain = UnstructuredMeshValue(np.eye(4, 3), {"tet4": np.array([[0, 1, 2, 3]], dtype=np.int32)}, "m", "mesh")
    unit, labels = {
        1: ("Pa", ("value",)),
        3: ("m", ("x", "y", "z")),
        6: ("Pa", ("xx", "yy", "zz", "xy", "yz", "xz")),
    }[components]
    field = FieldValue(domain, location, quantity, unit, values, components=labels, metadata={
        "sampleAxes": [{"axis": 1, "name": "frequency", "unit": "Hz", "ticks": frequencies}],
    })
    value_schema = {"dtype": "complex64", "unit": unit, "quantityKind": quantity, "axes": [
        {"name": "entity"}, {"name": "frequency", "unit": "Hz", "quantityKind": "Frequency"}, {"length": components},
    ]}
    schema = {"field": {"values": value_schema, "location": {"dtype": "string"}, "domain": {
        "identity": {"dtype": "string"}, "points": {"dtype": "float64", "axes": [{}, {}]},
        "cells": {"tet4": {"dtype": "int32", "axes": [{}, {}]}},
    }}, "frequencies": {"dtype": "float64", "unit": "Hz", "quantityKind": "Frequency", "axes": [{}]}}
    bundle = BundleValue("fixture/harmonic@1", {
        "field": field, "frequencies": {"value": frequencies, "axes": [{"ticks": frequencies}]},
    })
    resources, leases = ResourceStore(), []
    artifacts = ArtifactStore(resources)
    try:
        handle = artifacts.publish(bundle, producer_task="sound", solver_name="fixture", solver_version="1.0.0",
                                   output_name="pressure", artifact_type="fixture/harmonic@1", state_revision=1)
        recorded = materialize_record_value(handle, schema, resources=resources, artifacts=artifacts, owner="visualization", leases=leases)
        artifacts.release(handle)
        encoded, attachments, _ = encode_recorded_data("sweep", schema, recorded, 1)
        tensor = encoded["field"]["values"]
        assert tensor["shape"] == [count, samples, components]
        assert tensor["axes"][0] == tensor["axes"][2] == {"implicitOrdinal": True}
        assert tensor["axes"][1] == {"name": "frequency", "unit": "Hz", "ticks": frequencies.tolist()}
        assert (tensor["storage"]["kind"] == "attachments") is (values.nbytes > 64 * 1024)
        if tensor["storage"]["kind"] == "inline":
            raw = np.asarray(tensor["storage"]["value"], dtype=object)
            decoded = np.asarray([item["re"] + 1j * item["im"] for item in raw.flat], dtype=np.complex64).reshape(values.shape)
        else:
            decoded = decode_attachment_tensors({"dtype": "complex64", "value": tensor}, attachments)["value"]
        np.testing.assert_array_equal(decoded, values)
        assert encoded["field"]["domain"]["identity"]["storage"]["value"] == "mesh"
        assert encoded["frequencies"]["axes"][0]["ticks"] == frequencies.tolist()
    finally:
        for lease in leases:
            resources.release(lease)
        artifacts.close()
        assert resources.stats().resource_count == 0
        resources.close()


@pytest.mark.parametrize("change", [{"axis": 3}, {"ticks": [1.0]}, {"unit": "s"}, {"name": "time"}])
def test_unstructured_sample_axes_cannot_change_the_declared_coordinate_meaning(change):
    sample = {"axis": 1, "name": "frequency", "unit": "Hz", "ticks": [10.0, 20.0]}
    sample.update(change)
    field = FieldValue(UnstructuredMeshValue(np.zeros((4, 3)), {"tet4": np.array([[0, 1, 2, 3]])}, "m"),
                       "node", "Pressure", "Pa", np.zeros((4, 2, 1), dtype=np.complex64), metadata={"sampleAxes": [sample]})
    schema = {"dtype": "complex64", "axes": [{}, {"name": "frequency", "unit": "Hz"}, {}]}
    resources, artifacts = ResourceStore(), None
    try:
        artifacts = ArtifactStore(resources)
        with pytest.raises(CaeError, match="sample axis|sample coordinates"):
            materialize_record_value(field, copy.deepcopy(schema), resources=resources, artifacts=artifacts, owner="test", leases=[])
    finally:
        if artifacts is not None:
            artifacts.close()
        resources.close()
