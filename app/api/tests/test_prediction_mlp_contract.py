"""MLP authoring and resource contracts remain usable without Torch."""
from copy import deepcopy

import pytest

from prediction_contracts import (MLP_DEFAULT_ALGORITHM, resource_requirements, validate_allocation,
                                  validate_definition, validate_mlp_algorithm)


def test_mlp_defaults_are_complete_and_not_mutated_by_callers():
    actual = validate_mlp_algorithm({"kind": "mlp"})
    assert actual == {"kind": "mlp", "hiddenLayers": [32, 32], "epochs": 500,
                      "batchSize": 32, "learningRate": 0.001, "seed": 0}
    actual["hiddenLayers"].append(8)
    assert MLP_DEFAULT_ALGORITHM["hiddenLayers"] == [32, 32]


@pytest.mark.parametrize("changes", [
    {"kind": "knn"}, {"hiddenLayers": []}, {"hiddenLayers": [32] * 5}, {"hiddenLayers": [True]},
    {"hiddenLayers": [257]}, {"hiddenLayers": [0]}, {"hiddenLayers": [1.5]}, {"hiddenLayers": "32"},
    {"epochs": True}, {"epochs": 0}, {"epochs": 10001}, {"batchSize": 0}, {"batchSize": 4097},
    {"batchSize": False}, {"learningRate": True}, {"learningRate": 0}, {"learningRate": float("nan")},
    {"learningRate": float("inf")}, {"learningRate": 1.01}, {"seed": -1}, {"seed": True},
    {"seed": 2147483648}, {"device": "cpu"}, {"optimizer": "adam"},
])
def test_invalid_mlp_parameters_are_rejected_before_training(changes):
    definition = {"algorithm": {**MLP_DEFAULT_ALGORITHM, **changes}, "implementationVersion": "mlp-v1",
                  "preprocessingVersion": "box-relative-v2"}
    with pytest.raises(ValueError):
        validate_mlp_algorithm(definition["algorithm"])
    with pytest.raises(ValueError):
        validate_definition(definition)


def test_cpu_allocation_is_portable_without_persisting_device_in_definition():
    definition = {"algorithm": deepcopy(MLP_DEFAULT_ALGORITHM), "implementationVersion": "mlp-v1",
                  "preprocessingVersion": "box-relative-v2"}
    original = deepcopy(definition)
    assert resource_requirements(definition, "training") == {"gpu_count": 1}
    assert resource_requirements(definition, "training", configured_gpu_count=0) == {"gpu_count": 0}
    assert resource_requirements(definition, "training", configured_gpu_count=False) == {"gpu_count": 1}
    for devices in ([], ["GPU-1"]):
        validate_allocation(definition, "inference", {"cpu_cores": 1, "gpu_devices": devices})
    assert definition == original
