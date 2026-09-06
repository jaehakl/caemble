"""Record declarations shared with the frontend authoring regression test."""

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
