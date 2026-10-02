"""Record declarations shared with the frontend authoring regression test."""

from app.kernel.transport.tensor import dtype_for
import json, numpy as np


MESH_FIELD_SCHEMA = {
    "domain": {
        "kind": {"dtype": "string"},
        "identity": {"dtype": "string"},
        "lengthUnit": {"dtype": "string"},
        "points": {
            "dtype": "float64", "quantityKind": "Length", "unit": "m",
            "axes": [{"name": "node"}, {"name": "coordinate", "length": 3}],
        },
        "cells": {
            "tetra4": {
                "dtype": "int64", "axes": [{"name": "cell"}, {"name": "localNode", "length": 4}],
            },
        },
        "metadata": {"sourceIdentity": {"dtype": "string"}},
    },
    "location": {"dtype": "string"},
    "quantity": {"dtype": "string"},
    "valueUnit": {"dtype": "string"},
    "values": {
        "dtype": "float64", "quantityKind": "thermodynamics.Temperature", "unit": "K",
        "axes": [{"name": "node"}],
    },
}


def decode_tensor_tree(schema, value, attachments):
    """Decode the actual packet before ACK releases its attachment buffers."""
    result = {}
    leaves = [("", schema, value)]
    while leaves:
        name, node, tensor = leaves.pop()
        if "dtype" not in node:
            leaves.extend((f"{name}.{member}".lstrip("."), child, tensor[member]) for member, child in node.items())
            continue
        storage = tensor["storage"]
        if storage["kind"] == "inline":
            if node["dtype"] == "complex64":
                encoded = np.asarray(storage["value"], dtype=object).reshape(tensor["shape"])
                values = np.asarray([complex(item["re"], item["im"]) for item in encoded.flat], dtype=np.complex64).reshape(encoded.shape)
            else:
                values = np.asarray(storage["value"]).reshape(tensor["shape"])
        else:
            raw = b"".join(attachments[identifier] for identifier in storage["ids"])
            values = (np.asarray(json.loads(raw.decode("utf-8"))) if node["dtype"] == "string"
                      else np.frombuffer(raw, dtype=dtype_for(node["dtype"]))).reshape(tensor["shape"])
        assert list(values.shape) == tensor["shape"]
        if node["dtype"] != "string":
            assert np.all(np.isfinite(values)), name
        result[name] = values.copy()
    return result
