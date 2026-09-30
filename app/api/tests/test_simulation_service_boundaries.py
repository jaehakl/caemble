"""Ownership regressions without a product Solver or external database."""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from pydantic import BaseModel
from sqlalchemy import Text, create_engine, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from model_registry import register_models

register_models()

from core.crud import CrudSpec
from core.crud.common import build_scope_clause
from simulation.services import maintenance
from simulation.services.uploads import expire_uploads


class FixtureBase(DeclarativeBase):
    pass


class ScopedItem(FixtureBase):
    __tablename__ = "public_policy_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(Text)


class ItemSchema(BaseModel):
    id: int


class PublicReadPolicyTests(unittest.TestCase):
    def test_domain_policy_replaces_default_public_scope_without_changing_writes(self):
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        FixtureBase.metadata.create_all(engine)
        with Session(engine) as db:
            db.add_all([ScopedItem(id=1, user_id="owner"), ScopedItem(id=2, user_id=None),
                        ScopedItem(id=3, user_id="other")])
            db.commit()
            spec = CrudSpec(ScopedItem, ItemSchema, public_read=lambda model: model.id == 3)
            owner = SimpleNamespace(id="owner", roles=[])
            for user, scope, write, expected in (
                (None, "visible", False, [3]),
                (owner, "visible", False, [1, 3]),
                (owner, "public", False, [3]),
                (owner, "mine", False, [1]),
                (owner, "visible", True, [1]),
                (None, "visible", True, []),
            ):
                with self.subTest(scope=scope, write=write, user=user):
                    clause = build_scope_clause(spec, user, write=write, read_scope=scope)
                    self.assertEqual(list(db.scalars(select(ScopedItem.id).where(clause).order_by(ScopedItem.id))), expected)


class SimulationMaintenanceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        await maintenance.stop()

    async def test_start_is_idempotent_and_stop_cancels_the_current_sweep(self):
        entered, pending = asyncio.Event(), asyncio.Event()

        async def sweep():
            entered.set()
            await pending.wait()

        with patch.object(maintenance, "expire_once", AsyncMock(side_effect=sweep)) as expiry, patch(
            "simulation.services.maintenance.asyncio.sleep", AsyncMock()
        ) as delay:
            await maintenance.start()
            task = maintenance._task
            await maintenance.start()
            self.assertIs(maintenance._task, task)
            await asyncio.wait_for(entered.wait(), timeout=1)
            await maintenance.stop()
            await maintenance.stop()
            self.assertTrue(task.cancelled())
            self.assertIsNone(maintenance._task)
            expiry.assert_awaited_once()
            delay.assert_awaited_once_with(1)
            await maintenance.start()
            self.assertIsNot(maintenance._task, task)

    async def test_failed_sweep_is_logged_and_next_interval_retries(self):
        entered, pending = asyncio.Event(), asyncio.Event()
        attempts = 0

        async def sweep():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("temporary database failure")
            entered.set()
            await pending.wait()

        with patch.object(maintenance, "expire_once", AsyncMock(side_effect=sweep)), patch(
            "simulation.services.maintenance.asyncio.sleep", AsyncMock()
        ) as delay, patch.object(maintenance.logger, "exception") as log:
            await maintenance.start()
            await asyncio.wait_for(entered.wait(), timeout=1)
            await maintenance.stop()
            self.assertEqual(attempts, 2)
            self.assertEqual(delay.await_count, 2)
            log.assert_called_once()

    async def test_expiry_only_selects_simulation_batches(self):
        db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(all=lambda: [])), rollback=AsyncMock())
        self.assertEqual(await expire_uploads(db), 0)
        statement = db.execute.await_args.args[0]
        sql = str(statement.compile(dialect=postgresql.dialect()))
        self.assertIn("JOIN cae_batches", sql)
        db.rollback.assert_awaited_once()
