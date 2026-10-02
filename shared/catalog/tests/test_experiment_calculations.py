from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from caemble_catalog import open_catalog
from caemble_catalog.admin import create_draft, publish_draft, rebase_database
from caemble_catalog.cli import main
from caemble_catalog.database import Catalog


class ExperimentCalculationTests(unittest.TestCase):
    def test_registration_roundtrip_preservation_validation_and_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            draft = root / "draft.sqlite3"
            with open_catalog() as catalog:
                example = catalog.experiment(catalog.list_experiments(limit=1)[0][0]["coordinate"])
            published = Path(__file__).resolve().parents[1] / "caemble_catalog/catalog.sqlite3"
            create_draft(draft, published)
            bundle = root / "bundle.json"
            definitions = root / "calculations.json"
            bundle.write_text(json.dumps(example["sourceBundle"]), encoding="utf-8")
            calculations = [
                {"name": "평균", "description": "예제", "source_code": "export default () => 1"},
                {"name": "Second", "description": None, "source_code": "export default () => 2"},
            ]
            definitions.write_text(json.dumps(calculations, ensure_ascii=False), encoding="utf-8")
            args = ["--database", str(draft), "experiment", "upsert", example["key"],
                    "--namespace", example["namespace"], "--repository", example["repository"],
                    "--version", example["version"], "--title", example["title"],
                    "--description", example["description"], "--bundle-file", str(bundle)]
            for solver in example["relatedSolvers"]:
                args.extend(["--solver", f"{solver['name']}@{solver['version']}"])
            self.assertEqual(main([*args, "--calculations-file", str(definitions)]), 0)
            self.assertEqual(main(args), 0)
            rebase_database(draft)
            with Catalog.open_readonly(draft, immutable=False) as catalog:
                self.assertEqual(catalog.experiment(example["coordinate"])["calculations"], calculations)
                revision = catalog.meta()["catalogRevision"]
            for malformed in ([calculations[0], {**calculations[0], "name": " 평균 "}],
                              [{"name": "Empty", "source_code": "  "}], {"name": "not a list"}):
                definitions.write_text(json.dumps(malformed), encoding="utf-8")
                self.assertEqual(main([*args, "--calculations-file", str(definitions)]), 1)
                with Catalog.open_readonly(draft, immutable=False) as catalog:
                    self.assertEqual(catalog.experiment(example["coordinate"])["calculations"], calculations)
                    self.assertEqual(catalog.meta()["catalogRevision"], revision)
            target = root / "published.sqlite3"
            publish_draft(draft, target)
            with Catalog.open_readonly(target) as catalog:
                self.assertEqual(catalog.experiment(example["coordinate"])["calculations"], calculations)
            definitions.write_text("[]", encoding="utf-8")
            self.assertEqual(main([*args, "--calculations-file", str(definitions)]), 0)
            with Catalog.open_readonly(draft, immutable=False) as catalog:
                self.assertEqual(catalog.experiment(example["coordinate"])["calculations"], [])
                self.assertNotEqual(catalog.meta()["catalogRevision"], revision)

    def test_rebase_old_catalog_keeps_examples_with_empty_calculations(self):
        with tempfile.TemporaryDirectory() as directory:
            draft = Path(directory) / "old.sqlite3"
            create_draft(draft, Path(__file__).resolve().parents[1] / "caemble_catalog/catalog.sqlite3")
            with sqlite3.connect(draft) as connection:
                connection.execute("DROP TABLE experiment_calculations")
                connection.execute("PRAGMA user_version = 3")
                count = connection.execute("SELECT count(*) FROM experiments").fetchone()[0]
            connection.close()
            rebase_database(draft)
            with Catalog.open_readonly(draft, immutable=False) as catalog:
                examples, total = catalog.list_experiments(limit=100)
                self.assertEqual(total, count)
                for example in examples:
                    self.assertEqual(catalog.experiment(example["coordinate"])["calculations"], [])
