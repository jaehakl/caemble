import asyncio
import json
import os
import sys
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from db import Experiment, ExperimentDemo, ExperimentThumbnail, Measurement, make_async_db_url
from models import UserData, RoleEnum
from gpstation.service.state import utcnow
from service.experiment_presentation import PresentationUpdateRequest, update_presentation
from service.experiment import list_experiments, experiment_versions
from service.demo_experiment import available_experiments
from models import GetListRequestBase
from test_experiment_save_assets import image_url
from test_calculation_database import _create_database, _database_url, _drop_database, _seed_owners, _upgrade

DEFAULTS = dict(version=1, selectedResult="signal", settings={
    "@workspace:xrayEnabled": True, "signal:box.kind": "cloud", "signal:box.geometryOpacity": 0.3,
    "signal:box.reduce": {"frequency": {"method": "sum"}}, "signal:box.playing": False,
}, camera=dict(position=[3, 4, 5], target=[0, 0, 0], up=[0, 0, 1], fov=0.8))


class PresentationValidationTests(unittest.TestCase):
    def test_frontend_initial_view_contract(self):
        initial = json.loads((Path(__file__).parent / "fixtures/viewer_initial_view.json").read_text(encoding="utf-8"))
        request = PresentationUpdateRequest(initialView=initial)
        self.assertEqual(request.initialView.model_dump(), initial)
        for animation in ("x", "y", "z", "component"):
            PresentationUpdateRequest(initialView={**initial, "settings": {"signal:box.animation": animation}})
        for component in ({"tensor": ["arrows", "arrows"]}, {"tensor": ["x", "invalid"]},
                          {"tensor": ["x"]}, {"tensor": ["x", "y", "z"]}, -1, True):
            with self.subTest(component=component), self.assertRaises(ValidationError):
                PresentationUpdateRequest(initialView={**initial, "settings": {"signal:box.component": component}})
        mesh = initial["settings"]["stress:mesh.view"]
        with self.assertRaises(ValidationError):
            PresentationUpdateRequest(initialView={**initial, "settings": {
                "stress:mesh.view": {**mesh, "component": {"tensor": ["x", "arrows"]}}}})

    def test_output_role_settings_are_independent_and_validated(self):
        settings = {"signal@output-space:box.component": 1, "signal@output-chart:box.component": 2,
                    "signal@output-chart:box.kind": "heatmap", "signal@output-space:box.fixed": [0, 10]}
        request = PresentationUpdateRequest(initialView={"version": 2, "geometryMode": 0.9,
            "selectedOutput": "signal", "visualizations": {}, "settings": settings, "camera": None, "measurementId": 1})
        self.assertEqual(request.initialView.settings, settings)
        with self.assertRaises(ValueError):
            PresentationUpdateRequest(initialView={**DEFAULTS, "measurementId": 1,
                "settings": {"signal@output-space:mesh.deformed": True}})

    def test_v2_independent_selections_round_trip(self):
        defaults = dict(version=2, geometryMode=0.5, selectedOutput="signal",
                        visualizations={"polyline": "", "mesh-field": "@visualizations.solid.field"},
                        settings={"@workspace:geometryMode": 0.5,
                                  "@visualizations.solid.field:mesh.deformed": False}, camera=DEFAULTS["camera"])
        request = PresentationUpdateRequest(initialView={**defaults, "measurementId": 3})
        self.assertEqual(request.initialView.model_dump(exclude={"measurementId"}), defaults)
        for override in ({"geometryMode": 0.7}, {"selectedResult": "legacy"}, {"visualizations": {"polyline": 42}}):
            with self.subTest(override=override), self.assertRaises(ValidationError):
                PresentationUpdateRequest(initialView={**defaults, "measurementId": 3, **override})

    def test_partial_update_and_clear(self):
        self.assertEqual(PresentationUpdateRequest(initialView=None).model_fields_set, {"initialView"})
        request = PresentationUpdateRequest(initialView={**DEFAULTS, "measurementId": 3})
        self.assertEqual(request.initialView.measurementId, 3)
        self.assertEqual(PresentationUpdateRequest(thumbnail=image_url()).model_fields_set, {"thumbnail"})

    def test_rejects_malformed_and_transient_settings(self):
        for settings in ({"busy:actual": True}, {"signal:pickMode": "body"}, {"signal:box.speed": -1},
                         {"signal:box.axes": ["wrong"]}, {"signal:box.reduce": {"x": {"method": "bad"}}},
                         {"signal:mesh.view": {}}, {"signal:box.timeSeconds": float("nan")},
                         {"signal:box.fixed": [4, 2]}, {"@workspace:box.playing": True}):
            with self.subTest(settings=settings), self.assertRaises(ValidationError):
                PresentationUpdateRequest(initialView={**DEFAULTS, "measurementId": 1, "settings": settings})
        for values in ({}, {"thumbnail": None}, {"initialView": {**DEFAULTS, "measurementId": True}},
                       {"initialView": {**DEFAULTS, "measurementId": 1, "camera": {**DEFAULTS["camera"], "up": [0, 0, 0]}}}):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                PresentationUpdateRequest(**values)


class PresentationServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_frontend_settings_survive_save_and_response(self):
        initial = json.loads((Path(__file__).parent / "fixtures/viewer_initial_view.json").read_text(encoding="utf-8"))
        row = Experiment(id=1, thumbnail_url="existing")
        db = SimpleNamespace(scalar=AsyncMock(side_effect=[row, SimpleNamespace(experiment_id=1, recorded_at=utcnow())]),
                             commit=AsyncMock(), flush=AsyncMock())
        with patch("service.experiment_presentation.require_experiment_write", AsyncMock()), patch("service.experiment_presentation.experiment_is_demo", AsyncMock(return_value=False)):
            result = await update_presentation(db, 1, PresentationUpdateRequest(initialView=initial), user=UserData(id="owner", roles=[RoleEnum.user]))
        defaults = {key: value for key, value in initial.items() if key != "measurementId"}
        self.assertEqual(row.viewer_defaults, defaults)
        self.assertEqual(result["viewer_defaults"], defaults)
        self.assertEqual(result["initial_measurement_id"], 3)
        self.assertEqual(result["thumbnail_url"], "existing")
        db.commit.assert_awaited_once()

    async def test_invalid_measurement_or_image_does_not_mutate_existing_settings(self):
        row = Experiment(id=1, initial_measurement_id=9, viewer_defaults=DEFAULTS, thumbnail_url="old")
        db = SimpleNamespace(scalar=AsyncMock(side_effect=[row, SimpleNamespace(experiment_id=2, recorded_at=utcnow())]),
                             commit=AsyncMock(), flush=AsyncMock())
        with patch("service.experiment_presentation.require_experiment_write", AsyncMock()), patch("service.experiment_presentation.experiment_is_demo", AsyncMock(return_value=False)):
            with self.assertRaises(HTTPException):
                await update_presentation(db, 1, PresentationUpdateRequest(initialView={**DEFAULTS, "measurementId": 2}), user=UserData(id="owner", roles=[RoleEnum.user]))
            self.assertEqual(row.initial_measurement_id, 9)
            db.commit.assert_not_called()
            db.scalar = AsyncMock(return_value=row)
            with self.assertRaises(HTTPException):
                await update_presentation(db, 1, PresentationUpdateRequest(initialView=None, thumbnail="invalid"), user=UserData(id="owner", roles=[RoleEnum.user]))
            self.assertEqual(row.initial_measurement_id, 9)


@unittest.skipUnless(os.getenv("RUN_CALCULATION_DB_TESTS") == "1", "Requires disposable PostgreSQL databases")
class PresentationDatabaseTests(unittest.TestCase):
    def test_mutable_metadata_public_reads_permissions_and_deleted_measurement(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        defaults = json.loads((Path(__file__).parent / "fixtures/viewer_initial_view.json").read_text(encoding="utf-8"))
        defaults.pop("measurementId")

        async def verify():
            owner_id, other_id, experiment_id, other_experiment_id = await _seed_owners(database)
            owner = UserData(id=owner_id, roles=[RoleEnum.user])
            other = UserData(id=other_id, roles=[RoleEnum.user])
            admin = UserData(id=other_id, roles=[RoleEnum.admin])
            engine = create_async_engine(make_async_db_url(_database_url(database)))
            sessions = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with sessions() as db:
                    measurement = Measurement(user_id=owner_id, experiment_id=experiment_id, vars={}, material_snapshot={}, recorded_at=utcnow())
                    db.add(measurement)
                    await db.commit()
                    measurement_id = measurement.id
                    request = PresentationUpdateRequest(initialView={**defaults, "measurementId": measurement_id}, thumbnail=image_url())
                    result = await update_presentation(db, experiment_id, request, user=owner)
                    self.assertEqual(result["viewer_defaults"], defaults)
                    self.assertEqual(result["initial_measurement_id"], measurement_id)
                    thumbnail_url = result["thumbnail_url"]
                    row = await db.get(Experiment, experiment_id)
                    self.assertEqual(row.source_hash, "hash-calc-owner")
                    self.assertEqual(row.version_patch, 0)
                    for actor in (other, None):
                        with self.assertRaises(HTTPException):
                            await update_presentation(db, experiment_id, PresentationUpdateRequest(initialView=None), user=actor)
                        await db.rollback()
                    with self.assertRaises(HTTPException):
                        await update_presentation(db, other_experiment_id, request, user=other)
                    await db.rollback()
                    db.add(ExperimentDemo(experiment_id=experiment_id, display_order=0, is_default=True))
                    await db.commit()
                    with self.assertRaises(HTTPException) as denied:
                        await update_presentation(db, experiment_id, PresentationUpdateRequest(initialView=None), user=owner)
                    self.assertEqual(denied.exception.status_code, 403)
                    await db.rollback()
                    result = await update_presentation(db, experiment_id, PresentationUpdateRequest(thumbnail=image_url((320, 240))), user=admin)
                    self.assertNotEqual(result["thumbnail_url"], thumbnail_url)
                    self.assertEqual(result["viewer_defaults"], defaults)
                    public = await available_experiments(db, user=None)
                    self.assertEqual(public["demos"][0]["viewer_defaults"], defaults)
                    versions = await experiment_versions(db, experiment_id, user=None)
                    self.assertEqual(versions["items"][0]["initial_measurement_id"], measurement_id)
                    listing = await list_experiments(db, GetListRequestBase(scope="visible"), user=None)
                    self.assertEqual(listing["items"][0]["viewer_defaults"], defaults)
                    await db.execute(delete(Measurement).where(Measurement.id == measurement_id))
                    await db.commit()
                    db.expire_all()
                    row = await db.get(Experiment, experiment_id)
                    self.assertIsNone(row.initial_measurement_id)
                    self.assertEqual(row.viewer_defaults, defaults)
                    cleared = await update_presentation(db, experiment_id, PresentationUpdateRequest(initialView=None), user=admin)
                    self.assertIsNone(cleared["viewer_defaults"])
                    self.assertIsNotNone(await db.get(ExperimentThumbnail, experiment_id))
            finally:
                await engine.dispose()

        asyncio.run(_create_database(database))
        try:
            _upgrade(database, "head")
            asyncio.run(verify())
        finally:
            asyncio.run(_drop_database(database))
