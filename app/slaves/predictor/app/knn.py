"""CPU kNN numerical contract shared through fixtures with browser Prediction."""
from __future__ import annotations

import copy
import json
import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from .errors import PredictionError
from .storage import check_cancel

EXCLUSION_REASONS = ("missing-block", "extra-block", "invalid-tensor", "fixed-layout-mismatch", "layout-mismatch")
INTEGER_RANGES = {
    "int8": (-128, 127), "int16": (-32768, 32767), "int32": (-2147483648, 2147483647),
    "int64": (-(2**53 - 1), 2**53 - 1), "uint8": (0, 255), "uint16": (0, 65535),
    "uint32": (0, 4294967295), "uint64": (0, 2**53 - 1),
}


def value_count(layout: dict) -> int:
    shape = layout["shape"]
    if any(type(length) is not int or length < 0 for length in shape):
        raise PredictionError("invalid-data", "Tensor shape requires nonnegative integer dimensions.")
    count = math.prod(shape) * (2 if layout["dtype"] == "complex64" else 1)
    return count + (shape[4] if layout.get("frequencyOutput") else 0)


def layout_contract(layout: dict) -> dict:
    contract = {key: layout.get(key) for key in ("key", "shape", "dtype")}
    grid = layout.get("boxGrid")
    if grid:
        contract["boxGridContract"] = {
            **{key: layout.get(key) for key in ("quantityKind", "unit")},
            **{key: grid.get(key) for key in ("version", "sampling", "channels", "components", "channelUnits",
                                            "frequencyKind", "configuration", "weighting")},
            "axes": [{**axis, **({"ticks": None} if index == 1 and layout.get("frequencyOutput") else {})}
                     for index, axis in enumerate(layout.get("axes", [])[3:])],
        }
    else:
        contract.update({key: layout.get(key) for key in ("unit", "quantityKind")})
        contract["axes"] = [{key: axis.get(key) for key in ("name", "unit")}
                            for axis in layout.get("axes", [])]
    return contract


def validate_sample(sample: dict, expected: dict | None = None) -> np.ndarray:
    layout = sample["layout"]
    values = sample["values"]
    if layout.get("dtype") not in ("float16", "float32", "float64", "complex64", *INTEGER_RANGES):
        raise PredictionError("invalid-tensor", f"{layout['key']} has an unsupported numeric dtype.")
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in values):
        raise PredictionError("invalid-tensor", f"{layout['key']} contains missing or nonfinite values.")
    if len(values) != value_count(layout):
        raise PredictionError("invalid-tensor", f"{layout['key']} values do not match its shape.")
    if expected is not None and layout_contract(layout) != layout_contract(expected):
        raise PredictionError("layout-mismatch", f"{layout['key']} dtype, shape, axis names or units differ.")
    return np.asarray(values, dtype=np.float64)


def coordinate_diagnostics(baseline: dict, actual: dict) -> list[dict]:
    diagnostics = []
    for index, (expected, observed) in enumerate(zip(baseline.get("axes", []), actual.get("axes", []))):
        left, right = expected.get("ticks", []), observed.get("ticks", [])
        if left == right:
            continue
        indices = [cell for cell in range(max(len(left), len(right))) if cell >= len(left) or cell >= len(right) or left[cell] != right[cell]]
        differences = [abs(left[cell] - right[cell]) for cell in indices if cell < len(left) and cell < len(right)
                       and type(left[cell]) in (int, float) and type(right[cell]) in (int, float)]
        diagnostics.append({"blockKey": baseline["key"], "fieldPath": f"axes[{index}].ticks",
                            "expected": json.dumps(left), "actual": json.dumps(right), "mismatchCount": len(indices),
                            "firstMismatchIndex": indices[0], **({"maxAbsoluteDifference": max(differences)} if differences else {})})
    return diagnostics


def cohort(rows: list[dict], input_keys: list[str], output_keys: list[str], direction: str,
           fixed_inputs: list[dict] | None = None, fixed_outputs: list[dict] | None = None, cancel=None):
    groups: dict[str, list[dict]] = {}
    excluded = dict.fromkeys(EXCLUSION_REASONS, 0)
    diagnostics = []
    seen = set()
    for row in rows:
        check_cancel(cancel)
        measurement_id = row["measurementId"]
        if type(measurement_id) is not int or measurement_id <= 0 or measurement_id in seen:
            raise PredictionError("invalid-data", "Prediction requires unique positive Measurement IDs.")
        seen.add(measurement_id)
        side, block_key = "input", ""
        try:
            normalized = {"measurementId": measurement_id}
            for side, keys, fixed in (("input", input_keys, fixed_inputs), ("output", output_keys, fixed_outputs)):
                samples = row[f"{side}s"]
                mapped = {sample["layout"]["key"]: sample for sample in samples}
                if len(mapped) != len(samples):
                    raise PredictionError("invalid-tensor", "Duplicate tensor block.")
                missing = [key for key in keys if key not in mapped]
                if missing:
                    block_key = missing[0]
                    raise PredictionError("missing-block", row.get("error", f"Missing {block_key}."))
                if set(mapped) != set(keys):
                    raise PredictionError("extra-block", "Unexpected tensor block.")
                for index, key in enumerate(keys):
                    block_key = key
                    validate_sample(mapped[key], fixed[index] if fixed else None)
                normalized[f"{side}s"] = [mapped[key] for key in keys]
            signature = json.dumps([layout_contract(sample["layout"]) for sample in
                                    normalized["inputs"] + normalized["outputs"]], sort_keys=True)
            groups.setdefault(signature, []).append(normalized)
        except PredictionError as error:
            reason = error.code if error.code in excluded else "invalid-tensor"
            excluded[reason] += 1
            diagnostics.append({"direction": direction, "disposition": "excluded", "reason": reason,
                                "side": side, "blockKey": block_key, "fieldPath": "contract",
                                "baselineMeasurementId": None, "expected": "compatible finite tensor",
                                "actual": str(error), "measurementIds": [measurement_id]})
    if not groups:
        raise PredictionError("insufficient-cohort", "No complete compatible Prediction samples are available.")
    signature, selected = min(groups.items(), key=lambda item: (-len(item[1]), min(row["measurementId"] for row in item[1]), item[0]))
    selected.sort(key=lambda row: row["measurementId"])
    baseline_id = selected[0]["measurementId"]
    for other_signature, group in groups.items():
        if other_signature == signature:
            continue
        excluded["layout-mismatch"] += len(group)
        diagnostics.append({"direction": direction, "disposition": "excluded", "reason": "layout-mismatch",
                            "side": "output", "blockKey": output_keys[0], "fieldPath": "boxGridContract",
                            "baselineMeasurementId": baseline_id, "expected": signature, "actual": other_signature,
                            "measurementIds": [row["measurementId"] for row in group]})
    for diagnostic in diagnostics:
        diagnostic["baselineMeasurementId"] = baseline_id
    warnings = []
    if direction == "inverse":
        for row in selected[1:]:
            for baseline, actual in zip(selected[0]["inputs"], row["inputs"]):
                for diagnostic in coordinate_diagnostics(baseline["layout"], actual["layout"]):
                    warnings.append(row["measurementId"])
                    diagnostics.append({**diagnostic, "direction": direction, "disposition": "included-with-warning",
                                        "reason": "metadata-mismatch", "side": "input", "baselineMeasurementId": baseline_id,
                                        "measurementIds": [row["measurementId"]]})
    summary = {"totalRows": len(rows), "includedRows": len(selected),
               "includedMeasurementIds": [row["measurementId"] for row in selected], "warningMeasurementIds": sorted(set(warnings)),
               "dominantShapeSignature": signature, "baselineMeasurementId": baseline_id,
               "diagnostics": diagnostics[:500], "omittedDiagnosticGroups": max(0, len(diagnostics) - 500),
               "excluded": excluded}
    return selected, summary


@dataclass
class KnnModel:
    metadata: dict[str, Any]
    arrays: dict[str, np.ndarray]

    @classmethod
    def build(cls, rows: list[dict], *, direction: str, fingerprint: str, input_keys: list[str],
              output_keys: list[str], algorithm: dict, memory_budget: int,
              fixed_inputs: list[dict] | None = None, fixed_outputs: list[dict] | None = None,
              nearest_only: bool = False, cancel=None) -> "KnnModel":
        selected, summary = cohort(rows, input_keys, output_keys, direction, fixed_inputs, fixed_outputs, cancel)
        input_layouts = [sample["layout"] for sample in selected[0]["inputs"]]
        output_layouts = [sample["layout"] for sample in selected[0]["outputs"]]
        input_offsets, output_offsets = [0], [0]
        for layout in input_layouts:
            input_offsets.append(input_offsets[-1] + value_count(layout))
        for layout in output_layouts:
            output_offsets.append(output_offsets[-1] + value_count(layout))
        input_size, output_size = input_offsets[-1], output_offsets[-1]
        if not input_size or not output_size:
            raise PredictionError("invalid-data", "Prediction input and output must contain numeric cells.")
        persistent = 8 * (len(selected) * (input_size + output_size + 1) + input_size * 3)
        working = persistent + 8 * (len(selected) * 4 + input_size * 2 + output_size * 2)
        if working > memory_budget:
            raise PredictionError("memory-limit", f"Model requires approximately {working} bytes; {memory_budget} bytes available.")
        inputs = np.array([np.concatenate([sample["values"] for sample in row["inputs"]]) for row in selected], dtype=np.float64)
        outputs = np.array([np.concatenate([sample["values"] for sample in row["outputs"]]) for row in selected], dtype=np.float64)
        minimums, maximums = inputs.min(axis=0), inputs.max(axis=0)
        scales = np.zeros(input_size, dtype=np.float64)
        scaling = "range" if direction == "forward" else "standard-deviation"
        for column in range(input_size):
            if column % 256 == 0:
                check_cancel(cancel)
            maximum = float(np.max(np.abs(inputs[:, column])))
            if maximum:
                scaled = inputs[:, column] / maximum
                mean = sum(float(value) for value in scaled) / len(selected)
                scales[column] = maximum * math.sqrt(sum((float(value) - mean) ** 2 for value in scaled) / len(selected))
        if scaling == "range":
            for block, layout in enumerate(input_layouts):
                low, high = layout["minimum"], layout["maximum"]
                extent = high - low
                if not math.isfinite(extent):
                    magnitude = max(abs(low), abs(high))
                    extent = high / magnitude - low / magnitude
                if extent < 0 or not math.isfinite(extent):
                    raise PredictionError("invalid-data", "Vars range is not finite and ordered.")
                scales[input_offsets[block]:input_offsets[block + 1]] = extent
        block_weights = {layout["key"]: float(algorithm.get("calculationWeights", {}).get(layout["key"].removeprefix("calculation:"), 1))
                         if direction == "inverse" else 1.0 for layout in input_layouts}
        if any(not math.isfinite(weight) or weight < 0 for weight in block_weights.values()) or not any(block_weights.values()):
            raise PredictionError("invalid-data", "Calculation weights must be nonnegative with a positive block.")
        active_counts = [int(np.count_nonzero(scales[input_offsets[block]:input_offsets[block + 1]] > 0))
                         for block in range(len(input_layouts))]
        active_weight_scale = max((block_weights[layout["key"]] for block, layout in enumerate(input_layouts)
                                   if active_counts[block]), default=0)
        active_weight_sum = sum(block_weights[layout["key"]] / active_weight_scale for block, layout in enumerate(input_layouts)
                                if active_counts[block]) if active_weight_scale else 0
        count = len(selected)
        k = 1 if nearest_only else algorithm.get("manualK", 1) if algorithm.get("kMode") == "manual" else min(15, max(1, math.floor(math.sqrt(count) + .5)))
        if type(k) is not int or not 1 <= k <= count:
            raise PredictionError("invalid-data", f"k must be an integer from 1 to {count}.")
        weighting = algorithm.get("weighting", "distance")
        if weighting not in ("distance", "uniform"):
            raise PredictionError("invalid-data", "Unsupported kNN weighting.")
        metadata = {"direction": direction, "fingerprint": fingerprint, "inputLayouts": input_layouts,
                    "outputLayouts": output_layouts, "inputOffsets": input_offsets, "outputOffsets": output_offsets,
                    "inputSize": input_size, "outputSize": output_size, "rowCount": count, "k": k,
                    "weighting": weighting, "inputScaling": scaling, "inputBlockWeights": block_weights,
                    "inputBlockActiveCounts": active_counts, "activeInputWeightScale": active_weight_scale,
                    "activeInputWeightSum": active_weight_sum, "activeInputBlockCount": sum(
                        active_counts[index] > 0 and block_weights[layout["key"]] > 0 for index, layout in enumerate(input_layouts)),
                    "nearestOnly": nearest_only, "cohort": summary,
                    "resources": {"persistentBytes": persistent, "workingSetBytes": working}}
        return cls(metadata, {"input": inputs, "output": outputs, "inputMinimums": minimums,
                              "inputMaximums": maximums, "inputScales": scales,
                              "measurementIds": np.array(summary["includedMeasurementIds"], dtype=np.int64)})

    def profile(self) -> dict:
        meta = self.metadata
        summary = meta["cohort"]
        return {key: meta[key] for key in ("direction", "rowCount", "inputLayouts", "inputSize", "outputSize", "resources")} | {
            key: summary[key] for key in ("includedMeasurementIds", "warningMeasurementIds", "diagnostics", "omittedDiagnosticGroups", "excluded")
        } | {"knn": {key: meta[key] for key in ("k", "weighting", "inputScaling", "inputBlockWeights", "activeInputBlockCount")} |
                  {key: summary[key] for key in ("dominantShapeSignature", "baselineMeasurementId")} |
                  {"inputScales": self.arrays["inputScales"].tolist()}}

    def predict(self, samples: list[dict], cancel=None) -> dict:
        meta, arrays = self.metadata, self.arrays
        mapped = {sample["layout"]["key"]: sample for sample in samples}
        if len(mapped) != len(samples) or set(mapped) != {layout["key"] for layout in meta["inputLayouts"]}:
            raise PredictionError("invalid-data", "Query tensor blocks differ from the stored model.")
        query = np.concatenate([validate_sample(mapped[layout["key"]], layout) for layout in meta["inputLayouts"]])
        distances = np.zeros(meta["rowCount"], dtype=np.float64)
        extrapolated, constant = [], []
        for block, layout in enumerate(meta["inputLayouts"]):
            start, end = meta["inputOffsets"][block:block + 2]
            if np.any(query[start:end] < arrays["inputMinimums"][start:end]) or np.any(query[start:end] > arrays["inputMaximums"][start:end]):
                extrapolated.append(layout["key"])
            if np.any((arrays["inputScales"][start:end] == 0) & (query[start:end] != arrays["inputMinimums"][start:end])):
                constant.append(layout["key"])
        for row in range(meta["rowCount"]):
            check_cancel(cancel)
            scale, square_sum = 0.0, 0.0
            for block, layout in enumerate(meta["inputLayouts"]):
                active, weight = meta["inputBlockActiveCounts"][block], meta["inputBlockWeights"][layout["key"]]
                if active == 0 or weight == 0:
                    continue
                component_weight = math.sqrt(weight / meta["activeInputWeightScale"] / active / meta["activeInputWeightSum"])
                magnitude = 1
                if meta["inputScaling"] == "range" and not math.isfinite(layout["maximum"] - layout["minimum"]):
                    magnitude = max(abs(layout["maximum"]), abs(layout["minimum"]))
                for column in range(*meta["inputOffsets"][block:block + 2]):
                    deviation = float(arrays["inputScales"][column])
                    if deviation == 0:
                        continue
                    component = abs((float(query[column]) / magnitude - float(arrays["input"][row, column]) / magnitude) / deviation) * component_weight
                    if component == 0:
                        continue
                    if scale < component:
                        square_sum = 1 + square_sum * (scale / component) ** 2
                        scale = component
                    else:
                        square_sum += (component / scale) ** 2
            distances[row] = scale * math.sqrt(square_sum) if scale else 0
        indices = sorted(range(meta["rowCount"]), key=lambda index: (distances[index], arrays["measurementIds"][index]))
        if not math.isfinite(distances[indices[0]]):
            raise PredictionError("invalid-data", "Prediction distance overflowed for every sample.")
        exact = [index for index in indices if distances[index] == 0]
        neighbors = indices[:1] if meta["nearestOnly"] else exact or indices[:meta["k"]]
        ratios = [1.0 if exact or meta["weighting"] == "uniform" else 1 / max(float(distances[index]), 1e-12) for index in neighbors]
        weights = [value / sum(ratios) for value in ratios]
        predicted = np.zeros(meta["outputSize"], dtype=np.float64)
        for column in range(meta["outputSize"]):
            if column % 256 == 0:
                check_cancel(cancel)
            maximum = max(abs(float(arrays["output"][row, column])) for row in neighbors)
            if maximum:
                predicted[column] = sum(weight * (float(arrays["output"][row, column]) / maximum) for weight, row in zip(weights, neighbors)) * maximum
        output = []
        for block, layout in enumerate(meta["outputLayouts"]):
            values = predicted[slice(*meta["outputOffsets"][block:block + 2])].copy()
            dtype = layout["dtype"]
            if dtype == "complex64" or (meta["direction"] == "forward" and dtype in ("float32", "float16")):
                with np.errstate(over="ignore", invalid="ignore"):
                    values = values.astype("float32" if dtype == "complex64" else dtype).astype(np.float64)
            elif meta["direction"] == "forward" and dtype in INTEGER_RANGES:
                # JS Math.round chooses +infinity at ties, including negative halves.
                lower = np.floor(values)
                rounded = np.where(values - lower >= .5, lower + 1, lower)
                rounded = np.where((rounded == 0) & (values < 0), -0.0, rounded)
                values = np.clip(rounded, *INTEGER_RANGES[dtype])
            if "minimum" in layout:
                np.clip(values, layout["minimum"], layout["maximum"], out=values)
            if not np.all(np.isfinite(values)):
                raise PredictionError("invalid-data", f"Prediction output {layout['key']} is not finite.")
            output.append({"layout": copy.deepcopy(layout), "values": values.tolist()})
        return {"direction": meta["direction"], "fingerprint": meta["fingerprint"], "output": output,
                "extrapolatedInputKeys": sorted(extrapolated), "constantInputKeysChanged": sorted(constant),
                "queryDiagnostics": [diagnostic for layout in meta["inputLayouts"] for diagnostic in coordinate_diagnostics(layout, mapped[layout["key"]]["layout"])], "knn": {"neighbors": [{"measurementId": int(arrays["measurementIds"][row]),
                    "distanceSquared": float(distances[row]) ** 2, "weight": weight} for row, weight in zip(neighbors, weights)]}}
