"""Public API and PostgreSQL definitions captured before the package refactor.

This checks declarations only. It never enters the application lifespan or opens
a database connection. Intentional public contract changes update this fixture
alongside their caller and migration changes.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest

from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateIndex, CreateTable

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from bootstrap import create_app
from db import Base
from model_registry import register_models


class ApiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.expected = json.loads((Path(__file__).parent / "fixtures" / "api_contract.json").read_text(encoding="utf-8"))
        cls.app = create_app()
        cls.openapi = cls.app.openapi()
        register_models()

    def test_http_and_websocket_routes_keep_paths_methods_and_names(self) -> None:
        routes = [[route.path, sorted(getattr(route, "methods", None) or []), route.name] for route in self.app.routes]
        self.assertEqual(sorted(self.expected["routes"]), sorted(routes))

    def test_openapi_operations_preserve_the_wire_contract(self) -> None:
        expected = self.expected["openapi"]["paths"]
        self.assertEqual(set(expected), set(self.openapi["paths"]))
        for path, operations in expected.items():
            with self.subTest(path=path):
                self.assertEqual(operations, self.openapi["paths"][path])

    def test_openapi_schema_names_and_fields_are_stable(self) -> None:
        expected = self.expected["openapi"]["components"]
        actual = self.openapi["components"]
        self.assertEqual(set(expected), set(actual))
        for category, definitions in expected.items():
            self.assertEqual(set(definitions), set(actual[category]))
            for name, definition in definitions.items():
                with self.subTest(category=category, name=name):
                    self.assertEqual(definition, actual[category][name])

    def test_orm_tables_and_indexes_do_not_require_a_migration(self) -> None:
        dialect = postgresql.dialect()
        self.assertEqual(set(self.expected["tables"]), set(Base.metadata.tables))
        for name, expected in self.expected["tables"].items():
            with self.subTest(table=name):
                self.assertEqual(expected, str(CreateTable(Base.metadata.tables[name]).compile(dialect=dialect)))
        indexes = sorted(str(CreateIndex(index).compile(dialect=dialect)) for table in Base.metadata.tables.values() for index in table.indexes)
        self.assertEqual(self.expected["indexes"], indexes)


if __name__ == "__main__":
    unittest.main()
