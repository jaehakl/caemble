from copy import deepcopy

import pytest
from caemble_catalog import open_catalog

from app.kernel.api.errors import CaeError
from app.kernel.api.world import interaction_model
from app.kernel.catalog.interactions import normalize_interactions, select_interaction_models
from app.kernel.coordinator.plan import RunPlan


@pytest.fixture
def pair_input():
    with open_catalog() as catalog:
        definitions = {item["key"]: item for item in catalog.material_models()}
        descriptor = catalog.get_solver_manifest("rigid_body", "2.0.0")["descriptor"]
    scenes = {
        "experiment": {
            "roots": [{"id": name, "material": {"name": name}} for name in ["A", "B"]],
            "geometryGroups": [{"name": "bodies", "rootIds": ["A", "B"]}],
        },
        "task": {"roots": []},
    }
    config = {"initializations": [{"methodId": "rigid.body", "target": ["experiment.geometry.bodies"]}]}
    interactions = {
        "AB": {
            "between": ["B", "A"],
            "models": {
                "friction": {
                    "model": "contact.coulomb@1",
                    "parameters": {
                        "muStatic": {"value": 0.6, "unit": "1"},
                        "muDynamic": {"value": 0.4, "unit": "1"},
                    },
                }
            },
        }
    }
    frozen = {
        "contact": [
            {"between": ["A", "A"], "interaction": None, "models": {"friction": None, "restitution": None}},
            {
                "between": ["A", "B"],
                "interaction": "AB",
                "models": {"friction": "friction", "restitution": None},
            },
            {"between": ["B", "B"], "interaction": None, "models": {"friction": None, "restitution": None}},
        ]
    }
    return definitions, descriptor, scenes, config, interactions, frozen


def test_frozen_pair_selection_and_symmetric_lookup(pair_input):
    definitions, descriptor, scenes, config, interactions, frozen = pair_input
    normalized = normalize_interactions(interactions, definitions, {"A", "B"})
    assert "dtype" not in interactions["AB"]["models"]["friction"]["parameters"]["muDynamic"]
    assert normalized["AB"]["models"]["friction"]["parameters"]["muDynamic"]["dtype"] == "float64"
    selected = select_interaction_models(descriptor, config, scenes, normalized, definitions, frozen)
    world = {"interactions": normalized, "interactionSelections": selected}
    first, second = scenes["experiment"]["roots"]
    assert interaction_model(world, first, second, "contact", "friction") == interaction_model(
        world, second, first, "contact", "friction"
    )
    assert interaction_model(world, first, first, "contact", "friction") is None


def test_pair_selection_accepts_javascript_order_for_unicode_names(pair_input):
    definitions, descriptor, scenes, config, interactions, frozen = pair_input
    names = {"A": "\U0001f600", "B": "\ue000"}
    for root in scenes["experiment"]["roots"]:
        root["material"]["name"] = names[root["material"]["name"]]
    interactions["AB"]["between"] = [names[name] for name in interactions["AB"]["between"]]
    for binding in frozen["contact"]:
        binding["between"] = [names[name] for name in binding["between"]]
    assert select_interaction_models(descriptor, config, scenes, interactions, definitions, frozen) == frozen


@pytest.mark.parametrize("change", ["pair", "model", "endpoint", "subject", "parameter"])
def test_invalid_interactions_fail_before_execution(pair_input, change):
    definitions, _, _, _, interactions, _ = pair_input
    if change == "pair":
        interactions["BA"] = {**deepcopy(interactions["AB"]), "between": ["A", "B"]}
    elif change == "model":
        interactions["AB"]["models"]["alias"] = deepcopy(interactions["AB"]["models"]["friction"])
    elif change == "endpoint":
        interactions["AB"]["between"][0] = "Unknown"
    elif change == "subject":
        definitions["contact.coulomb@1"]["subject"] = {"kind": "material"}
    else:
        interactions["AB"]["models"]["friction"]["parameters"]["muStatic"]["value"] = -1
    with pytest.raises(CaeError):
        normalize_interactions(interactions, definitions, {"A", "B"})


def test_changed_or_inapplicable_selections_fail(pair_input):
    definitions, descriptor, scenes, config, interactions, frozen = pair_input
    changed = deepcopy(frozen)
    changed["contact"][1]["models"]["friction"] = None
    with pytest.raises(CaeError, match="Frozen interactionSelections"):
        select_interaction_models(descriptor, config, scenes, interactions, definitions, changed)
    config["interactionModels"] = {"unknown": {}}
    with pytest.raises(CaeError, match="does not apply"):
        select_interaction_models(descriptor, config, scenes, interactions, definitions, frozen)


def test_ordered_models_preserve_endpoints_and_reject_reverse_lookup(pair_input):
    definitions, descriptor, scenes, config, interactions, frozen = pair_input
    definitions["contact.coulomb@1"]["subject"]["exchange"] = "ordered"
    frozen["contact"][1]["between"] = ["B", "A"]
    selected = select_interaction_models(descriptor, config, scenes, interactions, definitions, frozen)
    world = {
        "interactions": interactions,
        "interactionSelections": selected,
        "interactionSubjects": {"contact.coulomb@1": definitions["contact.coulomb@1"]["subject"]},
    }
    first, second = scenes["experiment"]["roots"]
    assert interaction_model(world, second, first, "contact", "friction")["model"] == "contact.coulomb@1"
    with pytest.raises(ValueError, match="declared endpoint order"):
        interaction_model(world, first, second, "contact", "friction")


def test_plan_rejects_same_material_conflicts_before_task_config():
    measurement = {
        "modelDefinitions": [],
        "materialSnapshot": {"materials": {"A": {"models": {}, "color": "#ffffff"}}},
        "taskMaterialSnapshots": {"motion": {"materials": {"A": {"models": {}, "color": "#000000"}}}},
        "materialSelections": {"motion": {}},
        "experiment": {},
    }
    with pytest.raises(CaeError, match="conflicting definitions"):
        RunPlan.prepare(measurement, {"motion": {}}, {})
