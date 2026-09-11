from __future__ import annotations

import contextlib
import copy
import io
import tempfile
import unittest
from pathlib import Path

from caemble_catalog import open_catalog
from caemble_catalog.cli import main
from caemble_catalog.database import catalog_path
from caemble_catalog.model_schema import validate_model_parameters, validate_parameter_schema


class MaterialModelTests(unittest.TestCase):
    def test_runtime_slice_expands_model_and_nested_quantity_dependencies(self):
        with open_catalog() as catalog:
            result = catalog.runtime_slice(
                solvers=[("ray-tracing", "1.0.0")], quantity_kinds=[],
                material_models=["heat.fourier-conduction@1"],
            )
            names = {model["key"] for model in result["materialModels"]}
            self.assertEqual(len(names), 7)
            self.assertIn("optics.frequency-sampled-complex-index@1", names)
            self.assertIn("heat.fourier-conduction@1", names)
            self.assertIn("Frequency", {quantity["name"] for quantity in result["quantityKinds"]})
            self.assertEqual(len(result["warnings"]), 1)
            self.assertIn("heat.fourier-conduction@1", result["warnings"][0])
            relations = catalog.quantity_kind_relations("Frequency")
            self.assertTrue(any(item["path"] == "parameters.samples[].frequency" for item in relations["materialModels"]))
            self.assertNotIn("materialParameters", result)
            self.assertNotIn("materialGlobalQualifiers", result)
            detail = catalog.material_model_relations("optics.constant-complex-index@1")
            self.assertEqual(detail["solverRequirements"][0]["groupKey"], "opticalResponse")

    def test_published_examples_use_explicit_models_and_current_versions(self):
        with open_catalog() as catalog:
            for summary in catalog.list_experiments(limit=100)[0]:
                source = catalog.experiment(summary["coordinate"])["sourceBundle"]["files"]["material.tsx"]
                self.assertNotIn("'reference'", source)
                self.assertNotIn("errorRate", source)
                if "new Material" in source:
                    self.assertIn("models:", source)
            tables = {row[0] for row in catalog._all("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertNotIn("material_parameters", tables)
            self.assertNotIn("solver_material_properties", tables)
            fdtd = catalog.get_solver_manifest("fdtd", "3.0.0")["descriptor"]
            overlay = next(role for role in fdtd["materials"] if role["role"] == "geometryOverlay")
            self.assertEqual(overlay["target"], {"category": "geometry", "source": "experiment"})

    def test_draft_cli_group_options_are_transactional(self):
        with tempfile.TemporaryDirectory() as directory:
            draft = Path(directory) / "draft.sqlite3"
            def run(*args):
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    return main(["--database", str(draft), *args])
            self.assertEqual(run("draft", "create", "--source", str(catalog_path())), 0)
            identity = ("ray-tracing", "1.0.0", "opticalDomain", "opticalResponse")
            self.assertEqual(run("solver", "material-model-option", "remove", *identity, "optics.frequency-sampled-complex-index@1"), 0)
            self.assertEqual(run("solver", "material-model-option", "upsert", *identity, "missing.model@1"), 1)
            self.assertEqual(run("solver", "material-model-option", "remove", *identity, "optics.constant-complex-index@1"), 1)
            with open_catalog(draft) as catalog:
                group = catalog.get_solver_manifest("ray-tracing", "1.0.0")["descriptor"]["materials"][0]["modelGroups"][0]
                self.assertEqual(group["oneOf"], ["optics.constant-complex-index@1"])
            self.assertEqual(run("solver", "material-model-option", "upsert", *identity, "optics.frequency-sampled-complex-index@1"), 0)
            self.assertEqual(run("query", "material-model", "optics.constant-complex-index@1"), 0)

    def test_optional_objects_and_variable_complete_term_sets(self):
        numeric = {"kind": "value", "dtype": "float64", "shape": []}
        pair = {"kind": "object", "required": ["a", "b"], "fields": {"a": numeric, "b": numeric}}
        definition = {"parameterSchema": {"kind": "object", "fields": {
            "offset": numeric, "optionalPair": pair,
            "terms": {"kind": "list", "items": pair, "minimumLength": 1},
        }, "required": ["offset"]}}
        validate_parameter_schema(definition["parameterSchema"])
        validate_model_parameters(definition, {"offset": 1})
        validate_model_parameters(definition, {"offset": 1, "optionalPair": {"a": 2, "b": 3}, "terms": [{"a": 4, "b": 5}, {"a": 6, "b": 7}]})
        with self.assertRaisesRegex(ValueError, r"parameters.optionalPair.b is required"):
            validate_model_parameters(definition, {"offset": 1, "optionalPair": {"a": 2}})
        with self.assertRaisesRegex(ValueError, r"parameters.terms\[1\].b is required"):
            validate_model_parameters(definition, {"offset": 1, "terms": [{"a": 1, "b": 2}, {"a": 3}]})
        with self.assertRaisesRegex(ValueError, "not declared"):
            validate_model_parameters(definition, {"offset": 1, "typo": 0})

    def test_quantities_require_canonical_unit_shape_and_finite_values(self):
        with open_catalog() as catalog:
            definition = catalog.material_model("electrical.ohmic-conduction@1")
        parameters = {"sigma": {"dtype": "float32", "value": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "unit": "S.m-1"}}
        validate_model_parameters(definition, parameters)
        for change in ({"value": 1}, {"unit": "S/cm"}, {"quantityKind": "electromagnetism.ElectricConductivity"}, {"dtype": []}, {"basis": [[0, 1, 0], [1, 0, 0], [0, 0, 1]]}, {"value": [[float("nan"), 0, 0], [0, 1, 0], [0, 0, 1]]}):
            invalid = copy.deepcopy(parameters)
            invalid["sigma"].update(change)
            with self.assertRaises(ValueError):
                validate_model_parameters(definition, invalid)

    def test_malformed_schema_and_large_values_report_validation_errors(self):
        for fields in ({"dtype": []}, {"description": []}, {"omission": 1}, {"minimum": 10**400}, {"exclusiveMinimum": "true", "minimum": 0}, {"quantityKind": [], "unit": "Hz"}, {"quantityKind": "Frequency", "unit": "Hz", "dtype": "int32"}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                validate_parameter_schema({"kind": "value", **fields})
        for increasing in ([], "missing", "optional"):
            with self.subTest(increasing=increasing), self.assertRaises(ValueError):
                validate_parameter_schema({"kind": "list", "increasingBy": increasing, "items": {"kind": "object", "fields": {"optional": {"kind": "value"}}}})
        with self.assertRaisesRegex(ValueError, "finite numeric"):
            validate_model_parameters({"parameterSchema": {"kind": "value"}}, 10**400)

    def test_omitted_quantity_dtype_defaults_to_float64_independently_of_schema_dtype(self):
        definition = {"parameterSchema": {"kind": "value", "dtype": "float32", "quantityKind": "Frequency", "unit": "Hz"}}
        validate_parameter_schema(definition["parameterSchema"])
        validate_model_parameters(definition, {"value": 1e100, "unit": "Hz"})
        with self.assertRaisesRegex(ValueError, "float32 range"):
            validate_model_parameters(definition, {"dtype": "float32", "value": 1e100, "unit": "Hz"})
        with self.assertRaisesRegex(ValueError, "float32 range"):
            validate_model_parameters({"parameterSchema": {"kind": "value", "dtype": "float32"}}, 1e100)

    def test_sampled_model_requires_complete_increasing_samples(self):
        with open_catalog() as catalog:
            definition = catalog.material_model("optics.frequency-sampled-complex-index@1")
        samples = [{"frequency": {"value": f, "unit": "Hz"}, "n": {"value": 1.5, "unit": "{fraction}"}, "k": {"value": 0, "unit": "1"}} for f in (1e14, 2e14)]
        validate_model_parameters(definition, {"samples": samples})
        with self.assertRaisesRegex(ValueError, "strictly increasing"):
            validate_model_parameters(definition, {"samples": list(reversed(samples))})
        del samples[1]["k"]
        with self.assertRaisesRegex(ValueError, r"parameters.samples\[1\].k is required"):
            validate_model_parameters(definition, {"samples": samples})


if __name__ == "__main__":
    unittest.main()
