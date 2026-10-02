"""Versioned, numerical-library-free held-out quality report contracts."""
from __future__ import annotations

import hashlib
import json
import math

QUALITY_VALIDATION_V1 = {"version": 1, "split": "design-point", "holdoutFraction": .2,
                         "seed": 0, "minimumGroups": 5}


def validate_quality_requirements(requirements: list[dict] | None) -> None:
    """Validate consumer-owned RMSE limits without interpreting a model report."""
    if requirements is None:
        return
    if not isinstance(requirements, list) or not requirements:
        raise ValueError("Quality requirements need at least one Record component RMSE limit.")
    identities = set()
    for requirement in requirements:
        if (not isinstance(requirement, dict) or set(requirement) != {"recordId", "component", "rmseMaximum"}
                or type(requirement["recordId"]) is not int or requirement["recordId"] < 1
                or not isinstance(requirement["component"], str) or not requirement["component"].strip()
                or type(requirement["rmseMaximum"]) not in (int, float)
                or not math.isfinite(requirement["rmseMaximum"]) or requirement["rmseMaximum"] < 0):
            raise ValueError("Quality requirements need a positive Record ID, component and finite nonnegative RMSE limit.")
        identity = (requirement["recordId"], requirement["component"])
        if identity in identities:
            raise ValueError("Quality requirements must identify each Record component only once.")
        identities.add(identity)


def assess_quality(report: dict | None, requirements: list[dict] | None) -> dict:
    """Compare held-out RMSE with consumer limits; report integrity is validated separately.

    Missing evidence takes precedence over exceeded limits. A partial report can
    pass when every requested component has a usable held-out metric.
    """
    validate_quality_requirements(requirements)
    if requirements is None:
        return {"status": "unassessed", "reasonCode": "requirements-not-configured", "items": []}
    records = report.get("records", []) if isinstance(report, dict) else []
    items = []
    for requirement in requirements:
        matches = [record for record in records if isinstance(record, dict)
                   and record.get("recordId") == requirement["recordId"]] if isinstance(records, list) else []
        record = matches[0] if len(matches) == 1 else None
        item = {**requirement, "status": "unassessed", "reasonCode": "report-unavailable", "rmse": None,
                "unit": record.get("unit") if record and isinstance(record.get("unit"), str) else None}
        if isinstance(report, dict):
            item["reasonCode"] = "record-unavailable"
            if record is not None and record.get("status") == "evaluated":
                components = record.get("components", [])
                metrics = [component for component in components if isinstance(component, dict)
                           and component.get("component") == requirement["component"]] if isinstance(components, list) else []
                item["reasonCode"] = "component-unavailable"
                if len(metrics) == 1:
                    rmse = metrics[0].get("rmse")
                    item["reasonCode"] = "invalid-rmse"
                    if type(rmse) in (int, float) and math.isfinite(rmse) and rmse >= 0:
                        passed = rmse <= requirement["rmseMaximum"]
                        item.update(status="passed" if passed else "failed", rmse=rmse,
                                    reasonCode="within-limit" if passed else "rmse-exceeded")
        items.append(item)
    status = ("unassessed" if any(item["status"] == "unassessed" for item in items)
              else "failed" if any(item["status"] == "failed" for item in items) else "passed")
    return {"status": status, "reasonCode": "requirements-" + status, "items": items}


def validate_quality_settings(settings: dict | None) -> None:
    if settings is None:
        return
    if (not isinstance(settings, dict) or settings != QUALITY_VALIDATION_V1
            or any(type(settings.get(key)) is not int for key in ("version", "seed", "minimumGroups"))
            or type(settings.get("holdoutFraction")) not in (int, float)):
        raise ValueError("Quality validation v1 requires design-point splitting, 20% holdout, seed 0 and five groups.")


def split_fingerprint(split: dict) -> str:
    content = {key: split[key] for key in ("version", "seed", "holdoutFraction", "trainingMeasurementIds",
                                          "validationMeasurementIds", "trainingGroupCount", "validationGroupCount", "excluded")}
    return "sha256:" + hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":"),
                                                allow_nan=False).encode("utf-8")).hexdigest()


def _measurement_ids(value, label: str) -> set[int]:
    if (not isinstance(value, list) or any(type(identity) is not int or identity < 1 for identity in value)
            or len(set(value)) != len(value)):
        raise ValueError(f"Quality {label} requires unique positive Measurement IDs.")
    return set(value)


def _exclusions(value) -> set[int]:
    if not isinstance(value, list) or any(not isinstance(item, dict)
            or not isinstance(item.get("reason"), str) or not item["reason"] for item in value):
        raise ValueError("Quality exclusions require Measurement IDs and reasons.")
    return _measurement_ids([item.get("measurementId") for item in value], "exclusions")


def validate_quality_report(report: dict | None, definition: dict, dataset: dict | None = None) -> None:
    settings = definition.get("qualityValidation")
    validate_quality_settings(settings)
    if settings is None and report is None:
        return
    if settings is None or not isinstance(report, dict):
        raise ValueError("Requested quality validation requires its frozen report.")
    if (type(report.get("version")) is not int or report["version"] != 1
            or report.get("evaluation") != "pre-save-holdout"
            or report.get("status") not in ("complete", "partial")
            or not isinstance(report.get("definitionFingerprint"), str) or not report["definitionFingerprint"]
            or report.get("definitionFingerprint") != definition.get("fingerprint")):
        raise ValueError("Quality report differs from its model definition or supported version.")
    source = report.get("dataset")
    if (not isinstance(source, dict) or not isinstance(source.get("datasetId"), str) or not source["datasetId"]
            or type(source.get("revision")) is not int or source["revision"] < 1
            or not isinstance(source.get("fingerprint"), str) or not source["fingerprint"]
            or source.get("fingerprint") != definition.get("snapshotFingerprint")
            or (dataset is not None and source != {key: dataset[key] for key in ("datasetId", "revision", "fingerprint")})):
        raise ValueError("Quality report belongs to another Dataset snapshot.")
    split = report.get("split")
    if (not isinstance(split, dict) or any(split.get(key) != settings[key] for key in ("version", "seed", "holdoutFraction"))
            or any(type(split.get(key)) is not int for key in ("version", "seed"))):
        raise ValueError("Quality report split differs from its frozen settings.")
    training = _measurement_ids(split.get("trainingMeasurementIds"), "training partition")
    validation = _measurement_ids(split.get("validationMeasurementIds"), "validation partition")
    excluded = _exclusions(split.get("excluded"))
    if not training or not validation or training & validation or (training | validation) & excluded:
        raise ValueError("Quality training, validation and excluded partitions must be disjoint.")
    counts = [split.get(key) for key in ("trainingGroupCount", "validationGroupCount")]
    if (any(type(count) is not int or count < 1 for count in counts) or sum(counts) < settings["minimumGroups"]
            or counts[1] != math.ceil(sum(counts) * settings["holdoutFraction"])
            or counts[0] > len(training) or counts[1] > len(validation)
            or split.get("fingerprint") != split_fingerprint(split)):
        raise ValueError("Quality split inventory or fingerprint is invalid.")
    records = report.get("records")
    if not isinstance(records, list) or not records or any(not isinstance(record, dict) for record in records):
        raise ValueError("Quality report requires output records.")
    _measurement_ids([record.get("recordId") for record in records], "Record inventory")
    evaluated, partial = False, bool(excluded)
    for record in records:
        trained = _measurement_ids(record.get("trainingMeasurementIds"), "Record training samples")
        checked = _measurement_ids(record.get("evaluatedMeasurementIds"), "Record validation samples")
        skipped = _exclusions(record.get("excluded"))
        components, groups = record.get("components"), record.get("evaluatedGroupCount")
        if (not trained.issubset(training) or not checked.issubset(validation) or checked & skipped
                or checked | skipped != validation or not isinstance(record.get("key"), str)
                or not isinstance(record.get("unit"), str) or not isinstance(components, list)
                or type(groups) is not int or not 0 <= groups <= min(len(checked), counts[1])):
            raise ValueError("Quality Record inventory differs from its split.")
        if record.get("status") == "unavailable":
            if checked or components or groups:
                raise ValueError("Unavailable quality outputs cannot contain error metrics.")
            partial = True
            continue
        if record.get("status") != "evaluated" or not checked or not trained or not components or not groups:
            raise ValueError("Evaluated quality outputs require training samples and held-out metrics.")
        evaluated = True
        partial |= bool(skipped)
        names = []
        for component in components:
            if not isinstance(component, dict) or not isinstance(component.get("component"), str):
                raise ValueError("Quality component identity is invalid.")
            names.append(component["component"])
            if any(type(component.get(key)) not in (int, float) or not math.isfinite(component[key])
                   or component[key] < 0 for key in ("mae", "rmse", "maxAbsoluteError")):
                raise ValueError("Quality errors must be finite and nonnegative.")
        if len(set(names)) != len(names):
            raise ValueError("Quality component identities must be unique.")
    if not evaluated or report["status"] != ("partial" if partial else "complete"):
        raise ValueError("Quality report must accurately identify complete or partial evaluation.")
