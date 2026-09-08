"""Validate explicit, reproducible Material inputs without external coefficient lookup."""

from __future__ import annotations

import json
import math
import re
import struct

from caemble_catalog import Catalog, CatalogNotFoundError
from caemble_catalog.model_schema import validate_model_parameters, validate_parameter_schema


def material_vars_hash(variables: dict) -> str:
    if not isinstance(variables, dict) or any(not isinstance(key, str) for key in variables):
        raise ValueError("vars must be an object with string keys.")

    def encode(value):
        if isinstance(value, list):
            return [encode(item) for item in value]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("vars must contain finite numbers or nested arrays of numbers.")
        try:
            number = float(value or 0)
        except OverflowError as error:
            raise ValueError("vars must contain finite numbers or nested arrays of numbers.") from error
        if not math.isfinite(number):
            raise ValueError("vars must contain finite numbers or nested arrays of numbers.")
        return struct.pack(">d", number).hex()

    pairs = [[key, encode(variables[key])] for key in sorted(variables, key=lambda key: key.encode("utf-16-be"))]
    serialized = json.dumps(pairs, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    fingerprint = 14695981039346656037
    for byte in serialized:
        fingerprint = ((fingerprint ^ byte) * 1099511628211) & 0xffffffffffffffff
    return f"fnv1a64:{fingerprint:016x}"


def validate_material_snapshot(
    value: object, *, source_hash: str | None = None, variables: dict | None = None,
    catalog: Catalog | None = None,
) -> dict:
    path = "material_snapshot"
    fields = {"experiment", "tasks", "modelDefinitions", "selections", "sourceHash", "varsHash"}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"{path} must contain {', '.join(sorted(fields))}.")
    if not isinstance(value["sourceHash"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["sourceHash"]):
        raise ValueError(f"{path}.sourceHash must be a SHA256 digest.")
    if not isinstance(value["varsHash"], str) or not re.fullmatch(r"fnv1a64:[0-9a-f]{16}", value["varsHash"]):
        raise ValueError(f"{path}.varsHash must be a vars fingerprint.")
    if source_hash is not None and value["sourceHash"] != source_hash:
        raise ValueError(f"{path}.sourceHash differs from the Experiment source.")
    if variables is not None and value["varsHash"] != material_vars_hash(variables):
        raise ValueError(f"{path}.varsHash differs from the Measurement vars.")
    if not isinstance(value["tasks"], dict) or not isinstance(value["selections"], dict):
        raise ValueError(f"{path}.tasks and selections must be objects.")
    if set(value["tasks"]) != set(value["selections"]):
        raise ValueError(f"{path}.selections must identify every Task exactly once.")
    if not isinstance(value["modelDefinitions"], list):
        raise ValueError(f"{path}.modelDefinitions must be an array.")
    definitions = {}
    for index, definition in enumerate(value["modelDefinitions"]):
        if not isinstance(definition, dict) or not isinstance(definition.get("key"), str):
            raise ValueError(f"{path}.modelDefinitions[{index}] must identify a Model definition.")
        key = definition["key"]
        if not re.fullmatch(r"[^\s@]+@[1-9][0-9]*", key) or key in definitions:
            raise ValueError(f"{path}.modelDefinitions[{index}].key is invalid or duplicated.")
        required = {"key", "labelKo", "description", "equation", "conventions", "parameterSchema"}
        if set(definition) - required - {"solverRequirements"} or not required <= set(definition):
            raise ValueError(f"{path}.modelDefinitions[{index}] must contain the complete Model definition.")
        for field in required - {"parameterSchema"}:
            if not isinstance(definition[field], str):
                raise ValueError(f"{path}.modelDefinitions[{index}].{field} must be a string.")
        if "solverRequirements" in definition and not isinstance(definition["solverRequirements"], list):
            raise ValueError(f"{path}.modelDefinitions[{index}].solverRequirements must be an array.")
        if not isinstance(definition.get("parameterSchema"), dict):
            raise ValueError(f"{path}.modelDefinitions[{index}].parameterSchema must be an object.")
        try:
            validate_parameter_schema(definition["parameterSchema"], f"{path}.modelDefinitions[{index}].parameterSchema")
        except (TypeError, OverflowError, RecursionError) as error:
            raise ValueError(f"{path}.modelDefinitions[{index}].parameterSchema is invalid.") from error
        if catalog is not None:
            try:
                canonical = catalog.material_model(key)
            except CatalogNotFoundError as error:
                raise ValueError(f"{path}.modelDefinitions[{index}].key is not registered in the Catalog.") from error
            if {field: definition.get(field) for field in canonical} != canonical:
                raise ValueError(f"{path}.modelDefinitions[{index}] differs from the registered Model definition.")
        definitions[key] = definition
    materials = {}
    used_models = set()
    snapshots = [("experiment", value["experiment"]), *[(f"tasks.{name}", item) for name, item in value["tasks"].items()]]
    for location, snapshot in snapshots:
        if not isinstance(snapshot, dict) or set(snapshot) != {"materials"} or not isinstance(snapshot["materials"], dict):
            raise ValueError(f"{path}.{location} must contain a materials object.")
        for name, material in snapshot["materials"].items():
            material_path = f"{path}.{location}.materials.{name}"
            if not isinstance(name, str) or not name.strip() or name != name.strip():
                raise ValueError(f"{material_path} must use a non-empty, trimmed Material name.")
            if not isinstance(material, dict) or set(material) - {"color", "models"} or not isinstance(material.get("models"), dict):
                raise ValueError(f"{material_path} must contain models and optional color.")
            if "color" in material and (not isinstance(material["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", material["color"])):
                raise ValueError(f"{material_path}.color must use #RRGGBB format.")
            if name in materials and material != materials[name]:
                raise ValueError(f"{material_path} conflicts with another Material of the same name.")
            materials[name] = material
            for instance, model in material["models"].items():
                model_path = f"{material_path}.models.{instance}"
                if not isinstance(instance, str) or not instance.strip() or instance != instance.strip():
                    raise ValueError(f"{model_path} must use a non-empty, trimmed instance name.")
                if not isinstance(model, dict) or set(model) != {"model", "parameters"}:
                    raise ValueError(f"{model_path} must contain model and parameters.")
                if not isinstance(model["model"], str) or model["model"] not in definitions:
                    raise ValueError(f"{model_path}.model has no captured Model definition.")
                used_models.add(model["model"])
                if not isinstance(model["parameters"], dict):
                    raise ValueError(f"{model_path}.parameters must be an object.")
                try:
                    validate_model_parameters(definitions[model["model"]], model["parameters"], f"{model_path}.parameters")
                except (TypeError, OverflowError, RecursionError) as error:
                    raise ValueError(f"{model_path}.parameters is invalid.") from error
    if set(definitions) != used_models:
        raise ValueError(f"{path}.modelDefinitions must capture exactly the models used by its Materials.")
    for task, roles in value["selections"].items():
        available = {**value["experiment"]["materials"], **value["tasks"][task]["materials"]}
        if not isinstance(roles, dict):
            raise ValueError(f"{path}.selections.{task} must contain role selections.")
        for role, selected_materials in roles.items():
            if not isinstance(selected_materials, dict):
                raise ValueError(f"{path}.selections.{task}.{role} must contain Material selections.")
            for name, groups in selected_materials.items():
                if name not in available or not isinstance(groups, dict):
                    raise ValueError(f"{path}.selections.{task}.{role}.{name} must select an available Material.")
                for group, instance in groups.items():
                    if not isinstance(instance, str) or instance not in available[name]["models"]:
                        raise ValueError(f"{path}.selections.{task}.{role}.{name}.{group} must select an available model instance.")
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError, RecursionError) as error:
        raise ValueError(f"{path} must contain finite JSON values.") from error
    return value
