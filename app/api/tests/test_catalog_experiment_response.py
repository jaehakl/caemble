from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from caemble_catalog import open_catalog
from caemble_catalog.admin import create_draft, insert_experiment, refresh_derived_data, writable_connection
from caemble_catalog.database import Catalog, catalog_path
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from catalog_models import ExperimentDetail
from routers.catalog import router


class CatalogExperimentResponseTests(unittest.TestCase):
    def test_http_response_preserves_empty_and_multiple_calculations(self):
        with open_catalog() as catalog:
            example = catalog.experiment(
                "caemble:experiment/caemble/verified/czerny-turner-spectrometer@5.0.0"
            )
        definitions = [
            {"name": "평균", "description": "예제 계산", "source_code": "export default () => ({ dtype: 'float64', data: 1 })"},
            {"name": "Second", "description": None, "source_code": "export default () => ({ dtype: 'float64', data: 2 })"},
        ]
        for calculations in ([], definitions):
            with self.subTest(calculations=calculations), tempfile.TemporaryDirectory() as directory:
                draft = Path(directory) / "catalog.sqlite3"
                create_draft(draft, catalog_path())
                with writable_connection(draft) as connection:
                    insert_experiment(connection, {**example, "key": "http-response-test", "calculations": calculations})
                refresh_derived_data(draft)
                with Catalog.open_readonly(draft) as catalog:
                    app = FastAPI()
                    app.state.catalog = catalog
                    app.include_router(router)
                    with TestClient(app) as client:
                        response = client.get(
                            "/catalog/experiments/http-response-test",
                            params={"namespace": "caemble", "repository": "verified", "version": example["version"]},
                        )
                    self.assertEqual(response.status_code, 200, response.text)
                    payload = response.json()
                    self.assertIn("calculations", payload)
                    self.assertEqual(payload["calculations"], calculations)
                    self.assertEqual(payload["sourceBundle"], example["sourceBundle"])

    def test_calculations_are_required_in_detail_contract(self):
        with open_catalog() as catalog:
            example = catalog.experiment(
                "caemble:experiment/caemble/verified/czerny-turner-spectrometer@5.0.0"
            )
        del example["calculations"]
        with self.assertRaises(ValidationError):
            ExperimentDetail.model_validate(example)
