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
        payload = {
            "name": "entity",
            "code": "export default {};",
            "code_embedding": [0.0] * 768,
        }

        for schema in (CodeEntityBase, GeometryBase, StructureBase, ExperimentBase):
            with self.subTest(schema=schema.__name__):
                entity = schema.model_validate(payload)

                self.assertNotIn("code_embedding", schema.model_fields)
                self.assertNotIn("code_embedding", entity.model_dump())

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
                entity = model(
                    id=1,
                    name="entity",
                    code="export default {};",
                    code_embedding=[0.0] * 768,
                )
                items = asyncio.run(
                    serialize_list_entities(None, [entity], CrudSpec(model=model, schema=schema))
                )

                self.assertNotIn("code_embedding", items[0].model_dump())


if __name__ == "__main__":
    unittest.main()
