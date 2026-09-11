from __future__ import annotations

import copy
import math

import numpy as np
import pytest
from caemble_catalog import open_catalog

from app.kernel.api.errors import CaeError
from app.kernel.api.world import material_model
from app.kernel.catalog.materials import normalize_material_snapshot, select_material_models
from app.kernel.coordinator.plan import RunPlan
from app.solvers.ray_tracing.materials import optical_material
from app.methods.optics import VACUUM_LIGHT_SPEED


@pytest.fixture(scope="module")
def definitions():
    with open_catalog() as catalog:
        return {item["key"]: item for item in catalog.material_models()}


def conductor():
    return {"models": {
        "electrical": {"model": "electrical.ohmic-conduction@1", "parameters": {
            "sigma": {"dtype": "float32", "value": (np.eye(3) * 2).tolist(), "unit": "S.cm-1"},
        }},
        "thermal": {"model": "heat.fourier-conduction@1", "parameters": {
            "k": {"value": (np.eye(3) * 4).tolist(), "unit": "W.m-1.K-1"},
        }},
    }}


@pytest.fixture
def built_material_input(definitions):
    return {
        "experiment": {"simulationProgram": {"resultContracts": {}}, "scene": {}},
        "materialSnapshot": {"materials": {"sample": conductor()}},
        "taskMaterialSnapshots": {},
        "materialSelections": {},
        "modelDefinitions": [copy.deepcopy(definitions[key]) for key in (
            "electrical.ohmic-conduction@1", "heat.fourier-conduction@1",
        )],
    }


def test_snapshot_normalizes_units_without_mutating_or_reducing_tensor(definitions):
    source = {"materials": {"sample": conductor()}}
    before = copy.deepcopy(source)
    snapshot = normalize_material_snapshot(source, definitions, "experiment.materials")
    selected = material_model({
        "materials": {"experiment": snapshot},
        "materialSelections": {"conductor": {"sample": {"conduction": "electrical"}}},
    }, {"material": {"name": "sample"}}, "conductor", "conduction")
    assert source == before
    sigma = selected["parameters"]["sigma"]
    assert sigma["dtype"] == "float32"
    assert sigma["unit"] == "S.m-1"
    np.testing.assert_array_equal(sigma["value"], np.eye(3) * 200)


def test_omitted_quantity_dtype_defaults_to_float64_even_for_float32_schema(definitions):
    definitions = copy.deepcopy(definitions)
    definitions["heat.fourier-conduction@1"]["parameterSchema"]["fields"]["k"]["dtype"] = "float32"
    snapshot = normalize_material_snapshot({"materials": {"sample": conductor()}}, definitions, "experiment.materials")
    assert snapshot["sample"]["models"]["thermal"]["parameters"]["k"]["dtype"] == "float64"


@pytest.mark.parametrize("problem", ["missing", "shape", "unit", "unknown"])
def test_invalid_model_parameter_reports_material_instance_path(definitions, problem):
    material = conductor()
    model = material["models"]["electrical"]
    if problem == "missing":
        del model["parameters"]["sigma"]
    elif problem == "shape":
        model["parameters"]["sigma"]["value"] = list(range(9))
    elif problem == "unit":
        model["parameters"]["sigma"]["unit"] = "K"
    else:
        model["model"] = "unregistered@1"
    with pytest.raises(CaeError, match=r"experiment.materials.sample.models.electrical"):
        normalize_material_snapshot({"materials": {"sample": material}}, definitions, "experiment.materials")


@pytest.mark.parametrize("snapshot", [None, {}, {"materials": []}, {"materials": {}, "source": "database"}])
def test_snapshot_rejects_malformed_wrapper(definitions, snapshot):
    with pytest.raises(CaeError, match="snapshot containing only a materials object"):
        normalize_material_snapshot(snapshot, definitions, "experiment.materials")


@pytest.mark.parametrize("problem", [
    "material-name", "material-extra", "color", "instance-name", "instance-extra", "parameters",
])
def test_snapshot_rejects_invalid_material_and_instance_envelopes(definitions, problem):
    material = conductor()
    name = "sample"
    if problem == "material-name":
        name = " sample "
    elif problem == "material-extra":
        material["source"] = "handbook"
    elif problem == "color":
        material["color"] = "red"
    elif problem == "instance-name":
        material["models"][""] = material["models"].pop("electrical")
    elif problem == "instance-extra":
        material["models"]["electrical"]["version"] = 1
    else:
        material["models"]["electrical"]["parameters"] = []
    with pytest.raises(CaeError, match=r"experiment.materials"):
        normalize_material_snapshot({"materials": {name: material}}, definitions, "experiment.materials")


@pytest.mark.parametrize("problem", ["array", "item", "duplicate", "extra", "missing", "metadata", "requirements", "schema"])
def test_run_plan_rejects_invalid_or_modified_captured_definitions(built_material_input, problem):
    captured = built_material_input["modelDefinitions"]
    if problem == "array":
        built_material_input["modelDefinitions"] = {}
    elif problem == "item":
        captured[0] = None
    elif problem == "duplicate":
        captured.append(copy.deepcopy(captured[0]))
    elif problem == "extra":
        captured[0]["implementation"] = "untrusted"
    elif problem == "missing":
        del captured[0]["description"]
    elif problem == "metadata":
        captured[0]["conventions"] += " altered"
    elif problem == "requirements":
        captured[0]["solverRequirements"] = {}
    else:
        captured[0]["parameterSchema"] = []
    with pytest.raises(CaeError, match=r"[Mm]odel[Dd]efinition|Model definition"):
        RunPlan.prepare(built_material_input, {}, {})


def test_run_plan_allows_catalog_response_metadata_and_definition_key_order(built_material_input):
    built_material_input["modelDefinitions"] = [
        {"solverRequirements": [], **dict(reversed(list(definition.items())))}
        for definition in built_material_input["modelDefinitions"]
    ]
    plan = RunPlan.prepare(built_material_input, {}, {})
    assert plan.material_snapshot["sample"]["models"]["electrical"]["parameters"]["sigma"]["dtype"] == "float32"


@pytest.mark.parametrize("problem", ["unused", "missing"])
def test_run_plan_requires_exact_captured_model_coverage(built_material_input, definitions, problem):
    if problem == "unused":
        built_material_input["modelDefinitions"].append(definitions["optics.constant-complex-index@1"])
    else:
        built_material_input["modelDefinitions"].pop()
    with pytest.raises(CaeError, match="capture exactly|not registered"):
        RunPlan.prepare(built_material_input, {}, {})


@pytest.mark.parametrize("field", ["taskMaterialSnapshots", "materialSelections"])
@pytest.mark.parametrize("value", [None, {"unknown": {}}])
def test_run_plan_requires_snapshot_and_selection_for_exact_task_set(built_material_input, field, value):
    built_material_input[field] = value
    with pytest.raises(CaeError, match=field):
        RunPlan.prepare(built_material_input, {}, {})


@pytest.mark.parametrize("selection", [None, {"role": []}, {"role": {"sample": []}}, {"role": {"sample": {"group": 1}}}])
def test_model_selection_rejects_malformed_tree(selection):
    with pytest.raises(CaeError, match="materialSelections"):
        select_material_models({"materials": []}, {}, {}, {}, selection)


def test_model_selection_rejects_unknown_empty_role():
    with pytest.raises(CaeError, match="selection role does not apply"):
        select_material_models({"materials": []}, {}, {}, {}, {"unknown": {}})


@pytest.mark.parametrize("reference", [None, {}, {"name": "unknown"}, {"name": []}])
def test_applicable_geometry_requires_a_material_snapshot(reference):
    with open_catalog() as catalog:
        descriptor = catalog.get_solver_manifest("fdtd", "3.0.0")["descriptor"]
    scene = {"roots": [{"id": "part", "material": reference}]}
    with pytest.raises(CaeError, match="geometry part requires an explicit Material"):
        select_material_models(descriptor, {}, {"experiment": scene}, {"experiment": {}}, {})


def test_groups_are_checked_for_each_material_and_require_explicit_ambiguity_selection(definitions):
    with open_catalog() as catalog:
        descriptor = catalog.get_solver_manifest("dc-current-density", "1.0.0")["descriptor"]
    scene = {"roots": [{"id": name, "material": {"name": name}} for name in ("a", "b")],
             "geometryGroups": [{"name": "conductor", "rootIds": ["a", "b"]}]}
    config = {"initializations": [{"methodId": "dc.voxel-grid", "target": ["experiment.geometry.conductor"]}]}
    materials = normalize_material_snapshot({"materials": {"a": conductor(), "b": conductor()}}, definitions, "materials")
    del materials["b"]["models"]["electrical"]
    with pytest.raises(CaeError, match=r"conductor.b.conduction"):
        select_material_models(descriptor, config, {"experiment": scene}, {"experiment": materials}, {})
    materials["b"] = copy.deepcopy(materials["a"])
    materials["a"]["models"]["second"] = copy.deepcopy(materials["a"]["models"]["electrical"])
    with pytest.raises(CaeError, match="multiple model instances"):
        select_material_models(descriptor, config, {"experiment": scene}, {"experiment": materials}, {})
    result = select_material_models(descriptor, config, {"experiment": scene}, {"experiment": materials}, {
        "conductor": {"a": {"conduction": "second"}},
    })
    assert result["conductor"] == {"a": {"conduction": "second"}, "b": {"conduction": "electrical"}}


def test_ray_preserves_independent_extinction_and_absorption_and_defined_omission(definitions):
    snapshot = normalize_material_snapshot({"materials": {"sample": {"models": {
        "optical": {"model": "optics.constant-complex-index@1", "parameters": {
            "n": {"value": 1.6, "unit": "1"}, "k": {"value": 0.7, "unit": "1"},
        }},
        "bulk": {"model": "optics.constant-absorption@1", "parameters": {"alpha": {"value": 2000, "unit": "m-1"}}},
    }}}}, definitions, "materials")
    groups = {"opticalResponse": "optical", "absorption": "bulk"}
    world = {"materials": {"experiment": snapshot}, "materialSelections": {"opticalDomain": {"sample": groups}}}
    explicit = optical_material(world, "sample", 500e-9)
    assert explicit.refractive_index == complex(1.6, -0.7)
    assert explicit.absorption_coefficient == 2000
    assert explicit.scattering_coefficient == 0
    del groups["absorption"]
    assert optical_material(world, "sample", 500e-9).absorption_coefficient == pytest.approx(4 * math.pi * 0.7 / 500e-9)


def test_sampled_ray_models_interpolate_and_clamp_and_reject_incomplete_terms(definitions):
    parameters = {"samples": [
        {"frequency": {"value": 100, "unit": "THz"}, "n": {"value": 1, "unit": "1"}, "k": {"value": 0, "unit": "1"}},
        {"frequency": {"value": 200, "unit": "THz"}, "n": {"value": 3, "unit": "1"}, "k": {"value": 2, "unit": "1"}},
    ]}
    source = {"materials": {"sample": {"models": {"optical": {
        "model": "optics.frequency-sampled-complex-index@1", "parameters": parameters,
    }}}}}
    snapshot = normalize_material_snapshot(source, definitions, "materials")
    world = {"materials": {"experiment": snapshot}, "materialSelections": {
        "opticalDomain": {"sample": {"opticalResponse": "optical"}},
    }}
    for frequency, expected in [(50e12, 1 + 0j), (150e12, 2 - 1j), (250e12, 3 - 2j)]:
        assert optical_material(world, "sample", VACUUM_LIGHT_SPEED / frequency).refractive_index == pytest.approx(expected)
    del parameters["samples"][1]["k"]
    with pytest.raises(CaeError, match=r"samples\[1\].k"):
        normalize_material_snapshot(source, definitions, "materials")
