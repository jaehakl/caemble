"""Caemble tensor interpretation and independent forward/inverse model artifacts."""
from __future__ import annotations

import base64
import copy
import json
import math
from pathlib import Path
import threading

import numpy as np

from .errors import PredictionError
from .knn import EXCLUSION_REASONS, KnnModel, layout_contract
from .storage import ArtifactStore, check_cancel, encode_json

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


def calculation_sample(calculation_id: int, output: dict) -> dict:
    if output.get("dtype") not in ("float32", "float64", "int8", "int16", "int32", "uint8", "uint16", "uint32"):
        raise PredictionError("invalid-tensor", f"Calculation #{calculation_id} has an unsupported output dtype.")
    shape = output["shape"]
    values = [output["data"]] if not shape else output["data"]
    if not isinstance(values, list) or len(values) != math.prod(shape):
        raise PredictionError("invalid-tensor", f"Calculation #{calculation_id} has invalid tensor values.")
    axes = output["axes"]
    if len(axes) != len(shape) or any(len(axis.get("ticks", [])) != length for axis, length in zip(axes, shape)):
        raise PredictionError("invalid-tensor", f"Calculation #{calculation_id} axes do not match its shape.")
    return {"layout": {"key": f"calculation:{calculation_id}", "dtype": output["dtype"],
                       "shape": shape, "axes": axes}, "values": values}


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


class ModelBundle:
    def __init__(self, metadata: dict, models: list[KnnModel]):
        self.metadata, self.models = metadata, models

    @classmethod
    def prepare(cls, dataset: dict, direction: str, definition: dict, model_ref: dict,
                memory_budget: int, cancel: threading.Event | None = None) -> "ModelBundle":
        if definition.get("snapshotFingerprint") != dataset["fingerprint"]:
            raise PredictionError("dataset-checksum", "Model definition references a different Dataset fingerprint.")
        if definition.get("implementationVersion") != IMPLEMENTATION_VERSION or definition.get("preprocessingVersion") != PREPROCESSING_VERSION:
            raise PredictionError("unsupported-model", "Model implementation or preprocessing version is not supported.")
        algorithm = definition["algorithm"]
        if algorithm.get("kind") != "knn" or direction not in ("forward", "inverse"):
            raise PredictionError("unsupported-model", "Predictor supports kNN forward and inverse only.")
        dataset = dict(dataset)
        for selection, member in (("calculationIds", "calculations"), ("requiredRecordIds", "records")):
            if selection in definition:
                selected, by_id = definition[selection], {item["id"]: item for item in dataset.get(member, [])}
                if len(set(selected)) != len(selected) or any(identity not in by_id for identity in selected):
                    raise PredictionError("missing-contract", "Selected model contracts are not present in the Dataset revision.")
                dataset[member] = [by_id[identity] for identity in selected]
        layouts = vars_layouts(dataset["varsSchema"])
        models, groups, errors = [], [], {}
        measurements = sorted(dataset["measurements"], key=lambda row: row["id"])
        if direction == "inverse":
            calculations = dataset.get("calculations", [])
            if not calculations:
                raise PredictionError("missing-data", "Select at least one Calculation for Inverse Prediction.")
            fixed = []
            for calculation in calculations:
                output_layout = calculation.get("output_layout")
                if not output_layout:
                    raise PredictionError("missing-contract", f"Calculation #{calculation['id']} has no output contract.")
                fixed.append({"key": f"calculation:{calculation['id']}", **output_layout})
            data = {(row["measurement_id"], row["calculation_id"]): row for row in dataset.get("calculationData", [])}
            rows = []
            for measurement in measurements:
                check_cancel(cancel)
                try:
                    inputs = [calculation_sample(item["id"], data[(measurement["id"], item["id"])]["data"])
                              for item in calculations if (measurement["id"], item["id"]) in data]
                    outputs = vars_samples(measurement["vars"], dataset["varsSchema"])
                    rows.append({"measurementId": measurement["id"], "inputs": inputs, "outputs": outputs})
                except (PredictionError, KeyError, TypeError) as error:
                    rows.append({"measurementId": measurement["id"], "inputs": [], "outputs": [], "error": str(error)})
            models.append(KnnModel.build(rows, direction=direction, fingerprint=definition["fingerprint"],
                                         input_keys=[item["key"] for item in fixed], output_keys=[item["key"] for item in layouts],
                                         algorithm=algorithm, memory_budget=memory_budget, fixed_inputs=fixed, fixed_outputs=layouts, cancel=cancel))
            groups.append({"records": [], "rules": []})
        else:
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
                    model = KnnModel.build(rows, direction=direction, fingerprint=definition["fingerprint"],
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
        metadata = {**model_ref, "formatVersion": 1, "direction": direction, "algorithm": "knn", "definition": definition,
                    "datasetId": dataset["datasetId"], "datasetRevision": dataset["revision"], "datasetFingerprint": dataset["fingerprint"],
                    "experimentId": dataset["experimentId"], "sourceHash": dataset.get("sourceHash"),
                    "varsSchema": dataset["varsSchema"], "calculations": dataset.get("calculations", []),
                    "resultContracts": dataset.get("resultContracts", {}), "records": dataset.get("records", []),
                    "groups": groups, "errors": errors}
        return cls(metadata, models)

    def profile(self) -> dict:
        if self.metadata["direction"] == "inverse":
            return self.models[0].profile()
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

    def prepared(self, instance: dict, artifact: dict) -> dict:
        record_profiles = []
        for record in self.metadata["records"] if self.metadata["direction"] == "forward" else []:
            profile = next((model.profile() for group, model in zip(self.metadata["groups"], self.models)
                            if any(member["id"] == record["id"] for member in group["records"])), None)
            record_profiles.append({"recordId": record["id"], "name": record["name"],
                                    "error": self.metadata["errors"].get(str(record["id"])), "profile": profile})
        return {"fingerprint": self.metadata["definition"]["fingerprint"], "instance": instance,
                "profile": self.profile(), "errors": self.metadata["errors"], "recordProfiles": record_profiles,
                "rules": [rule for group in self.metadata["groups"] for rule in group["rules"]], "artifact": artifact}

    def predict(self, query: dict, cancel=None) -> dict:
        direction = self.metadata["direction"]
        if query.get("direction") != direction:
            raise PredictionError("invalid-data", "Prediction input direction differs from the loaded model.")
        if direction == "forward":
            samples = vars_samples(query["vars"], self.metadata["varsSchema"])
        else:
            samples = [calculation_sample(item["id"], query["targets"][str(item["id"])] if str(item["id"]) in query["targets"] else query["targets"][item["id"]])
                       for item in self.metadata["calculations"]]
        results = [model.predict(samples, cancel) for model in self.models]
        neighbors = {}
        for result in results:
            for neighbor in result["knn"]["neighbors"]:
                row = neighbors.setdefault(neighbor["measurementId"], {"measurementId": neighbor["measurementId"], "distanceSquared": math.inf, "weight": 0})
                row["distanceSquared"] = min(row["distanceSquared"], neighbor["distanceSquared"])
                row["weight"] += neighbor["weight"] / len(results)
        return {"direction": direction, "fingerprint": self.metadata["definition"]["fingerprint"],
                "output": [sample for result in results for sample in result["output"]],
                "extrapolatedInputKeys": sorted(set(key for result in results for key in result["extrapolatedInputKeys"])),
                "constantInputKeysChanged": sorted(set(key for result in results for key in result["constantInputKeysChanged"])),
                "queryDiagnostics": [item for result in results for item in result["queryDiagnostics"]],
                "knn": {"neighbors": results[0]["knn"]["neighbors"] if direction == "inverse" else sorted(neighbors.values(), key=lambda item: (-item["weight"], item["measurementId"]))},
                "provenance": {"modelId": self.metadata["modelId"], "modelRevision": self.metadata["revision"],
                               "datasetId": self.metadata["datasetId"], "datasetRevision": self.metadata["datasetRevision"]}}

    def save(self, store: ArtifactStore, cancel: threading.Event | None = None) -> dict:
        summary = {key: self.metadata[key] for key in ("modelId", "revision", "operationId", "name", "formatVersion", "direction", "algorithm", "definition", "datasetId", "datasetRevision", "datasetFingerprint", "experimentId")}
        summary.update({"profile": self.profile(), "inputLayouts": self.models[0].metadata["inputLayouts"],
                        "outputLayouts": [layout for model in self.models for layout in model.metadata["outputLayouts"]]})
        def write(path: Path):
            (path / "model.json").write_bytes(encode_json({"metadata": self.metadata, "models": [model.metadata for model in self.models]}))
            for index, model in enumerate(self.models):
                check_cancel(cancel)
                for name, array in model.arrays.items():
                    with (path / f"{index}-{name}.npy").open("wb") as stream:
                        np.save(stream, array, allow_pickle=False)
        manifest, _, checksum = store.write("models", self.metadata["modelId"], self.metadata["revision"], summary, write, cancel,
                                            publication_lock=True)
        return {**summary, "storageId": store.storage_id, "launcherId": store.launcher_id,
                "files": manifest["files"], "manifestChecksum": checksum, "verified": True}

    @classmethod
    def load(cls, store: ArtifactStore, model_id: str, revision: int, memory_budget: int, cancel=None):
        if store.deleted(model_id, revision):
            raise PredictionError("deleted", "This model revision has been deleted.")
        manifest, path, checksum = store.read("models", model_id, revision, memory_budget, cancel)
        content = json.loads((path / "model.json").read_bytes())
        expected_files = {"model.json"} | {f"{index}-{name}.npy" for index in range(len(content["models"])) for name in
                                          ("input", "output", "inputMinimums", "inputMaximums", "inputScales", "measurementIds")}
        if expected_files != {file["name"] for file in manifest["files"]}:
            raise PredictionError("artifact-checksum", "Saved model files differ from its complete manifest.")
        if content["metadata"]["modelId"] != model_id or content["metadata"]["revision"] != revision:
            raise PredictionError("artifact-checksum", "Saved model identity differs from the requested revision.")
        definition = content["metadata"]["definition"]
        if definition["implementationVersion"] != IMPLEMENTATION_VERSION or definition["preprocessingVersion"] != PREPROCESSING_VERSION:
            raise PredictionError("unsupported-model", "Saved model requires a different implementation or preprocessing version.")
        models = []
        total = 0
        for index, metadata in enumerate(content["models"]):
            check_cancel(cancel)
            total += metadata["resources"]["workingSetBytes"]
            if total > memory_budget:
                raise PredictionError("memory-limit", "Saved model exceeds the available working memory.")
            arrays = {name: np.load(path / f"{index}-{name}.npy", allow_pickle=False) for name in
                      ("input", "output", "inputMinimums", "inputMaximums", "inputScales", "measurementIds")}
            if arrays["input"].shape != (metadata["rowCount"], metadata["inputSize"]) or arrays["output"].shape != (metadata["rowCount"], metadata["outputSize"]):
                raise PredictionError("artifact-checksum", "Saved model array dimensions differ from its contract.")
            if any(arrays[key].shape != (metadata["inputSize"],) for key in ("inputMinimums", "inputMaximums", "inputScales")) or arrays["measurementIds"].shape != (metadata["rowCount"],):
                raise PredictionError("artifact-checksum", "Saved model scaling arrays differ from its contract.")
            if any(not np.all(np.isfinite(array)) for array in arrays.values()) or np.any(arrays["inputScales"] < 0):
                raise PredictionError("artifact-checksum", "Saved model contains invalid numerical arrays.")
            models.append(KnnModel(metadata, arrays))
        artifact = {**manifest["metadata"], "storageId": store.storage_id, "launcherId": store.launcher_id,
                    "files": manifest["files"], "manifestChecksum": checksum, "verified": True}
        return cls(content["metadata"], models), artifact
