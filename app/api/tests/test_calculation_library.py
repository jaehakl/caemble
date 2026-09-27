from __future__ import annotations

import asyncio
import json
import hashlib
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from sqlalchemy import create_engine, text
from sqlalchemy.orm import configure_mappers
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
import main  # noqa: E402, F401
from caemble_catalog import Catalog  # noqa: E402
from calculation_library_models import LibraryQuery, LibraryReference  # noqa: E402
from models import UserData, RoleEnum  # noqa: E402
from service.calculation_library import list_library, library_detail  # noqa: E402


OWNER = "00000000-0000-0000-0000-000000000001"
OTHER = "00000000-0000-0000-0000-000000000002"


class CalculationLibraryTests(unittest.TestCase):
    def setUp(self):
        configure_mappers()
        self.catalog = Catalog.open_readonly()
        self.engine = create_engine("sqlite://")
        self.connection = self.engine.connect()
        for statement in [
            "CREATE TABLE experiments (id INTEGER, user_id TEXT, name TEXT, namespace TEXT, repository_slug TEXT, experiment_key TEXT, version_major INTEGER, version_minor INTEGER, version_patch INTEGER, result_contracts JSON)",
            "CREATE TABLE calculations (id INTEGER, experiment_id INTEGER, name TEXT, description TEXT, source_id INTEGER, output_layout JSON, contract_status TEXT, preflight_measurement_id INTEGER)",
            "CREATE TABLE calculation_sources (id INTEGER, source_code TEXT, source_hash TEXT, name TEXT, description TEXT, revision INTEGER, input_contract JSON, output_contract JSON)",
            "CREATE TABLE experiment_demos (experiment_id INTEGER)",
            "CREATE TABLE experiment_records (id INTEGER, experiment_id INTEGER, name TEXT, dtype TEXT, tensor_order INTEGER, quantity_kind TEXT, data_schema JSON)",
            "CREATE TABLE calculation_experiment_records (calculation_id INTEGER, experiment_record_id INTEGER)",
        ]:
            self.connection.execute(text(statement))
        for identifier, owner, name, kind in [(1, OWNER, "Owned", "OwnedQuantity"), (2, OTHER, "Hidden", "SecretQuantity"), (3, OTHER, "Public", "PublicQuantity")]:
            self.connection.execute(text("INSERT INTO experiments VALUES (:id, :owner, :name, 'tests', 'library', :name, 1, 0, 0, :contracts)"),
                                    {"id": identifier, "owner": owner.replace("-", ""), "name": name,
                                     "contracts": '{"field": {"solver": {"name": "' + name + '", "version": "1.0.0"}}}'})
            self.connection.execute(text("INSERT INTO calculation_sources VALUES (:id, :source, :name, :name, 'description', 1, :input, NULL)"),
                                    {"id": identifier, "name": name, "input": json.dumps({"field": {"dtype": "float64", "shape": [None]*7, "quantityKind": kind}}), "source": "export default function calculate(records) { return {dtype: 'float64', data: records.field.data[0]}; }"})
            self.connection.execute(text("INSERT INTO calculations VALUES (:id, :id, :name, 'description', :id, :layout, 'ready', 12)"),
                                    {"id": identifier, "name": name, "input": json.dumps({"field": {"dtype": "float64", "shape": [None]*7, "quantityKind": kind}}), "source": "export default function calculate(records) { return {dtype: 'float64', data: records.field.data[0]}; }",
                                     "layout": '{"dtype":"float64","shape":[],"axes":[]}'})
            self.connection.execute(text("INSERT INTO experiment_records VALUES (:id, :id, 'field', 'float64', 0, :kind, :schema)"),
                                    {"id": identifier, "kind": kind, "schema": '{"axes": [{"name": "x", "length": 4}], "unit": "K"}'})
            self.connection.execute(text("INSERT INTO calculation_experiment_records VALUES (:id, :id)"), {"id": identifier})
        self.connection.execute(text("INSERT INTO experiment_demos VALUES (3)"))
        self.session = AsyncMock()
        self.session.execute.side_effect = self.connection.execute
        self.session.scalar.side_effect = self.connection.scalar
        self.session.get.side_effect = lambda model, identifier: SimpleNamespace(id=identifier, user_id=OWNER if identifier == 1 else OTHER)
        self.user = UserData(id=OWNER, roles=[RoleEnum.user])

    def tearDown(self):
        self.connection.close()
        self.engine.dispose()
        self.catalog.close()

    def list(self, user=None, **query):
        return asyncio.run(list_library(self.session, self.catalog, LibraryQuery(**query), user))

    def test_sources_facets_and_pagination_do_not_leak_private_rows(self):
        guest = self.list()
        self.assertTrue(any(item.sources == ["catalog"] for item in guest.items))
        self.assertNotIn("SecretQuantity", guest.facets.quantity_kinds)
        self.assertEqual(guest.facets.quantity_kinds, ["PublicQuantity"])
        self.assertNotIn("Hidden", [solver.name for solver in guest.facets.solvers])
        mine = self.list(self.user, source="mine")
        self.assertEqual([item.name for item in mine.items], ["Owned"])
        self.assertEqual(mine.items[0].sources, ["mine"])
        self.assertEqual(mine.facets.quantity_kinds, ["OwnedQuantity"])
        self.assertNotIn("source_code", mine.items[0].model_dump())
        combined = self.list(self.user, source="all", query="tests/library", unclassified=True, limit=1)
        next_page = self.list(self.user, source="all", query="tests/library", unclassified=True, limit=1, offset=1)
        self.assertEqual(combined.total, 2)
        self.assertNotEqual(combined.items[0].reference, next_page.items[0].reference)
        self.assertEqual(self.list(self.user, query="Hidden").total, 0)
        self.assertEqual(self.list(self.user, solver_name="Owned", solver_version="1.0.0").total, 1)
        self.assertEqual(self.list(self.user, solver_name="Owned", solver_version="2.0.0").total, 0)
        self.assertEqual(self.list(self.user, quantity_kind="OwnedQuantity").total, 1)
        with self.assertRaises(HTTPException) as error:
            self.list(source="mine")
        self.assertEqual(error.exception.status_code, 401)

    def test_detail_rechecks_permission_and_preserves_ready_contract(self):
        ref = LibraryReference(kind="saved", calculation_id=2)
        with self.assertRaises(HTTPException) as error:
            asyncio.run(library_detail(self.session, self.catalog, ref, self.user))
        self.assertEqual(error.exception.status_code, 404)
        public_ref = LibraryReference(kind="saved", calculation_id=3)
        detail = asyncio.run(library_detail(self.session, self.catalog, public_ref, None))
        self.assertEqual(detail.sources, ["demo"])
        self.assertIsNone(detail.output_layout)
        self.assertEqual(detail.input_contract["field"]["quantityKind"], "PublicQuantity")
        self.assertFalse(detail.inputs_verified)
        # Removing public visibility must revoke a previously selected detail.
        self.connection.execute(text("DELETE FROM experiment_demos"))
        with self.assertRaises(HTTPException):
            asyncio.run(library_detail(self.session, self.catalog, public_ref, None))

    def test_stale_contract_is_not_presented_as_verified_output(self):
        self.connection.execute(text("UPDATE calculations SET contract_status = 'needs_preflight' WHERE id = 1"))
        detail = asyncio.run(library_detail(self.session, self.catalog, LibraryReference(kind="saved", calculation_id=1), self.user))
        self.assertIsNone(detail.output_layout)
        self.assertIsNone(detail.preflight_measurement_id)
        self.assertFalse(detail.inputs_verified)
        self.assertEqual(detail.inputs, [])

    def test_catalog_sources_and_concepts_use_canonical_database(self):
        page = self.list(source="catalog", limit=100)
        self.assertGreater(page.total, 0)
        item = page.items[0]
        detail = asyncio.run(library_detail(self.session, self.catalog, item.reference, None))
        self.assertIn("export default", detail.source_code)
        self.assertIsNone(detail.output_layout)
        self.assertEqual(detail.inputs, [])
        self.assertFalse(detail.inputs_verified)
        self.assertEqual(self.list(source="catalog", query=item.experiment_coordinate).items[0].experiment_coordinate, item.experiment_coordinate)
        concept = page.facets.concepts[0]
        self.assertTrue(all(concept in row.concepts for row in self.list(source="catalog", concept=concept).items))
        self.session.execute.assert_not_awaited()

    def test_shared_definitions_are_grouped_before_pagination_and_recheck_visibility(self):
        self.connection.execute(text("UPDATE calculations SET source_id=1 WHERE id=3"))
        page = self.list(self.user, query="tests/library", limit=1)
        self.assertEqual(page.total, 1)
        self.assertEqual(set(page.items[0].sources), {"mine", "demo"})
        self.assertEqual(page.items[0].reference.source_id, 1)
        self.assertEqual(self.list(self.user, query="tests/library", offset=1).items, [])
        with self.assertRaises(HTTPException) as error:
            asyncio.run(library_detail(self.session, self.catalog, LibraryReference(kind="source", source_id=2), self.user))
        self.assertEqual(error.exception.status_code, 404)

    def test_catalog_and_saved_exact_code_share_one_item(self):
        item = self.list(source="catalog", limit=100).items[0]
        code = self.catalog.calculation_source(item.reference.coordinate, item.reference.name)
        self.connection.execute(text("UPDATE calculation_sources SET source_code=:code, source_hash=:hash WHERE id=1"),
                                {"code": code, "hash": hashlib.sha256(code.encode("utf-8")).hexdigest()})
        rows = [row for row in self.list(self.user, limit=100).items if row.source_hash == item.source_hash]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].name, "Owned")
        self.assertEqual(set(rows[0].sources), {"catalog", "mine"})
