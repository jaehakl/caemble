"""kNN Forward implementation: Vars, relative BoxGrid cells and inert numerical files."""
from __future__ import annotations

import base64
import copy
import math
from pathlib import Path
import threading

import numpy as np

from .errors import PredictionError
from .knn import EXCLUSION_REASONS, KnnModel
from .storage import check_cancel, encode_json

IMPLEMENTATION_VERSION = "knn-v1"
PREPROCESSING_VERSION = "box-relative-v2"


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


class KnnForwardModel:
    def __init__(self, metadata: dict, models: list[KnnModel]):
        self.metadata, self.models = metadata, models
        self.input_layouts = models[0].metadata["inputLayouts"]
        self.output_layouts = [layout for model in models for layout in model.metadata["outputLayouts"]]
        self.persistent_bytes = sum(array.nbytes for model in models for array in model.arrays.values())

    @classmethod
    def prepare(cls, dataset: dict, definition: dict, model_ref: dict,
                memory_budget: int, cancel: threading.Event | None = None, progress=None) -> "KnnForwardModel":
        if definition.get("snapshotFingerprint") != dataset["fingerprint"]:
            raise PredictionError("dataset-checksum", "Model definition references a different Dataset fingerprint.")
        algorithm = definition["algorithm"]
        dataset = dict(dataset)
        if "requiredRecordIds" in definition:
            selected = definition["requiredRecordIds"]
            by_id = {item["id"]: item for item in dataset.get("records", [])}
            if not selected or len(set(selected)) != len(selected) or any(identity not in by_id for identity in selected):
                raise PredictionError("missing-contract", "Select one or more BoxGrid outputs present in the Dataset revision.")
            dataset["records"] = [by_id[identity] for identity in selected]
        layouts = vars_layouts(dataset["varsSchema"])
        models, groups, errors = [], [], {}
        measurements = sorted(dataset["measurements"], key=lambda row: row["id"])
        records, rules = dataset.get("records", []), dataset.get("rules", [])
        rules_by_name = {rule["label"]: rule for rule in rules}
        grouped = {}
        for record in records:
            rule = rules_by_name.get(record["name"], {})
            contract = next((contract for name, contract in dataset.get("resultContracts", {}).items()
                             if record["name"] == name or record["name"].startswith(name + ".")), None)
            group_key = f"modal:{contract['task']}" if rule.get("result", {}).get("boxGrid", {}).get("frequencyKind") == "modal" and contract else f"record:{record['id']}"
            grouped.setdefault(group_key, []).append(record)
        stored = {(row["measurement_id"], row["experiment_record_id"]): row for row in dataset.get("recorded", [])}
        for group in grouped.values():
            check_cancel(cancel)
            try:
                group_rules = [rules_by_name[record["name"]] for record in group]
                if any(not rule["result"].get("boxGrid") for rule in group_rules):
                    raise PredictionError("missing-contract", "Forward records require current Box Grid output contracts.")
                rows = []
                for measurement in measurements:
                    check_cancel(cancel)
                    try:
                        inputs = vars_samples(measurement["vars"], dataset["varsSchema"])
                        outputs = [recorded_sample(stored[(measurement["id"], record["id"])]) for record in group
                                   if (measurement["id"], record["id"]) in stored]
                        rows.append({"measurementId": measurement["id"], "inputs": inputs, "outputs": outputs})
                    except (PredictionError, KeyError, TypeError) as error:
                        rows.append({"measurementId": measurement["id"], "inputs": [], "outputs": [], "error": str(error)})
                model = KnnModel.build(rows, fingerprint=definition["fingerprint"],
                                       input_keys=[item["key"] for item in layouts], output_keys=[record["name"] for record in group],
                                       algorithm=algorithm, memory_budget=memory_budget - sum(model.metadata["resources"]["persistentBytes"] for model in models),
                                       fixed_inputs=layouts, nearest_only=group_rules[0]["result"]["boxGrid"].get("frequencyKind") == "modal", cancel=cancel)
                models.append(model)
                groups.append({"records": group, "rules": group_rules})
            except (PredictionError, KeyError) as error:
                if isinstance(error, PredictionError) and error.code in ("memory-limit", "cancelled"):
                    raise
                errors.update({str(record["id"]): str(error) for record in group})
        if not models:
            raise PredictionError("insufficient-cohort", next(iter(errors.values()), "No usable Forward output models are available."))
        check_cancel(cancel)
        metadata = {**model_ref, "formatVersion": 1, "direction": "forward", "algorithm": "knn", "definition": definition,
                    "datasetId": dataset["datasetId"], "datasetRevision": dataset["revision"], "datasetFingerprint": dataset["fingerprint"],
                    "experimentId": dataset["experimentId"], "sourceHash": dataset.get("sourceHash"),
                    "varsSchema": dataset["varsSchema"],
                    "resultContracts": dataset.get("resultContracts", {}), "records": dataset.get("records", []),
                    "groups": groups, "errors": errors}
        return cls(metadata, models)

    def profile(self) -> dict:
        profiles = [model.profile() for model in self.models]
        profile = copy.deepcopy(profiles[0])
        profile.update({"rowCount": min(item["rowCount"] for item in profiles), "inputLayouts": [],
                        "outputSize": sum(item["outputSize"] for item in profiles),
                        "includedMeasurementIds": sorted(set(value for item in profiles for value in item["includedMeasurementIds"])),
                        "excluded": {key: sum(item["excluded"][key] for item in profiles) for key in EXCLUSION_REASONS},
                        "resources": {key: sum(item["resources"][key] for item in profiles) for key in ("persistentBytes", "workingSetBytes")}})
        diagnostics = [value for item in profiles for value in item["diagnostics"]]
        profile["diagnostics"] = diagnostics[:500]
        profile["omittedDiagnosticGroups"] = sum(item["omittedDiagnosticGroups"] for item in profiles) + max(0, len(diagnostics) - 500)
        profile["knn"].update({"inputScales": [], "k": min(item["knn"]["k"] for item in profiles),
                               "baselineMeasurementId": min(item["knn"]["baselineMeasurementId"] for item in profiles)})
        return profile

    def record_profiles(self) -> list[dict]:
        record_profiles = []
        for record in self.metadata["records"]:
            profile = next((model.profile() for group, model in zip(self.metadata["groups"], self.models)
                            if any(member["id"] == record["id"] for member in group["records"])), None)
            record_profiles.append({"recordId": record["id"], "name": record["name"],
                                    "error": self.metadata["errors"].get(str(record["id"])), "profile": profile})
        return record_profiles

    def preparation_details(self) -> dict:
        return {"errors": self.metadata["errors"], "recordProfiles": self.record_profiles(),
                "rules": [rule for group in self.metadata["groups"] for rule in group["rules"]]}

    @staticmethod
    def validate_artifact(path: Path, manifest: dict, content: dict) -> set[str]:
        """Inspect inert numerical headers, including retired Inverse backups."""
        metadata = content["metadata"]
        if metadata["formatVersion"] != 1 or metadata["algorithm"] != "knn" or not content["models"]:
            raise PredictionError("artifact-version", "Unsupported kNN model artifact.")
        array_names = ("input", "output", "inputMinimums", "inputMaximums", "inputScales", "measurementIds")
        expected = {"model.json"} | {f"{index}-{name}.npy" for index in range(len(content["models"])) for name in array_names}
        for index, model in enumerate(content["models"]):
            for name in array_names:
                file = path / f"{index}-{name}.npy"
                with file.open("rb") as stream:
                    version = np.lib.format.read_magic(stream)
                    if version == (1, 0):
                        shape, _, dtype = np.lib.format.read_array_header_1_0(stream)
                    elif version == (2, 0):
                        shape, _, dtype = np.lib.format.read_array_header_2_0(stream)
                    else:
                        raise PredictionError("artifact-version", "Unsupported NumPy array format.")
                    expected_shape = ((model["rowCount"], model["inputSize"] if name == "input" else model["outputSize"])
                                      if name in ("input", "output") else
                                      (model["rowCount"] if name == "measurementIds" else model["inputSize"],))
                    if (shape != expected_shape or dtype.hasobject or dtype.kind not in "biuf"
                            or stream.tell() + math.prod(shape) * dtype.itemsize != file.stat().st_size):
                        raise PredictionError("artifact-checksum", "NumPy array dimensions or dtype differ from the saved model.")
        return expected

    def predict(self, values: dict, cancel=None) -> dict:
        samples = vars_samples(values, self.metadata["varsSchema"])
        results = [model.predict(samples, cancel) for model in self.models]
        neighbors = {}
        for result in results:
            for neighbor in result["knn"]["neighbors"]:
                row = neighbors.setdefault(neighbor["measurementId"], {"measurementId": neighbor["measurementId"], "distanceSquared": math.inf, "weight": 0})
                row["distanceSquared"] = min(row["distanceSquared"], neighbor["distanceSquared"])
                row["weight"] += neighbor["weight"] / len(results)
        return {"direction": "forward", "fingerprint": self.metadata["definition"]["fingerprint"],
                "output": [sample for result in results for sample in result["output"]],
                "extrapolatedInputKeys": sorted(set(key for result in results for key in result["extrapolatedInputKeys"])),
                "constantInputKeysChanged": sorted(set(key for result in results for key in result["constantInputKeysChanged"])),
                "queryDiagnostics": [item for result in results for item in result["queryDiagnostics"]],
                "knn": {"neighbors": sorted(neighbors.values(), key=lambda item: (-item["weight"], item["measurementId"]))}}

    def write(self, path: Path, cancel=None) -> None:
        (path / "model.json").write_bytes(encode_json({"metadata": self.metadata, "models": [model.metadata for model in self.models]}))
        for index, model in enumerate(self.models):
            check_cancel(cancel)
            for name, array in model.arrays.items():
                with (path / f"{index}-{name}.npy").open("wb") as stream:
                    np.save(stream, array, allow_pickle=False)

    @classmethod
    def load(cls, metadata: dict, content: dict, path: Path, files: list[dict], memory_budget: int, cancel=None):
        if not content["models"]:
            raise PredictionError("artifact-checksum", "Saved model has no Forward outputs.")
        expected_files = {"model.json"} | {f"{index}-{name}.npy" for index in range(len(content["models"])) for name in
                                          ("input", "output", "inputMinimums", "inputMaximums", "inputScales", "measurementIds")}
        if expected_files != {file["name"] for file in files}:
            raise PredictionError("artifact-checksum", "Saved model files differ from its complete manifest.")
        models, total = [], 0
        for index, numerical in enumerate(content["models"]):
            check_cancel(cancel)
            if numerical.get("direction") != "forward" or numerical.get("inputScaling") != "range":
                raise PredictionError("unsupported-model", "Saved model does not implement Forward Vars range scaling.")
            total += numerical["resources"]["workingSetBytes"]
            if total > memory_budget:
                raise PredictionError("memory-limit", "Saved model exceeds the available working memory.")
            arrays = {name: np.load(path / f"{index}-{name}.npy", allow_pickle=False) for name in
                      ("input", "output", "inputMinimums", "inputMaximums", "inputScales", "measurementIds")}
            if arrays["input"].shape != (numerical["rowCount"], numerical["inputSize"]) or arrays["output"].shape != (numerical["rowCount"], numerical["outputSize"]):
                raise PredictionError("artifact-checksum", "Saved model array dimensions differ from its contract.")
            if any(arrays[key].shape != (numerical["inputSize"],) for key in ("inputMinimums", "inputMaximums", "inputScales")) or arrays["measurementIds"].shape != (numerical["rowCount"],):
                raise PredictionError("artifact-checksum", "Saved model scaling arrays differ from its contract.")
            if any(not np.all(np.isfinite(array)) for array in arrays.values()) or np.any(arrays["inputScales"] < 0):
                raise PredictionError("artifact-checksum", "Saved model contains invalid numerical arrays.")
            models.append(KnnModel(numerical, arrays))
        return cls(metadata, models)
