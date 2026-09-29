import unittest
import sqlite3
import tempfile
from pathlib import Path
from caemble_catalog import open_catalog
from caemble_catalog.source_bundle import validate_experiment_source_bundle
from caemble_catalog.admin import create_draft, insert_experiment, publish_draft
from caemble_catalog.errors import CatalogError


class ExperimentSourcePathTests(unittest.TestCase):
    def test_allowed_paths(self):
        validate_experiment_source_bundle({"files": {name: "" for name in ["experiment.tsx", "geometry.tsx", "material.tsx", "simulate.py", "tasks/Trace_2-a.tsx"]}})

    def test_forbidden_paths_and_catalog_insertion(self):
        for path in ["object.ts", "sensor.ts", "unused.tsx", "lib/profile.ts", "tasks/nested/trace.tsx", "tasks/1trace.tsx", "tasks/trace.ts", "tasks/trace.tsx\n", "../experiment.tsx", "/experiment.tsx", "Experiment.tsx", "extra.py", "notes.json"]:
            with self.subTest(path=path):
                bundle = {"files": {path: ""}}
                with self.assertRaisesRegex(ValueError, "Allowed: experiment.tsx"):
                    validate_experiment_source_bundle(bundle)
                with self.assertRaisesRegex(CatalogError, "Allowed: experiment.tsx"):
                    insert_experiment(None, {"sourceBundle": bundle})

    def test_case_collision(self):
        with self.assertRaisesRegex(ValueError, "case"):
            validate_experiment_source_bundle({"files": {"tasks/Trace.tsx": "", "tasks/trace.tsx": ""}})

    def test_publish_rejects_a_directly_modified_draft(self):
        with tempfile.TemporaryDirectory() as directory:
            draft = Path(directory) / "draft.sqlite3"
            target = Path(directory) / "published.sqlite3"
            create_draft(draft, Path(__file__).resolve().parents[1] / "caemble_catalog/catalog.sqlite3")
            with sqlite3.connect(draft) as db:
                experiment_id = db.execute("SELECT id FROM experiments ORDER BY id LIMIT 1").fetchone()[0]
                db.execute("INSERT INTO experiment_files (experiment_id, ordinal, path, source) VALUES (?, 1000, 'object.ts', '')", (experiment_id,))
            db.close()
            with self.assertRaisesRegex(CatalogError, "Allowed: experiment.tsx"):
                publish_draft(draft, target)
            self.assertFalse(target.exists())

    def test_canonical_examples_conform(self):
        with open_catalog() as catalog:
            examples, total = catalog.list_experiments(limit=10000)
            self.assertEqual(len(examples), total)
            for example in examples:
                with self.subTest(coordinate=example["coordinate"]):
                    validate_experiment_source_bundle(catalog.experiment(example["coordinate"])["sourceBundle"])
