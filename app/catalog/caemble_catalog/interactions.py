"""Material-pair identity and frozen model validation shared by API and worker."""

from collections.abc import Mapping

from .model_schema import validate_model_parameters


def model_subject(definition):
    subject = definition.get("subject", {"kind": "material"})
    if subject not in (
        {"kind": "material"},
        {"kind": "material-pair", "exchange": "symmetric"},
        {"kind": "material-pair", "exchange": "ordered"},
    ):
        raise ValueError(
            "Model subject must specify material or material-pair with symmetric/ordered exchange"
        )
    return subject


def validate_interactions(interactions, definitions, materials):
    if not isinstance(interactions, Mapping):
        raise ValueError("interactions must be an object")
    pairs, used = set(), set()
    for name, interaction in interactions.items():
        if not isinstance(name, str) or not name.strip() or name != name.strip():
            raise ValueError("Interaction names must be nonempty and trimmed")
        if not isinstance(interaction, Mapping) or set(interaction) != {"between", "models"}:
            raise ValueError(f"interactions.{name} requires between and models")
        endpoints = interaction["between"]
        if (
            not isinstance(endpoints, (list, tuple))
            or len(endpoints) != 2
            or any(not isinstance(item, str) or item not in materials for item in endpoints)
        ):
            raise ValueError(f"interactions.{name}.between must reference two used Materials")
        pair = tuple(sorted(endpoints))
        if pair in pairs:
            raise ValueError(f"interactions.{name}: material pair {pair!r} is duplicated")
        pairs.add(pair)
        if not isinstance(interaction["models"], Mapping):
            raise ValueError(f"interactions.{name}.models must be an object")
        models = set()
        for instance, model in interaction["models"].items():
            path = f"interactions.{name}.models.{instance}"
            if (
                not isinstance(instance, str)
                or not instance.strip()
                or instance != instance.strip()
                or not isinstance(model, Mapping)
                or set(model) != {"model", "parameters"}
            ):
                raise ValueError(f"{path} requires a named model and parameters")
            key = model["model"]
            if (
                not isinstance(key, str)
                or key not in definitions
                or model_subject(definitions[key])["kind"] != "material-pair"
            ):
                raise ValueError(f"{path} requires a registered material-pair model")
            if key in models:
                raise ValueError(f"{path}: model {key} is duplicated")
            models.add(key)
            used.add(key)
            validate_model_parameters(definitions[key], model["parameters"], f"{path}.parameters")
    return used


def validate_interaction_selections(selections, interactions, materials):
    if not isinstance(selections, Mapping):
        raise ValueError("interactionSelections must contain roles")
    for role, bindings in selections.items():
        if not isinstance(bindings, (list, tuple)):
            raise ValueError(f"interactionSelections.{role} must contain pair bindings")
        pairs = set()
        for binding in bindings:
            if not isinstance(binding, Mapping) or set(binding) != {"between", "interaction", "models"}:
                raise ValueError(f"interactionSelections.{role} requires between, interaction and models")
            between = binding["between"]
            if (
                not isinstance(between, (list, tuple))
                or len(between) != 2
                or any(not isinstance(name, str) or name not in materials for name in between)
            ):
                raise ValueError(f"interactionSelections.{role} references unavailable Materials")
            pair = tuple(sorted(between))
            if pair in pairs:
                raise ValueError(f"interactionSelections.{role}: pair is duplicated")
            pairs.add(pair)
            name = binding["interaction"]
            if name is not None and (
                not isinstance(name, str)
                or name not in interactions
                or tuple(sorted(interactions[name]["between"])) != pair
            ):
                raise ValueError(f"interactionSelections.{role} references an unavailable Interaction")
            if not isinstance(binding["models"], Mapping):
                raise ValueError(f"interactionSelections.{role}.models must be an object")
            for instance in binding["models"].values():
                if instance is not None and (
                    not isinstance(instance, str)
                    or name is None
                    or instance not in interactions[name]["models"]
                ):
                    raise ValueError(f"interactionSelections.{role} references an unavailable model instance")
