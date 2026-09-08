"""Validate explicit Material model inputs and select each role's model groups."""
from __future__ import annotations

from collections.abc import Mapping
import re
from typing import Any

import numpy as np
from caemble_catalog.model_schema import validate_model_parameters

from app.kernel.api.errors import CaeError
from app.kernel.api.units import convert_ucum_tensor


def normalize_model_parameters(value: Any, schema: Mapping[str, Any], path: str) -> Any:
    kind = schema["kind"]
    if kind == "object" and isinstance(value, Mapping):
        return {
            key: normalize_model_parameters(item, schema["fields"][key], f"{path}.{key}")
            if key in schema["fields"] else item
            for key, item in value.items()
        }
    if kind == "list" and isinstance(value, list):
        return [normalize_model_parameters(item, schema["items"], f"{path}[{index}]") for index, item in enumerate(value)]
    if kind != "value" or not schema.get("unit") or not isinstance(value, Mapping) or "value" not in value or "unit" not in value:
        return value
    try:
        if np.asarray(value["value"]).dtype.kind not in "iuf":
            raise ValueError("quantity values must be numeric")
        raw = convert_ucum_tensor(value["value"], value["unit"], schema["unit"])
    except Exception as error:
        raise CaeError("invalid_material", f"{path} must contain numeric values with a unit compatible with {schema['unit']}") from error
    return {**value, "dtype": value.get("dtype", "float64"), "value": raw, "unit": schema["unit"]}


def normalize_material_snapshot(
    snapshot: Mapping[str, Any], definitions: Mapping[str, Any], path: str,
) -> dict[str, Any]:
    if not isinstance(snapshot, Mapping) or set(snapshot) != {"materials"} or not isinstance(snapshot["materials"], Mapping):
        raise CaeError("invalid_material", f"{path} requires a snapshot containing only a materials object")
    materials = {}
    for name, material in snapshot["materials"].items():
        if not isinstance(name, str) or not name.strip() or name != name.strip():
            raise CaeError("invalid_material", f"{path}.{name} requires a non-empty, trimmed Material name")
        if not isinstance(material, Mapping) or set(material) - {"models", "color"} or not isinstance(material.get("models"), Mapping):
            raise CaeError("invalid_material", f"{path}.{name} must contain models and optional color")
        if "color" in material and (not isinstance(material["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", material["color"])):
            raise CaeError("invalid_material", f"{path}.{name}.color must use #RRGGBB format")
        models = {}
        for instance, model in material["models"].items():
            model_path = f"{path}.{name}.models.{instance}"
            if not isinstance(instance, str) or not instance.strip() or instance != instance.strip():
                raise CaeError("invalid_material", f"{model_path} requires a non-empty, trimmed instance name")
            if not isinstance(model, Mapping) or set(model) != {"model", "parameters"}:
                raise CaeError("invalid_material", f"{model_path} must contain model and parameters")
            if not isinstance(model["model"], str):
                raise CaeError("invalid_material", f"{model_path}.model requires a registered model ID")
            definition = definitions.get(model["model"])
            if definition is None:
                raise CaeError("invalid_material", f"{model_path}.model is not registered: {model['model']}")
            if not isinstance(model["parameters"], Mapping):
                raise CaeError("invalid_material", f"{model_path}.parameters must be an object")
            parameters = normalize_model_parameters(
                model["parameters"], definition["parameterSchema"], f"{model_path}.parameters",
            )
            try:
                validate_model_parameters(definition, parameters, f"{model_path}.parameters")
            except ValueError as error:
                raise CaeError("invalid_material", str(error)) from error
            models[instance] = {
                "model": model["model"],
                "parameters": parameters,
            }
        materials[name] = {**material, "models": models}
    return materials


def select_material_models(
    descriptor: Mapping[str, Any], config: Mapping[str, Any], scenes: Mapping[str, Any],
    materials: Mapping[str, Any], selections: Mapping[str, Any],
) -> dict[str, Any]:
    if not isinstance(selections, Mapping):
        raise CaeError("invalid_material", "materialSelections must contain role selections")
    for role, names in selections.items():
        if not isinstance(names, Mapping):
            raise CaeError("invalid_material", f"materialSelections.{role} must contain Material selections")
        for name, groups in names.items():
            if not isinstance(groups, Mapping):
                raise CaeError("invalid_material", f"materialSelections.{role}.{name} must contain model group selections")
            for group, instance in groups.items():
                if not isinstance(instance, str) or not instance:
                    raise CaeError("invalid_material", f"materialSelections.{role}.{name}.{group} must select a model instance name")
    result: dict[str, Any] = {}
    for role in descriptor.get("materials", []):
        target = role["target"]
        parts = []
        if target["category"] == "geometry":
            source = target["source"]
            parts.extend((source, part) for part in scenes[source]["roots"])
        else:
            for rule in config.get(target["category"], []):
                if rule["methodId"] != target["methodId"]:
                    continue
                for selector in rule.get("target", []):
                    source, kind, group_name = selector.split(".", 2)
                    scene = scenes[source]
                    groups = scene["geometryGroups" if kind == "geometry" else "surfaceGroups"]
                    group = next(item for item in groups if item["name"] == group_name)
                    root_ids = group["rootIds"] if kind == "geometry" else [item["rootId"] for item in group["selectors"]]
                    parts.extend((source, part) for part in scene["roots"] if part["id"] in root_ids)
        role_result = {}
        for source, part in parts:
            reference = part.get("material")
            name = reference.get("name") if isinstance(reference, Mapping) else None
            if not isinstance(name, str) or name not in materials[source]:
                raise CaeError("invalid_material", f"{role['role']}: geometry {part['id']} requires an explicit Material")
            models = materials[source][name]["models"]
            chosen = {}
            for group in role["modelGroups"]:
                path = f"{role['role']}.{name}.{group['key']}"
                matches = [instance for instance, model in models.items() if model["model"] in group["oneOf"]]
                selected = selections.get(role["role"], {}).get(name, {}).get(group["key"])
                if selected is not None:
                    if selected not in matches:
                        raise CaeError("invalid_material", f"{path}: selected model {selected!r} is not supported")
                    chosen[group["key"]] = selected
                elif len(matches) == 1:
                    chosen[group["key"]] = matches[0]
                elif len(matches) > 1:
                    raise CaeError("invalid_material", f"{path}: multiple model instances require an explicit selection")
                elif group["required"]:
                    raise CaeError("invalid_material", f"{path}: a supported model is required")
            role_result[name] = chosen
        result[role["role"]] = role_result
    for role, names in selections.items():
        if role not in result:
            raise CaeError("invalid_material", f"{role}: selection role does not apply to this task")
        for name, groups in names.items():
            if name not in result[role]:
                raise CaeError("invalid_material", f"{role}.{name}: Material selection does not apply to this task")
            for group, instance in groups.items():
                if result.get(role, {}).get(name, {}).get(group) != instance:
                    raise CaeError("invalid_material", f"{role}.{name}.{group}: selection does not apply to this task")
    return result
