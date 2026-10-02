"""Serializable MLP settings, without importing a numerical backend."""
from copy import deepcopy
import math


MLP_DEFAULT_ALGORITHM = {
    "kind": "mlp", "hiddenLayers": [32, 32], "epochs": 500,
    "batchSize": 32, "learningRate": 0.001, "seed": 0,
}


def validate_mlp_algorithm(algorithm: dict) -> dict:
    """Return complete settings; reject ambiguous numeric and unknown inputs."""
    if (not isinstance(algorithm, dict) or algorithm.get("kind") != "mlp"
            or set(algorithm) - MLP_DEFAULT_ALGORITHM.keys()):
        raise ValueError("MLP settings must identify mlp and contain only supported parameters.")
    settings = {**deepcopy(MLP_DEFAULT_ALGORITHM), **deepcopy(algorithm)}
    layers = settings["hiddenLayers"]
    if (not isinstance(layers, list) or not 1 <= len(layers) <= 4
            or any(type(width) is not int or not 1 <= width <= 256 for width in layers)):
        raise ValueError("MLP hiddenLayers requires 1 to 4 layers with 1 to 256 units each.")
    for name, minimum, maximum in (("epochs", 1, 10000), ("batchSize", 1, 4096), ("seed", 0, 2147483647)):
        value = settings[name]
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError(f"MLP {name} must be an integer between {minimum} and {maximum}.")
    rate = settings["learningRate"]
    if type(rate) not in (int, float) or not math.isfinite(rate) or not 0 < rate <= 1:
        raise ValueError("MLP learningRate must be finite, greater than zero and at most one.")
    return settings
