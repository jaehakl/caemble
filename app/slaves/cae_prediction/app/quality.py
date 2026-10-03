"""Design-point holdout evaluation of the actual model that will be saved."""
from __future__ import annotations

from dataclasses import replace
from copy import deepcopy
import hashlib
import json
import math

import numpy as np

from prediction_contracts import QUALITY_VALIDATION_V1, validate_quality_report, validate_quality_settings
from prediction_contracts.quality import lineage_fingerprint, split_fingerprint

from .errors import PredictionError
from .representations import recorded_sample, validate_sample, vars_samples
from .storage import check_cancel


def split_dataset(dataset: dict, cancel=None, *, settings: dict | None = None,
                  lineage: dict | None = None) -> tuple[dict, list[list[dict]], dict]:
    """Partition shallow views; the immutable source payload and its identity stay intact."""
    settings = settings or QUALITY_VALIDATION_V1
    validate_quality_settings(settings)
    groups, excluded = {}, []
    for row in sorted(dataset["measurements"], key=lambda item: item["id"]):
        check_cancel(cancel)
        try:
            samples = vars_samples(row["vars"], dataset["varsSchema"])
            # Normalize both integer/float spelling and signed zero before hashing.
            values = [[sample["layout"]["key"], [0.0 if value == 0 else float(value)
                       for value in sample["values"]]] for sample in samples]
            canonical = json.dumps([settings["seed"], values], separators=(",", ":"), allow_nan=False)
            key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
            groups.setdefault(key, []).append(row)
        except (PredictionError, KeyError, TypeError, ValueError) as error:
            excluded.append({"measurementId": row["id"], "reason": str(error)})
    if len(groups) < settings["minimumGroups"]:
        raise PredictionError("quality-unavailable", "Quality validation requires at least five distinct valid design points.")
    if lineage is None:
        ordered = sorted(groups)
        count = math.ceil(len(ordered) * settings["holdoutFraction"])
        validation = [groups[key] for key in ordered[:count]]
        training = [groups[key] for key in ordered[count:]]
        if settings["version"] == 2:
            lineage = {"rootSnapshot": {key: dataset[key] for key in ("datasetId", "revision", "fingerprint")},
                       "validationGroups": [{"designFingerprint": key, "measurementIds": sorted(row["id"] for row in groups[key])}
                                            for key in ordered[:count]]}
            lineage["fingerprint"] = lineage_fingerprint(lineage, settings)
    else:
        if settings["version"] != 2:
            raise PredictionError("quality-lineage", "Frozen validation lineage requires quality version 2.")
        validation, training = [], []
        held_out = {group["designFingerprint"]: set(group["measurementIds"]) for group in lineage["validationGroups"]}
        for key, identities in held_out.items():
            rows = {row["id"]: row for row in groups.get(key, [])}
            if not identities.issubset(rows):
                raise PredictionError("quality-lineage", "Root validation designs changed or were removed; create a fresh model instead.")
            validation.append([rows[identity] for identity in sorted(identities)])
            excluded.extend({"measurementId": identity, "reason": "Repeated root validation design is reserved from training."}
                            for identity in sorted(rows.keys() - identities))
        training = [rows for key, rows in sorted(groups.items()) if key not in held_out]
        if not training:
            raise PredictionError("quality-unavailable", "Quality validation requires training designs outside its root holdout.")
    training_ids = sorted(row["id"] for group in training for row in group)
    validation_ids = sorted(row["id"] for group in validation for row in group)
    split = {"version": settings["version"], "seed": settings["seed"], "holdoutFraction": settings["holdoutFraction"], "trainingMeasurementIds": training_ids,
             "validationMeasurementIds": validation_ids, "trainingGroupCount": len(training),
             "validationGroupCount": len(validation), "excluded": sorted(excluded, key=lambda item: item["measurementId"])}
    if lineage is not None:
        split["lineageFingerprint"] = lineage["fingerprint"]
    split["fingerprint"] = split_fingerprint(split)
    if lineage is not None:
        split["lineage"] = deepcopy(lineage)
    selected = set(training_ids)
    payload = {**dataset, "measurements": [row for row in dataset["measurements"] if row["id"] in selected]}
    for key in ("recorded", "calculationData"):
        if key in dataset:
            payload[key] = [row for row in dataset[key] if row["measurement_id"] in selected]
    return payload, validation, split


def evaluate_quality(bundle, dataset: dict, groups: list[list[dict]], split: dict, context_factory) -> dict:
    """Stream one Measurement at a time, then weight each design-point group equally."""
    definition = bundle.metadata["definition"]
    selected = set(definition.get("requiredRecordIds", [record["id"] for record in dataset["records"]]))
    records = [record for record in dataset["records"] if record["id"] in selected]
    profiles = {entry["recordId"]: entry.get("profile") for entry in
                bundle.implementation.preparation_details().get("recordProfiles", [])}
    fallback_ids = bundle.profile()["includedMeasurementIds"]
    layouts = {layout["key"]: layout for layout in bundle.implementation.output_layouts}
    stored = {(row["measurement_id"], row["experiment_record_id"]): row for row in dataset.get("recorded", [])}
    reports, accumulators = [], {}
    for record in records:
        profile = profiles.get(record["id"], bundle.profile() if not profiles else None)
        layout = layouts.get(record["name"], {})
        reports.append({"recordId": record["id"], "key": record["name"], "unit": layout.get("unit", ""),
                        "status": "unavailable", "trainingMeasurementIds": sorted(profile.get("includedMeasurementIds", fallback_ids)) if profile else [],
                        "evaluatedMeasurementIds": [], "evaluatedGroupCount": 0, "excluded": [], "components": []})
        accumulators[record["id"]] = []
    for group in groups:
        group_errors = {record["id"]: [] for record in records}
        for measurement in group:
            context = context_factory()
            check_cancel(context.cancel)
            context = replace(context, available_ram_bytes=max(0, context.available_ram_bytes - bundle.persistent_bytes))
            prediction = bundle.predict({"direction": "forward", "vars": measurement["vars"]}, context)
            predicted = {sample["layout"]["key"]: sample for sample in prediction["output"]}
            for report in reports:
                check_cancel(context.cancel)
                try:
                    sample = predicted.get(report["key"])
                    if sample is None or not report["trainingMeasurementIds"]:
                        raise PredictionError("quality-unavailable", "No trained output is available for this Record.")
                    layout = sample["layout"]
                    grid = layout.get("boxGrid", {})
                    if (layout.get("dtype") not in ("float32", "float64") or grid.get("channels") != ["value"]
                            or grid.get("frequencyKind") == "modal" or layout.get("frequencyOutput")):
                        raise PredictionError("unsupported-representation", "Quality v1 supports real-valued non-modal BoxGrid outputs.")
                    row = stored.get((measurement["id"], report["recordId"]))
                    if row is None:
                        raise PredictionError("missing-block", "Validation Measurement has no recorded output.")
                    needed = math.prod(layout["shape"]) * 8 * 4
                    if needed > context.available_ram_bytes:
                        raise PredictionError("memory-limit", "Quality comparison exceeds the available working memory.")
                    actual = recorded_sample(row)
                    predicted_values = validate_sample(sample, layouts[report["key"]])
                    actual_values = validate_sample(actual, layout)
                    errors = (predicted_values - actual_values).reshape(-1, len(grid["components"]))
                    with np.errstate(over="ignore", invalid="ignore"):
                        metrics = np.stack([np.abs(errors).mean(axis=0), np.square(errors).mean(axis=0), np.abs(errors).max(axis=0)])
                    if not np.isfinite(metrics).all():
                        raise PredictionError("invalid-tensor", "Quality errors exceed the finite numeric range.")
                    group_errors[report["recordId"]].append(metrics)
                    report["evaluatedMeasurementIds"].append(measurement["id"])
                except (PredictionError, ValueError, TypeError, KeyError, IndexError) as error:
                    if isinstance(error, PredictionError) and error.code in ("memory-limit", "cancelled"):
                        raise
                    report["excluded"].append({"measurementId": measurement["id"],
                                              "reason": str(error) or type(error).__name__})
        for report in reports:
            values = group_errors[report["recordId"]]
            if values:
                averaged = np.mean(values, axis=0)
                averaged[2] = np.max([value[2] for value in values], axis=0)
                accumulators[report["recordId"]].append(averaged)
                report["evaluatedGroupCount"] += 1
    for report in reports:
        values = accumulators[report["recordId"]]
        if values:
            averaged = np.mean(values, axis=0)
            maximum = np.max([value[2] for value in values], axis=0)
            report["status"] = "evaluated"
            report["components"] = [{"component": component, "mae": float(averaged[0, index]),
                "rmse": float(math.sqrt(averaged[1, index])), "maxAbsoluteError": float(maximum[index])}
                for index, component in enumerate(layouts[report["key"]]["boxGrid"]["components"])]
        report["evaluatedMeasurementIds"].sort()
        report["excluded"].sort(key=lambda item: item["measurementId"])
    if not any(report["status"] == "evaluated" for report in reports):
        raise PredictionError("quality-unavailable", "No compatible held-out BoxGrid output could be evaluated.")
    report = {"version": split["version"], "evaluation": "pre-save-holdout",
              "status": "partial" if split["excluded"] or any(item["excluded"] for item in reports) else "complete",
              "dataset": {key: dataset[key] for key in ("datasetId", "revision", "fingerprint")},
              "definitionFingerprint": definition["fingerprint"],
              "split": {key: value for key, value in split.items() if key != "lineage"}, "records": reports}
    if "lineage" in split:
        report["lineage"] = deepcopy(split["lineage"])
    validate_quality_report(report, definition, dataset)
    return report
