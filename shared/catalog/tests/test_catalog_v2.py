from __future__ import annotations

import sqlite3
import unittest

from caemble_catalog import CatalogNotFoundError, open_catalog
from caemble_catalog.admin import insert_solver_manifest
from caemble_catalog.cli import build_parser
from caemble_catalog.schema import APPLICATION_ID, SCHEMA_VERSION, create_schema


class CatalogV3Tests(unittest.TestCase):
    def test_schema_supports_versioned_solvers_and_canonical_artifacts(self) -> None:
        connection = sqlite3.connect(":memory:")
        create_schema(connection)
        connection.executemany(
            """INSERT INTO solvers(
                   name, version, implementation, implementation_abi, description,
                   reference_length_unit, minimum_outputs
               ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [
                ("example", "1.0.0", "one:implementation", 1, "first", "m", 0),
                ("example", "2.0.0", "two:implementation", 2, "second", "m", 0),
            ],
        )
        connection.execute(
            "INSERT INTO artifact_types VALUES (?, ?, ?)",
            ("example/field@1", "field", '{"dtype":"float64"}'),
        )

        self.assertEqual(connection.execute("PRAGMA application_id").fetchone()[0], APPLICATION_ID)
        self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
        self.assertEqual(connection.execute("SELECT count(*) FROM solvers").fetchone()[0], 2)

    def test_published_catalog_exposes_abi_and_artifact_contracts(self) -> None:
        with open_catalog() as catalog:
            manifests = catalog.solver_manifests()
            artifact_types = catalog.artifact_types()

        self.assertTrue(all(item["abiVersion"] == 3 for item in manifests))
        self.assertIn("caemble.dc/joule-heating@2", {item["name"] for item in artifact_types})
        joule = next(item for item in artifact_types if item["name"] == "caemble.dc/joule-heating@2")
        self.assertEqual(joule["payloadKind"], "field")
        self.assertEqual(joule["data"]["quantityKind"], "PowerDensity")

    def test_published_catalog_contains_curated_electro_thermal_notched_example(self) -> None:
        removed_keys = {
            "basketball-goal",
            "geometry-authoring-skeleton",
            "dc-resolution-study",
            "dc-uniform-bar",
            "dc-notched-current-density",
            "electro-thermal-uniform-bar",
            "nrel5mw-oc3-operating",
            "hyperelastic-tension",
            "hyperelastic-compression",
            "sph-periodic-channel",
        }
        with open_catalog() as catalog:
            experiments, total = catalog.list_experiments(limit=100)
            example = catalog.experiment(
                "electro-thermal-notched-bar",
                namespace="caemble",
                repository="verified",
                version="6.0.2",
            )

        self.assertEqual(total, len(experiments))
        self.assertTrue({"dem-floor-contact", "sph-hydrostatic-column", "mpm-affine-compression"}.issubset(
            {item["key"] for item in experiments}))
        self.assertTrue(removed_keys.isdisjoint(item["key"] for item in experiments))
        self.assertEqual(example["title"], "Electro-Thermal Notched Bar")
        self.assertEqual(
            [(item["name"], item["version"]) for item in example["relatedSolvers"]],
            [("dc-current-density", "3.1.0"), ("heat-transfer", "2.0.0")],
        )
        self.assertEqual(
            set(example["sourceBundle"]["files"]),
            {
                "experiment.tsx",
                "geometry.tsx",
                "material.tsx",
                "simulate.py",
                "tasks/electric.tsx",
                "tasks/thermal.tsx",
            },
        )
        experiment_source = example["sourceBundle"]["files"]["experiment.tsx"]
        simulation_source = example["sourceBundle"]["files"]["simulate.py"]
        electric_source = example["sourceBundle"]["files"]["tasks/electric.tsx"]
        thermal_source = example["sourceBundle"]["files"]["tasks/thermal.tsx"]
        self.assertTrue(
            all(
                key in experiment_source
                for key in ("currentDensity", "totalCurrent", "temperature", "maximumTemperature")
            )
        )
        self.assertIn("methodId: 'dc.joule-heating'", electric_source)
        self.assertIn("methodId: 'dc.mesh'", electric_source)
        self.assertIn("methodId: 'heat.mesh'", thermal_source)
        self.assertNotIn("voxel-grid", electric_source + thermal_source)
        self.assertIn('inputs={"heatSource": electric["artifacts"]["jouleHeating"]}', simulation_source)
        self.assertIn('sim.release(electric["artifacts"]["jouleHeating"])', simulation_source)

    def test_spectrometer_has_current_grating_solver_and_complete_bundle(self) -> None:
        with open_catalog() as catalog:
            example = catalog.experiment('caemble:experiment/caemble/verified/czerny-turner-spectrometer@7.0.4')
            solver = catalog.get_solver_manifest('ray-tracing', '5.1.0')
        self.assertEqual(example['title'], 'Czerny–Turner Spectrometer')
        self.assertEqual([(s['name'], s['version']) for s in example['relatedSolvers']], [('ray-tracing', '5.1.0')])
        self.assertEqual(set(example['sourceBundle']['files']), {
            'experiment.tsx', 'geometry.tsx', 'material.tsx', 'simulate.py', 'tasks/trace.tsx',
        })
        self.assertEqual(solver['abiVersion'], 3)
        self.assertEqual(solver['implementation'], 'app.solvers.ray_tracing.entry:implementation')
        method = next(m for m in solver['descriptor']['methods']['boundaryConditions'] if m['methodId'] == 'ray.diffraction-grating')
        self.assertEqual(set(method['parameters']), {'spacing', 'grooveDirection', 'orders', 'reflectedEfficiencies', 'transmittedEfficiencies'})
        self.assertNotIn('ray.reflection-grating', {m['methodId'] for m in solver['descriptor']['methods']['boundaryConditions']})

    def test_release_has_only_current_solvers_and_examples(self) -> None:
        expected = {
            "dc-current-density": "3.1.0", "heat-transfer": "2.0.0",
            "ray-tracing": "5.1.0", "fdtd": "5.0.0",
            "structural-mechanics": "8.0.0", "pressure-acoustics": "1.1.0",
            "rigid_body": "2.0.0",
            "dem": "1.0.0", "sph": "1.1.0", "mpm": "2.0.0",
            "incompressible-flow": "3.0.0",
        }
        with open_catalog() as catalog:
            with self.assertRaises(CatalogNotFoundError):
                catalog.get_solver_manifest('ray-tracing', '4.1.0')
            with self.assertRaises(CatalogNotFoundError):
                catalog.get_solver_manifest('ray-tracing', '4.1.1')
            manifests = catalog.solver_manifests()
            self.assertEqual(len(manifests), len(expected))
            self.assertEqual({m["descriptor"]["name"]: m["descriptor"]["version"] for m in manifests}, expected)
            for manifest in manifests:
                package = manifest["descriptor"]["name"].replace("-", "_")
                self.assertEqual(manifest["implementation"], f"app.solvers.{package}.entry:implementation")
            for name, version in [("structural-mechanics", "7.1.0"), ("structural-mechanics", "6.0.0"), ("structural-mechanics", "6.1.0"), ("structural-mechanics", "7.0.0"), ("mpm", "1.0.0"), ("pressure-acoustics", "1.0.0"), ("sph", "1.0.0"), ("incompressible-flow", "1.0.0"), ("incompressible-flow", "2.0.0")]:
                with self.assertRaises(CatalogNotFoundError):
                    catalog.get_solver_manifest(name, version)
            for name, version in [("dc-current-density", "3.0.0"), ("heat-transfer", "1.0.0"), ("structural-mechanics", "7.2.0"), ("dc-current-density", "2.0.0"), ("steady-state-heat", "2.0.0"), ("dc-current-density", "0.4.0"), ("steady-state-heat", "0.3.0"), ("ray-tracing", "0.4.0"), ("fdtd", "1.0.1"), ("fdtd", "2.0.0"), ("structural-mechanics", "1.0.0"), ("structural-mechanics", "5.0.0"), ("aerodynamic-loading", "1.0.0"), ("hydrodynamic-loading", "1.0.0"), ("wind-turbine-control", "1.0.0")]:
                with self.assertRaises(CatalogNotFoundError):
                    catalog.get_solver_manifest(name, version)
            for example in catalog.list_experiments(limit=100)[0]:
                expected_version = "1.0.0" if example["key"] == "hyperelastic-uniaxial" else "7.1.2" if example["repository"] == "fea" else {
                    "layered-cutaways": "6.0.0", "random-sphere-hcp-array": "7.0.0", "random-curved-edge-cylinder-array": "6.0.0", "folded-ray-tracing": "7.0.4", "czerny-turner-spectrometer": "7.0.4",
                    "continuous-ray-optics": "1.0.4", "pixel-monochromatic-response": "1.0.3", "transmission-grating-response": "1.0.1",
                    "transmission-imaging-spectrometer": "1.0.0",
                    "fiber-bundle": "7.0.0", "electro-thermal-notched-bar": "6.0.2", "steady-microheater": "1.2.0",
                    "feedback-microheater": "1.0.0", "pulsed-microheater": "1.1.0",
                    "fdtd-drude-slab": "6.0.0", "gold-fcc-fresnel": "8.0.0", "structural-optical-results": "6.0.4",
                    "matched-impedance-duct": "1.1.0", "plate-driven-duct": "1.1.4",
                    "transient-matched-impedance-duct": "1.0.0", "transient-plate-driven-duct": "1.1.0",
                    "asymmetric-rigid-bodies": "2.0.0", "sliding-contact": "1.0.0",
                    "dem-floor-contact": "1.0.1", "sph-hydrostatic-column": "1.1.0",
                    "mpm-affine-compression": "2.0.0", "dem-two-material-collision": "1.0.0",
                    "dem-incline-rolling": "1.0.0",
                    "incompressible-stokes-duct": "3.0.0", "incompressible-startup-channel": "2.0.0",
                    "incompressible-boolean-channel": "1.1.0", "incompressible-sph-periodic-channel": "1.1.0",
                }.get(example["key"], "5.0.0")
                self.assertEqual(example["version"], expected_version)
                previous = "3.0.0" if example["repository"] == "fea" else {"asymmetric-rigid-bodies": "1.0.0", "gold-fcc-fresnel": "2.0.0", "fdtd-drude-slab": "3.0.0", "structural-optical-results": "1.0.0"}.get(example["key"], "2.0.0")
                if example["key"] == "mpm-affine-compression":
                    previous = "1.0.1"
                elif example["key"] == "incompressible-stokes-duct":
                    previous = "2.0.0"
                elif example["key"] in {"incompressible-startup-channel", "incompressible-sph-periodic-channel"}:
                    previous = "1.0.0"
                elif example["key"].startswith("sph-"):
                    previous = "1.0.1" if example["key"] == "sph-hydrostatic-column" else "1.0.0"
                with self.assertRaises(CatalogNotFoundError):
                    catalog.experiment(example["coordinate"].rsplit("@", 1)[0] + "@" + previous)
                for solver in example["relatedSolvers"]:
                    self.assertEqual(solver["version"], expected[solver["name"]])

    def test_static_thermal_contract_reuses_native_temperature_and_explicit_reference(self) -> None:
        with open_catalog() as catalog:
            structure = catalog.get_solver_manifest("structural-mechanics", "8.0.0")["descriptor"]
            heat = catalog.get_solver_manifest("heat-transfer", "2.0.0")["descriptor"]
            expansion = catalog.material_model("mechanics.isotropic-thermal-expansion@1")
            microheater = catalog.experiment("steady-microheater")
        port = structure["inputPorts"]["temperature"]
        native = next(method for method in heat["methods"]["exports"] if method["methodId"] == "heat.temperature")
        self.assertEqual(port["artifactTypes"], ["caemble.heat/temperature@3"])
        self.assertEqual(port["data"], native["data"])
        self.assertEqual(port["minimumOccurrences"], 0)
        rule = next(method for method in structure["methods"]["initializations"] if method["methodId"] == "fea.thermal-expansion")
        self.assertEqual(set(rule["parameters"]), {"stressFreeTemperature"})
        self.assertNotIn("default", rule["parameters"]["stressFreeTemperature"])
        self.assertEqual(rule["parameters"]["stressFreeTemperature"]["data"]["unit"], "K")
        self.assertEqual(set(expansion["parameterSchema"]["fields"]), {"alpha"})
        self.assertEqual(expansion["parameterSchema"]["fields"]["alpha"]["shape"], [])
        self.assertEqual(expansion["parameterSchema"]["fields"]["alpha"]["unit"], "K-1")
        self.assertEqual(microheater["version"], "1.2.0")
        self.assertEqual({item["name"] for item in microheater["relatedSolvers"]},
                         {"dc-current-density", "heat-transfer", "structural-mechanics"})
        self.assertIn("tasks/structural.tsx", microheater["sourceBundle"]["files"])

    def test_structural_contract_owns_mesh_and_uses_semantic_boundaries(self) -> None:
        with open_catalog() as catalog:
            descriptor = catalog.get_solver_manifest("structural-mechanics", "8.0.0")["descriptor"]
            penalty = catalog.quantity_kind("mechanics.NormalContactStiffness")
        self.assertEqual(descriptor["parameters"]["spatialResolution"]["data"]["unit"], "m")
        initializations = {method["methodId"]: method for method in descriptor["methods"]["initializations"]}
        boundaries = {method["methodId"]: method for method in descriptor["methods"]["boundaryConditions"]}
        outputs = {method["methodId"]: method for method in descriptor["methods"]["outputs"]}
        self.assertIn("fea.body", initializations)
        self.assertEqual(initializations["fea.body"]["target"]["kind"], "geometry")
        self.assertEqual(initializations["fea.body"]["minimumOccurrences"], 1)
        for method_id in ("fea.fixed", "fea.surface-load", "fea.pressure", "fea.traction", "fea.contact"):
            self.assertEqual(boundaries[method_id]["target"]["kind"], "surface")
        removed_methods = {
            "fea.nodes", "fea.truss2", "fea.beam2", "fea.generalized-beam2", "fea.tri3", "fea.quad4",
            "fea.tet4", "fea.hex8", "fea.shell4", "fea.line-mesh", "fea.plate-mesh", "fea.cylinder-mesh",
            "fea.brick-mesh", "fea.node-set", "fea.face-set",
        }
        self.assertTrue(removed_methods.isdisjoint(initializations))
        internal_parameters = {"nodeId", "nodeIds", "connectivity", "nodeIdStart", "master", "slave", "nodeA", "nodeB", "dofA", "dofB"}
        for methods in descriptor["methods"].values():
            for method in methods:
                self.assertTrue(internal_parameters.isdisjoint(method["parameters"]), method["methodId"])
        self.assertEqual(outputs["fea.stress-field"]["data"]["axes"][-1]["length"], 6)
        self.assertEqual(outputs["fea.velocity-history"]["target"]["kind"], "geometry")
        self.assertEqual(outputs["fea.reaction-moment"]["artifactType"], "caemble.box-grid/structural-mechanics/fea.reaction-moment@1")
        self.assertEqual(outputs["fea.section-force"]["artifactType"], "caemble.box-grid/structural-mechanics/fea.section-force@1")
        self.assertEqual(penalty["tensorOrder"], 0)
        self.assertIn("N.m-3", penalty["applicableUnits"])
        self.assertEqual(boundaries["fea.contact"]["parameters"]["penalty"]["data"]["quantityKind"], penalty["name"])

    def test_electrothermal_clock_materials_and_history_contracts(self) -> None:
        with open_catalog() as catalog:
            dc = catalog.get_solver_manifest("dc-current-density", "3.1.0")["descriptor"]
            heat = catalog.get_solver_manifest("heat-transfer", "2.0.0")["descriptor"]
            structure = catalog.get_solver_manifest("structural-mechanics", "8.0.0")["descriptor"]
            resistivity = catalog.material_model("electrical.linear-resistivity@1")
            capacity = catalog.material_model("heat.constant-heat-capacity@1")
            contact = catalog.material_model("heat.constant-interface-conductance@1")
            pulse = catalog.experiment("pulsed-microheater")
        self.assertEqual(dc["inputPorts"]["temperature"]["data"], structure["inputPorts"]["temperature"]["data"])
        self.assertEqual(dc["inputPorts"]["stepControl"]["data"], heat["inputPorts"]["stepControl"]["data"])
        self.assertEqual(dc["inputPorts"]["stepControl"]["artifactTypes"], ["caemble.heat/step-control@1"])
        self.assertEqual(dc["inputPorts"]["stepControl"]["data"]["members"]["complete"]["dtype"], "bool")
        self.assertEqual(resistivity["parameterSchema"]["fields"]["rhoRef"]["shape"], [3, 3])
        self.assertEqual(resistivity["parameterSchema"]["fields"]["alphaR"]["shape"], [])
        self.assertEqual(set(capacity["parameterSchema"]["fields"]), {"density", "specificHeat"})
        self.assertEqual(contact["subject"], {"kind": "material-pair", "exchange": "symmetric"})
        for descriptor in (dc, heat, structure):
            history = [method for method in descriptor["methods"]["outputs"] if method["methodId"].endswith("-history")]
            self.assertTrue(history)
            for method in history:
                self.assertNotIn("length", method["data"]["axes"][3])
                self.assertEqual(method["data"]["axes"][3]["unit"], "s")
        self.assertEqual(pulse["calculations"], [])

    def test_structural_examples_define_csg_instead_of_task_mesh_arrays(self) -> None:
        with open_catalog() as catalog:
            examples = [item for item in catalog.list_experiments(limit=100)[0] if item["repository"] == "fea"]
            self.assertEqual({item["key"] for item in examples}, {
                "boolean-connection-solid", "curved-tower-shell", "structural-analysis-modes",
                "structural-element-basics", "structural-nonlinear-materials", "hyperelastic-uniaxial",
                "mixed-mini-compression", "mixed-mini-cylinder-inflation",
            })
            for item in examples:
                example = catalog.experiment(item["coordinate"])
                files = example["sourceBundle"]["files"]
                self.assertTrue({"experiment.tsx", "material.tsx", "simulate.py"}.issubset(files))
                tasks = {path: source for path, source in files.items() if path.startswith("tasks/")}
                self.assertTrue(tasks)
                for path, source in tasks.items():
                    self.assertIn("fea.body", source, path)
                    self.assertNotRegex(source, r"\b(?:connectivity|nodeIds|nodeIdStart)\s*:")
                    self.assertLess(len(source.splitlines()), 1000, path)
                self.assertEqual([(solver["name"], solver["version"]) for solver in example["relatedSolvers"]], [("structural-mechanics", "8.0.0")])

    def test_new_solver_cli_defaults_to_abi_v3(self) -> None:
        arguments = build_parser().parse_args(
            [
                "--database",
                "draft.sqlite3",
                "solver",
                "create",
                "example",
                "1.0.0",
                "--implementation",
                "example.entry:implementation",
                "--description",
                "Example",
            ]
        )
        self.assertEqual(arguments.implementation_abi, 3)

    def test_structured_bundle_members_and_metadata_contribute_quantity_kind_usages(self) -> None:
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        create_schema(connection)
        connection.executemany(
            "INSERT INTO quantity_kinds(name, domain, tensor_order, description, opaque) VALUES (?, ?, ?, ?, ?)",
            [
                ("ElectricFieldStrength", "electromagnetism", 1, None, 0),
                ("Time", "general", 0, None, 0),
                ("Length", "general", 0, None, 0),
            ],
        )
        insert_solver_manifest(
            connection,
            {
                "implementation": "app.solvers.example.entry:implementation",
                "abiVersion": 2,
                "descriptor": {
                    "name": "example",
                    "version": "1.0.0",
                    "description": "Example structured bundle solver",
                    "referenceLengthUnit": "m",
                    "minimumOutputs": 1,
                    "parameters": {},
                    "materials": [],
                    "inputPorts": {},
                    "observations": {},
                    "methods": {
                        "initializations": [],
                        "boundaryConditions": [],
                        "outputs": [
                            {
                                "methodId": "example.field-series",
                                "description": "Field time series",
                                "minimumOccurrences": 1,
                                "maximumOccurrences": 1,
                                "target": {
                                    "source": "task",
                                    "kind": "geometry",
                                    "minimumTargets": 1,
                                    "maximumTargets": 1,
                                    "minimumResolved": 1,
                                    "maximumResolved": 1,
                                },
                                "parameters": {},
                                "artifactType": "example/field-series@1",
                                "data": {
                                    "resourceKind": "structuredBundle",
                                    "members": {
                                        "field": {
                                            "dtype": "float32",
                                            "quantityKind": "ElectricFieldStrength",
                                            "unit": "V/m",
                                            "tensorOrder": 1,
                                            "metadata": {
                                                "referencePoint": {
                                                    "dtype": "float64", "shape": [3],
                                                    "quantityKind": "Length", "unit": "m",
                                                },
                                            },
                                            "axes": [
                                                {
                                                    "name": "time",
                                                    "quantityKind": "Time",
                                                    "unit": "s",
                                                },
                                                {
                                                    "name": "x",
                                                    "quantityKind": "Length",
                                                    "unit": "m",
                                                },
                                            ],
                                        }
                                    },
                                },
                            }
                        ],
                    },
                },
            },
        )

        usages = connection.execute(
            """SELECT quantity_kind, context, path, unit
               FROM solver_quantity_kind_usages
               ORDER BY ordinal"""
        ).fetchall()

        self.assertEqual(
            [tuple(row) for row in usages],
            [
                (
                    "ElectricFieldStrength",
                    "output",
                    "methods.outputs.example.field-series.data.members.field",
                    "V/m",
                ),
                (
                    "Time",
                    "axis",
                    "methods.outputs.example.field-series.data.members.field.axes[0]",
                    "s",
                ),
                (
                    "Length",
                    "axis",
                    "methods.outputs.example.field-series.data.members.field.axes[1]",
                    "m",
                ),
                (
                    "Length",
                    "output",
                    "methods.outputs.example.field-series.data.members.field.metadata.referencePoint",
                    "m",
                ),
            ],
        )
        connection.close()


if __name__ == "__main__":
    unittest.main()
