"""Small synthetic tensors for API result-boundary tests."""
import math


def box_schema(shape=(2, 1, 1, 1, 1, 1, 1)):
    return {
        "dtype": "float64", "quantityKind": "Dimensionless", "unit": "1",
        "axes": [{"name": name, "length": size} for name, size in zip(
            ("x", "y", "z", "time", "frequency", "amplitudePhase", "component"), shape)],
        "boxGrid": {"version": 1, "sampling": "point", "components": ["scalar"], "channels": ["value"], "channelUnits": ["1"]},
    }


def box_tensor(shape=(2, 1, 1, 1, 1, 1, 1)):
    values = [float(index) for index in range(math.prod(shape))]
    for size in reversed(shape[1:]):
        values = [values[index:index + size] for index in range(0, len(values), size)]
    return {
        "shape": list(shape),
        "provenance": {"task": "solver", "solver": {"name": "fixture", "version": "1.0.0"}, "stateRevision": 1, "invocation": 2, "catalogRevision": "revision"},
        "axes": [{"ticks": list(range(size))} for size in shape],
        "boxGrid": {**box_schema(shape)["boxGrid"], "origin": [1, 2, 3], "size": [2, 3, 4],
            "rotation": [[0, -1, 0], [1, 0, 0], [0, 0, 1]], "lengthUnit": "m",
            "gridShape": list(shape[:3]), "source": "task", "rootId": "detector"},
        "storage": {"kind": "inline", "value": values},
    }
