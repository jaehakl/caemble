"""Resolve frozen material-pair models without solver-specific defaults."""

from itertools import combinations_with_replacement
from collections.abc import Mapping

from caemble_catalog.interactions import model_subject, validate_interactions, validate_interaction_selections

from app.kernel.api.errors import CaeError
from .materials import normalize_model_parameters


def normalize_interactions(interactions, definitions, materials):
    try:
        if not isinstance(interactions, Mapping):
            raise ValueError("interactions must be an object")
        result = {}
        for name, interaction in interactions.items():
            if not isinstance(interaction, Mapping) or not isinstance(interaction.get("models"), Mapping):
                raise ValueError(f"interactions.{name} requires models")
            models = {}
            for instance, model in interaction["models"].items():
                if (
                    not isinstance(model, Mapping)
                    or not isinstance(model.get("model"), str)
                    or model["model"] not in definitions
                ):
                    raise ValueError(f"interactions.{name}.{instance} requires a registered model")
                models[instance] = {
                    **model,
                    "parameters": normalize_model_parameters(
                        model.get("parameters"),
                        definitions[model["model"]]["parameterSchema"],
                        f"interactions.{name}.{instance}.parameters",
                    ),
                }
            result[name] = {**interaction, "models": models}
        validate_interactions(result, definitions, materials)
        return result
    except ValueError as error:
        raise CaeError("invalid_material", str(error)) from error


def select_interaction_models(descriptor, config, scenes, interactions, definitions, frozen):
    result = {}
    consumed = set()
    explicit = config.get("interactionModels", {})
    try:
        if not isinstance(explicit, Mapping):
            raise ValueError("interactionModels must be an object")
        for role in descriptor.get("interactions", []):
            target, parts = role["target"], []
            if target["category"] == "geometry":
                parts.extend(scenes[target["source"]]["roots"])
            else:
                for call in config.get(target["category"], []):
                    if call["methodId"] != target["methodId"]:
                        continue
                    for selector in call["target"]:
                        source, kind, group_name = selector.split(".", 2)
                        scene = scenes[source]
                        group = next(
                            group
                            for group in scene["geometryGroups" if kind == "geometry" else "surfaceGroups"]
                            if group["name"] == group_name
                        )
                        roots = (
                            group["rootIds"]
                            if kind == "geometry"
                            else [item["rootId"] for item in group["selectors"]]
                        )
                        parts.extend(part for part in scene["roots"] if part["id"] in roots)
            if any(not part.get("material") for part in parts):
                raise ValueError(f"{role['role']}: interaction targets require Materials")
            # Match the author's JavaScript string ordering, including non-BMP names.
            names = sorted(
                {part["material"]["name"] for part in parts}, key=lambda name: name.encode("utf-16-be")
            )
            bindings = []
            for pair in combinations_with_replacement(names, 2):
                name = next(
                    (
                        name
                        for name, value in interactions.items()
                        if tuple(sorted(value["between"], key=lambda item: item.encode("utf-16-be"))) == pair
                    ),
                    None,
                )
                interaction = interactions.get(name, {"models": {}})
                selected, ordered = {}, False
                for group in role["modelGroups"]:
                    candidates = [
                        key
                        for key, model in interaction["models"].items()
                        if model["model"] in group["oneOf"]
                    ]
                    requested = explicit.get(role["role"], {}).get(name, {}).get(group["key"])
                    if requested is not None:
                        if requested not in candidates:
                            raise ValueError(
                                f"{role['role']}.{name}.{group['key']}: incompatible model selection"
                            )
                        consumed.add((role["role"], name, group["key"]))
                    elif len(candidates) > 1:
                        raise ValueError(
                            f"{role['role']}.{name}.{group['key']}: multiple models require explicit selection"
                        )
                    instance = requested if requested is not None else (candidates[0] if candidates else None)
                    if instance is None and (group["required"] or not group.get("defaultBehavior")):
                        raise ValueError(
                            f"{role['role']}.{pair}.{group['key']}: required Interaction model is missing"
                        )
                    selected[group["key"]] = instance
                    if instance is not None:
                        ordered |= (
                            model_subject(definitions[interaction["models"][instance]["model"]]).get(
                                "exchange"
                            )
                            == "ordered"
                        )
                bindings.append(
                    {
                        "between": list(interaction["between"] if ordered else pair),
                        "interaction": name,
                        "models": selected,
                    }
                )
            result[role["role"]] = bindings
        for role, values in explicit.items():
            if role not in result:
                raise ValueError(f"interactionModels.{role}: selection does not apply")
            if not isinstance(values, Mapping):
                raise ValueError(f"interactionModels.{role} must be an object")
            for name, groups in values.items():
                if (
                    not any(binding["interaction"] == name for binding in result[role])
                    or not isinstance(groups, Mapping)
                    or any((role, name, group) not in consumed for group in groups)
                ):
                    raise ValueError(f"interactionModels.{role}.{name}: selection does not apply")
        materials = {
            part["material"]["name"]
            for scene in scenes.values()
            for part in scene["roots"]
            if part.get("material")
        }
        validate_interaction_selections(frozen, interactions, materials)
        if frozen != result:
            raise ValueError("Frozen interactionSelections do not match the Task inputs")
        return result
    except (ValueError, AttributeError, TypeError) as error:
        raise CaeError("invalid_material", str(error)) from error
