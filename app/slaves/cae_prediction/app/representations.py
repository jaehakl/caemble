"""Shared Vars and relative BoxGrid sample conversion, independent of model selection."""
from __future__ import annotations

import base64
import math

import numpy as np

from .errors import PredictionError


def vars_layouts(schema: dict) -> list[dict]:
    layouts = []
    for key, entry in sorted(schema.items()):
        low, high = entry["min"], entry["max"]
        if not isinstance(low, (int, float)) or not isinstance(high, (int, float)) or not math.isfinite(low) or not math.isfinite(high) or low > high:
            raise PredictionError("invalid-data", f"vars.{key} bounds are invalid.")
        layouts.append({"key": key, "dtype": "float64", "shape": entry["shape"], "minimum": low, "maximum": high})
    return layouts


def flat_values(value, shape: list[int], label: str) -> list[float]:
    flat = []
    def visit(item, depth):
        if depth == len(shape):
            if type(item) not in (int, float) or not math.isfinite(item):
                raise PredictionError("invalid-tensor", f"{label} contains a missing or nonfinite value.")
            flat.append(item)
        else:
            if not isinstance(item, list) or len(item) != shape[depth]:
                raise PredictionError("invalid-tensor", f"{label} shape differs from its declared dimensions.")
            for member in item:
                visit(member, depth + 1)
    visit(value, 0)
    return flat


def vars_samples(values: dict, schema: dict) -> list[dict]:
    samples = []
    for layout in vars_layouts(schema):
        if layout["key"] not in values:
            raise PredictionError("missing-block", f"vars.{layout['key']} is missing.")
        samples.append({"layout": layout, "values": flat_values(values[layout["key"]], layout["shape"], layout["key"])})
    return samples


def recorded_sample(row: dict) -> dict:
    schema, tensor = row["data_schema"], row["data"]
    shape, grid = tensor["shape"], tensor.get("boxGrid")
    if schema.get("dtype") not in ("float32", "float64") or not grid or len(shape) != 7:
        raise PredictionError("unsupported-representation", f"{row['name']} requires a numeric seven-axis Box Grid tensor.")
    if grid.get("version") != 1 or list(grid.get("gridShape", [])) != shape[:3]:
        raise PredictionError("invalid-tensor", f"{row['name']} Box Grid dimensions do not match its tensor.")
    if any(type(length) is not int or length < 1 for length in shape):
        raise PredictionError("invalid-tensor", "Box Grid requires seven positive integer dimensions.")
    if grid.get("channels") not in (["value"], ["amplitude", "phase"]) or len(set(grid.get("components", []))) != len(grid.get("components", [])):
        raise PredictionError("invalid-tensor", "Box Grid channels or components are invalid.")
    if len(grid.get("channelUnits", [])) != len(grid["channels"]) or (len(grid["channels"]) == 2 and grid["channelUnits"][1] != "rad"):
        raise PredictionError("invalid-tensor", "Box Grid channel units are invalid.")
    vectors = [grid.get("origin", []), grid.get("size", []), *grid.get("rotation", [])]
    if len(vectors) != 5 or any(len(vector) != 3 or any(type(value) not in (int, float) or not math.isfinite(value) for value in vector) for vector in vectors) or any(value <= 0 for value in grid["size"]):
        raise PredictionError("invalid-tensor", "Box Grid geometry requires finite origin, size and rotation.")
    rotation = np.asarray(grid["rotation"], dtype=np.float64)
    if not np.allclose(rotation @ rotation.T, np.eye(3), atol=1e-8, rtol=0):
        raise PredictionError("invalid-tensor", "Box Grid rotation must be orthonormal.")
    if shape[5:] != [len(grid.get("channels", [])), len(grid.get("components", []))]:
        raise PredictionError("invalid-tensor", f"{row['name']} Box Grid channels/components do not match its tensor.")
    storage = tensor["storage"]
    if storage["kind"] == "inline":
        values = flat_values(storage["value"], shape, row["name"])
    elif storage["kind"] == "base64":
        raw = base64.b64decode(storage["data"], validate=True)
        dtype = np.dtype("<f4" if schema["dtype"] == "float32" else "<f8")
        if len(raw) != math.prod(shape) * dtype.itemsize or len(raw) != storage["byteLength"]:
            raise PredictionError("invalid-tensor", f"{row['name']} encoded byte length differs from its shape.")
        values = np.frombuffer(raw, dtype=dtype).astype(np.float64).tolist()
    else:
        raise PredictionError("unsupported-representation", "Dataset tensors require inline or checked base64 storage.")
    axes = []
    for index, length in enumerate(shape):
        schema_axis = schema.get("axes", [])[index]
        stored_axis = tensor.get("axes", [])[index] if index < len(tensor.get("axes", [])) else {}
        ticks = stored_axis.get("ticks")
        if ticks is None:
            ticks = list(range(length)) if stored_axis.get("implicitOrdinal") else schema_axis.get("ticks", [])
        if len(ticks) != length:
            raise PredictionError("invalid-tensor", f"{row['name']} axis {index} ticks differ from its shape.")
        axes.append({"name": schema_axis["name"], "ticks": ticks, **({"unit": schema_axis["unit"]} if schema_axis.get("unit") else {})})
    layout = {"key": row["name"], "dtype": schema["dtype"], "shape": shape, "axes": axes,
              "tensorOrder": schema.get("tensorOrder", 0), "boxGrid": grid,
              **{key: schema[key] for key in ("unit", "quantityKind") if key in schema}}
    if len(grid["channels"]) == 2:
        components = len(grid["components"])
        for start in range(0, len(values), components * 2):
            for component in range(components):
                amplitude, phase = values[start + component], values[start + components + component]
                if type(amplitude) not in (int, float) or type(phase) not in (int, float) or not math.isfinite(amplitude) or not math.isfinite(phase):
                    raise PredictionError("invalid-tensor", f"{row['name']} contains missing or nonfinite polar values.")
                values[start + component] = amplitude * math.cos(phase)
                values[start + components + component] = amplitude * math.sin(phase)
    if grid.get("frequencyKind") == "modal":
        layout["frequencyOutput"] = True
        values.extend(axes[4]["ticks"])
    return {"layout": layout, "values": values}
