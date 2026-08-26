from __future__ import annotations

import sqlite3
import unittest

from caemble_catalog import open_catalog
from caemble_catalog.cli import build_parser
from caemble_catalog.schema import APPLICATION_ID, SCHEMA_VERSION, create_schema


class CatalogV2Tests(unittest.TestCase):
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

        self.assertTrue(all(item["abiVersion"] >= 1 for item in manifests))
        self.assertIn("caemble.dc/joule-heating@1", {item["name"] for item in artifact_types})
        joule = next(item for item in artifact_types if item["name"] == "caemble.dc/joule-heating@1")
        self.assertEqual(joule["payloadKind"], "field")
        self.assertEqual(joule["data"]["quantityKind"], "PowerDensity")

    def test_new_solver_cli_defaults_to_abi_v2(self) -> None:
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
        self.assertEqual(arguments.implementation_abi, 2)


if __name__ == "__main__":
    unittest.main()
