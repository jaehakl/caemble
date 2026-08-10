import asyncio
import os
import sys
import unittest
from pathlib import Path

from sqlalchemy import select


APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))
os.environ.setdefault("DB_URL", "postgresql://test:test@localhost/test")

from db import Experiment, Geometry, Structure  # noqa: E402
from models import CodeEntityBase, ExperimentBase, GeometryBase, StructureBase  # noqa: E402
import user_auth.db  # noqa: E402, F401
from utils.crud import CrudSpec  # noqa: E402
from utils.crud.list import serialize_list_entities  # noqa: E402


class CodeEntityContractTests(unittest.TestCase):
    def test_schemas_ignore_code_embedding(self):
        code_payload = {
            "name": "entity",
            "code": "export default {};",
            "code_embedding": [0.0] * 768,
        }

        for schema in (CodeEntityBase, GeometryBase, StructureBase):
            with self.subTest(schema=schema.__name__):
                entity = schema.model_validate(code_payload)

                self.assertNotIn("code_embedding", schema.model_fields)
                self.assertNotIn("code_embedding", entity.model_dump())
        experiment = ExperimentBase.model_validate(
            {
                "name": "entity",
                "source_bundle": {
                    "formatVersion": 1,
                    "files": {
                        "experiment.tsx": "experiment",
                        "simulate.py": "simulate",
                        "tasks/main.tsx": "task",
                    },
                },
                "code_embedding": [0.0] * 768,
            }
        )
        self.assertNotIn("code_embedding", experiment.model_dump())
        self.assertNotIn("code", ExperimentBase.model_fields)
        self.assertIn("source_bundle", ExperimentBase.model_fields)
        self.assertFalse(Experiment.__table__.columns.source_bundle.nullable)

    def test_code_embedding_is_deferred_from_default_entity_selects(self):
        for model in (Geometry, Structure, Experiment):
            with self.subTest(model=model.__name__):
                self.assertTrue(model.__mapper__.attrs.code_embedding.deferred)
                self.assertNotIn("code_embedding", str(select(model)))

    def test_list_serialization_excludes_code_embedding(self):
        cases = (
            (Geometry, GeometryBase),
            (Structure, StructureBase),
            (Experiment, ExperimentBase),
        )

        for model, schema in cases:
            with self.subTest(model=model.__name__):
                source = (
                    {"code": "export default {};"}
                    if model is not Experiment
                    else {
                        "source_bundle": {
                            "formatVersion": 1,
                            "files": {
                                "experiment.tsx": "experiment",
                                "simulate.py": "simulate",
                                "tasks/main.tsx": "task",
                            },
                        }
                    }
                )
                entity = model(
                    id=1,
                    name="entity",
                    code_embedding=[0.0] * 768,
                    **source,
                )
                items = asyncio.run(
                    serialize_list_entities(None, [entity], CrudSpec(model=model, schema=schema))
                )

                self.assertNotIn("code_embedding", items[0].model_dump())


if __name__ == "__main__":
    unittest.main()
