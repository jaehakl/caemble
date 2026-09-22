from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import Column, DateTime, ForeignKey, Integer, Table, Text, create_engine, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, configure_mappers, mapped_column, relationship


APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

import db  # noqa: E402
import gpstation.db  # noqa: E402, F401
import user_auth.db  # noqa: E402, F401
from models import GetListRequestBase  # noqa: E402
from service.calculation_data import CALCULATION_DATA_CRUD_SPEC  # noqa: E402
from service.measurement_service import MEASUREMENT_WRITE_CRUD_SPEC  # noqa: E402
from utils.crud import CrudSpec, delete_items, get_list_response  # noqa: E402
from utils.crud.common import build_scope_clause  # noqa: E402
from utils.crud.list import serialize_list_entities  # noqa: E402


class FixtureBase(DeclarativeBase):
    pass


item_tags = Table(
    "crud_item_tags",
    FixtureBase.metadata,
    Column("item_id", ForeignKey("crud_items.id"), nullable=False),
    Column("tag_id", ForeignKey("crud_tags.id"), nullable=False),
)


class Item(FixtureBase):
    __tablename__ = "crud_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    score: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    tags: Mapped[list[Tag]] = relationship(secondary=item_tags, lazy="raise")


class Tag(FixtureBase):
    __tablename__ = "crud_tags"

    id: Mapped[int] = mapped_column(primary_key=True)
    payload: Mapped[str] = mapped_column(Text)


class ItemResponse(BaseModel):
    id: int
    name: str
    created_at: datetime
    tag_ids: list[int] = Field(default_factory=list)
    count: int = 0


ITEM_SPEC = CrudSpec(
    model=Item,
    schema=ItemResponse,
    relation_aliases={"tag_ids": "tags"},
    search_aliases={"content": ("name", "description")},
)


class CrudTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        configure_mappers()
        self.engine = create_engine("sqlite://")
        with self.engine.connect() as connection:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        FixtureBase.metadata.create_all(self.engine)
        self.session = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.session.close)
        self.owner = SimpleNamespace(id="owner", roles=[])
        self.admin = SimpleNamespace(id="admin", roles=["admin"])
        self.session.add_all([
            Item(id=1, user_id="owner", name="alpha", description="needle", score=10, created_at=datetime(2026, 9, 22)),
            Item(id=2, user_id="owner", name="beta", description="needle", score=20, created_at=datetime(2026, 9, 23)),
            Item(id=3, user_id="other", name="alpha", description="private", score=30, created_at=datetime(2026, 9, 24)),
            Item(id=4, user_id=None, name="공개", description=None, score=15, created_at=datetime(2026, 9, 25)),
            Tag(id=2, payload="large payload"),
            Tag(id=9, payload="large payload"),
        ])
        self.session.flush()
        self.session.execute(item_tags.insert(), [
            {"item_id": 1, "tag_id": 9},
            {"item_id": 1, "tag_id": 2},
            {"item_id": 1, "tag_id": 9},
        ])
        self.session.commit()
        # Run actual SQL without adding an async SQLite driver dependency.
        self.database = SimpleNamespace(
            execute=AsyncMock(side_effect=self.session.execute),
            commit=AsyncMock(side_effect=self.session.commit),
            rollback=AsyncMock(side_effect=self.session.rollback),
        )

    async def test_relations_are_bulk_loaded_as_sorted_unique_ids_and_defaults_survive(self) -> None:
        response = await get_list_response(
            self.database, GetListRequestBase(), ITEM_SPEC, user=self.owner,
        )
        self.assertEqual(response["total"], 3)
        self.assertEqual([item.id for item in response["items"]], [4, 2, 1])
        self.assertEqual([item.tag_ids for item in response["items"]], [[], [], [2, 9]])
        self.assertEqual(response["items"][2].created_at, datetime(2026, 9, 22, tzinfo=timezone.utc))
        self.assertTrue(all(item.count == 0 for item in response["items"]))
        self.assertEqual(self.database.execute.await_count, 3)
        relation_query = self.database.execute.await_args_list[-1].args[0]
        self.assertEqual([column.name for column in relation_query.selected_columns], ["id", "id"])

    async def test_empty_page_does_not_query_relations(self) -> None:
        response = await get_list_response(
            self.database, GetListRequestBase(offset=100), ITEM_SPEC, user=self.owner,
        )
        self.assertEqual(response, {"total": 3, "items": []})
        self.assertEqual(self.database.execute.await_count, 2)
        self.assertEqual(await serialize_list_entities(self.database, [], ITEM_SPEC), [])
        self.assertEqual(self.database.execute.await_count, 2)

    async def test_selected_ids_do_not_bypass_ownership_or_base_clause(self) -> None:
        response = await get_list_response(
            self.database,
            GetListRequestBase(selected_ids=[1, 3, 4], filter={"score": [15, 25]}),
            ITEM_SPEC,
            Item.id < 4,
            user=self.owner,
        )
        self.assertEqual(response["total"], 2)
        self.assertEqual([item.id for item in response["items"]], [2, 1])

    async def test_search_alias_multisort_pagination_and_null_filter(self) -> None:
        response = await get_list_response(
            self.database,
            GetListRequestBase(text_filter={"content": ["needle"]}, sort=[["description", "asc"], ["score", "desc"]], offset=1, limit=1),
            ITEM_SPEC,
            user=self.owner,
        )
        self.assertEqual(response["total"], 2)
        self.assertEqual([item.id for item in response["items"]], [1])
        response = await get_list_response(
            self.database, GetListRequestBase(null_filter={"description": "is_null"}), ITEM_SPEC, user=self.owner,
        )
        self.assertEqual([item.name for item in response["items"]], ["공개"])

    async def test_search_uses_required_text_and_sort_ties_use_descending_id(self) -> None:
        response = await get_list_response(
            self.database, GetListRequestBase(search_text="alpha", sort=["name", "asc"]), ITEM_SPEC, user=self.admin,
        )
        self.assertEqual([item.id for item in response["items"]], [3, 1])
        response = await get_list_response(
            self.database, GetListRequestBase(search_text="needle"), ITEM_SPEC, user=self.admin,
        )
        self.assertEqual(response["total"], 0)

    async def test_datetime_filter_converts_explicit_timezone_to_utc(self) -> None:
        response = await get_list_response(
            self.database,
            GetListRequestBase(filter={"created_at": ["2026-09-22T09:00:00+09:00", "2026-09-22T09:00:00+09:00"]}),
            ITEM_SPEC,
            user=self.owner,
        )
        self.assertEqual([item.id for item in response["items"]], [1])

    async def test_random_order_ignores_offset_but_keeps_limit_and_scope(self) -> None:
        response = await get_list_response(
            self.database, GetListRequestBase(random=True, offset=100, limit=2), ITEM_SPEC, user=self.owner,
        )
        self.assertEqual(response["total"], 3)
        self.assertEqual(len(response["items"]), 2)
        self.assertTrue({item.id for item in response["items"]} <= {1, 2, 4})

    async def test_read_scopes_preserve_public_owner_admin_and_anonymous_behavior(self) -> None:
        for user, scope, expected in (
            (None, "visible", [4]),
            (self.owner, "mine", [2, 1]),
            (self.owner, "public", [4]),
            (self.admin, "visible", [4, 3, 2, 1]),
            (self.admin, "public", [4]),
        ):
            with self.subTest(user=user, scope=scope):
                response = await get_list_response(
                    self.database, GetListRequestBase(scope=scope), ITEM_SPEC, user=user,
                )
                self.assertEqual([item.id for item in response["items"]], expected)
        with self.assertRaises(HTTPException) as error:
            await get_list_response(self.database, GetListRequestBase(scope="mine"), ITEM_SPEC)
        self.assertEqual(error.exception.status_code, 401)

    async def test_delete_checks_all_ids_before_mutation_and_normalizes_ids(self) -> None:
        with self.assertRaises(HTTPException) as error:
            await delete_items(self.database, ITEM_SPEC, [2, 3], user=self.owner)
        self.assertEqual(error.exception.status_code, 404)
        self.assertIsNotNone(self.session.get(Item, 2))
        self.database.commit.assert_not_awaited()
        await delete_items(self.database, ITEM_SPEC, [2, 2, False, "invalid"], user=self.owner)
        self.assertIsNone(self.session.get(Item, 2))
        await delete_items(self.database, ITEM_SPEC, [3], user=self.admin)
        self.assertIsNone(self.session.get(Item, 3))
        self.assertEqual(self.database.commit.await_count, 2)

    async def test_delete_rejects_anonymous_and_rolls_back_constraint_failure(self) -> None:
        with self.assertRaises(HTTPException) as error:
            await delete_items(self.database, ITEM_SPEC, [], user=None)
        self.assertEqual(error.exception.status_code, 401)
        self.database.execute.assert_not_awaited()
        await delete_items(self.database, ITEM_SPEC, [], user=self.owner)
        self.database.execute.assert_not_awaited()
        with self.assertRaises(HTTPException) as error:
            await delete_items(self.database, ITEM_SPEC, [1], user=self.owner)
        self.assertEqual(error.exception.status_code, 409)
        self.database.rollback.assert_awaited_once()
        self.database.commit.assert_not_awaited()
        self.assertIsNotNone(self.session.get(Item, 1))

    def test_production_scope_keeps_demo_visibility_and_measurement_write_owner(self) -> None:
        clause = build_scope_clause(CALCULATION_DATA_CRUD_SPEC, None, write=False)
        public_sql = str(select(db.CalculationData.id).where(clause).compile(dialect=postgresql.dialect()))
        self.assertIn("measurements", public_sql)
        self.assertIn("experiments", public_sql)
        self.assertIn("experiment_demos", public_sql)
        self.assertNotIn("user_id IS NULL", public_sql)
        clause = build_scope_clause(MEASUREMENT_WRITE_CRUD_SPEC, self.owner, write=True)
        write_sql = str(select(db.Measurement.id).where(clause).compile(dialect=postgresql.dialect()))
        self.assertIn("measurements.user_id =", write_sql)
        self.assertNotIn("experiments", write_sql)
        self.assertNotIn("experiment_demos", write_sql)


if __name__ == "__main__":
    unittest.main()
