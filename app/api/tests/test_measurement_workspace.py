import hashlib
import json

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from db import Experiment, Measurement, RecordedData
from settings import settings
from tests.helpers import auth_headers, create_user, experiment_source_bundle


def source_hash(bundle: dict) -> str:
    encoded = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


async def create_experiment(db_session, user_id, *, public=False):
    bundle = experiment_source_bundle()
    experiment = Experiment(
        name="Experiment",
        source_bundle=bundle,
        source_hash=source_hash(bundle),
        user_id=None if public else user_id,
    )
    db_session.add(experiment)
    await db_session.commit()
    return experiment


def create_payload(experiment, **extra):
    return {
        "experiment_id": experiment.id,
        "experiment_source_hash": experiment.source_hash,
        "vars": {"width": 3, "voltage": 5},
        "material_parameters": {
            "schemaVersion": 2,
            "experiment": {"schemaVersion": 1, "materials": {}},
            "tasks": {"main": {"schemaVersion": 1, "materials": {}}},
        },
        **extra,
    }


def recorded_payload(name="Current"):
    return {
        "recorded_data": [
            {
                "name": name,
                "quantity_kind": "electromagnetism.ElectricCurrent",
                "tensor_order": 0,
                "dtype": "float64",
                "data_schema": {
                    "dtype": "float64",
                    "unit": "A",
                    "quantityKind": "electromagnetism.ElectricCurrent",
                },
                "data": {
                    "tensorEncodingVersion": 1,
                    "shape": [],
                    "storage": {"kind": "inline", "value": 2.5},
                },
            }
        ]
    }


@pytest.mark.asyncio
async def test_create_always_inserts_complete_immutable_input_snapshot(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    experiment = await create_experiment(db_session, owner.id)
    headers = auth_headers(owner)

    first = await client.post("/measurement/create", headers=headers, json=create_payload(experiment))
    second = await client.post("/measurement/create", headers=headers, json=create_payload(experiment))
    assert first.status_code == second.status_code == 200
    assert first.json()["id"] != second.json()["id"]

    measurement = await db_session.get(Measurement, first.json()["id"])
    assert measurement is not None
    assert measurement.user_id == owner.id
    assert measurement.experiment_id == experiment.id
    assert measurement.vars == {"width": 3, "voltage": 5}
    assert measurement.material_parameters == {
        "schemaVersion": 2,
        "experiment": {"schemaVersion": 1, "materials": {}},
        "tasks": {"main": {"schemaVersion": 1, "materials": {}}},
    }
    assert measurement.recorded_at is None


@pytest.mark.asyncio
async def test_create_rejects_source_change_and_hidden_experiment(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    experiment = await create_experiment(db_session, other.id)

    hidden = await client.post(
        "/measurement/create",
        headers=auth_headers(owner),
        json=create_payload(experiment),
    )
    assert hidden.status_code == 404

    stale = await client.post(
        "/measurement/create",
        headers=auth_headers(other),
        json=create_payload(experiment, experiment_source_hash="0" * 64),
    )
    assert stale.status_code == 409


@pytest.mark.asyncio
async def test_create_allows_visible_public_experiment(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    experiment = await create_experiment(db_session, owner.id, public=True)
    response = await client.post(
        "/measurement/create",
        headers=auth_headers(owner),
        json=create_payload(experiment),
    )
    assert response.status_code == 200
    assert (await db_session.get(Measurement, response.json()["id"])).user_id == owner.id


@pytest.mark.asyncio
async def test_create_rejects_non_v2_material_snapshot_and_seed_fields(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    experiment = await create_experiment(db_session, owner.id)
    headers = auth_headers(owner)

    legacy = create_payload(experiment)
    legacy["material_parameters"] = {"schemaVersion": 1, "materials": {}}
    assert (await client.post("/measurement/create", headers=headers, json=legacy)).status_code == 422

    missing_task = create_payload(experiment)
    missing_task["material_parameters"]["tasks"] = {}
    assert (await client.post("/measurement/create", headers=headers, json=missing_task)).status_code == 422

    unknown_field = create_payload(experiment, generation_metadata={"method": "random"})
    assert (await client.post("/measurement/create", headers=headers, json=unknown_field)).status_code == 422


@pytest.mark.asyncio
async def test_record_is_atomic_and_only_allowed_once(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    owner_id = owner.id
    experiment = await create_experiment(db_session, owner.id)
    headers = auth_headers(owner)
    created = await client.post("/measurement/create", headers=headers, json=create_payload(experiment))
    measurement_id = created.json()["id"]

    recorded = await client.post(
        f"/measurement/{measurement_id}/record",
        headers=headers,
        json=recorded_payload(),
    )
    assert recorded.status_code == 200
    db_session.expire_all()
    measurement = await db_session.get(Measurement, measurement_id)
    row = await db_session.scalar(
        select(RecordedData).where(RecordedData.measurement_id == measurement_id)
    )
    assert measurement is not None and measurement.recorded_at is not None
    assert row is not None and row.name == "Current"
    assert row.user_id == owner_id

    second = await client.post(
        f"/measurement/{measurement_id}/record",
        headers=headers,
        json=recorded_payload("Replacement"),
    )
    assert second.status_code == 409
    assert await db_session.scalar(
        select(func.count(RecordedData.id)).where(RecordedData.measurement_id == measurement_id)
    ) == 1


@pytest.mark.asyncio
async def test_empty_recording_marks_measurement_complete(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    experiment = await create_experiment(db_session, owner.id)
    headers = auth_headers(owner)
    created = await client.post("/measurement/create", headers=headers, json=create_payload(experiment))
    measurement_id = created.json()["id"]
    response = await client.post(
        f"/measurement/{measurement_id}/record",
        headers=headers,
        json={"recorded_data": []},
    )
    assert response.status_code == 200
    db_session.expire_all()
    assert (await db_session.get(Measurement, measurement_id)).recorded_at is not None


@pytest.mark.asyncio
async def test_record_rejects_duplicate_names_before_writing(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    experiment = await create_experiment(db_session, owner.id)
    headers = auth_headers(owner)
    created = await client.post("/measurement/create", headers=headers, json=create_payload(experiment))
    measurement_id = created.json()["id"]
    duplicate = recorded_payload()["recorded_data"] * 2
    response = await client.post(
        f"/measurement/{measurement_id}/record",
        headers=headers,
        json={"recorded_data": duplicate},
    )
    assert response.status_code == 422
    db_session.expire_all()
    assert (await db_session.get(Measurement, measurement_id)).recorded_at is None


@pytest.mark.asyncio
async def test_record_rolls_back_completion_and_data_when_commit_fails(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    experiment = await create_experiment(db_session, owner.id)
    headers = auth_headers(owner)
    created = await client.post("/measurement/create", headers=headers, json=create_payload(experiment))
    measurement_id = created.json()["id"]

    async def fail_commit():
        raise IntegrityError("record measurement", {}, RuntimeError("forced failure"))

    monkeypatch.setattr(db_session, "commit", fail_commit)
    response = await client.post(
        f"/measurement/{measurement_id}/record",
        headers=headers,
        json=recorded_payload(),
    )
    assert response.status_code == 409
    db_session.expire_all()
    assert (await db_session.get(Measurement, measurement_id)).recorded_at is None
    assert await db_session.scalar(
        select(func.count(RecordedData.id)).where(RecordedData.measurement_id == measurement_id)
    ) == 0


@pytest.mark.asyncio
async def test_recorded_data_is_read_only_and_measurement_delete_cascades(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    experiment = await create_experiment(db_session, owner.id)
    headers = auth_headers(owner)
    created = await client.post("/measurement/create", headers=headers, json=create_payload(experiment))
    measurement_id = created.json()["id"]
    await client.post(
        f"/measurement/{measurement_id}/record",
        headers=headers,
        json=recorded_payload(),
    )

    assert (await client.post("/recorded_data/upsert", headers=headers, json=[])).status_code == 404
    assert (await client.request("DELETE", "/recorded_data/", headers=headers, json=[])).status_code == 404
    deleted = await client.request("DELETE", "/measurement/", headers=headers, json=[measurement_id])
    assert deleted.status_code == 200
    db_session.expire_all()
    assert await db_session.get(Measurement, measurement_id) is None
    assert await db_session.scalar(
        select(func.count(RecordedData.id)).where(RecordedData.measurement_id == measurement_id)
    ) == 0


@pytest.mark.asyncio
async def test_experiment_with_measurement_cannot_be_deleted(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    experiment = await create_experiment(db_session, owner.id)
    experiment_id = experiment.id
    headers = auth_headers(owner)
    await client.post("/measurement/create", headers=headers, json=create_payload(experiment))
    response = await client.request("DELETE", "/experiment/", headers=headers, json=[experiment_id])
    assert response.status_code == 409
    assert await db_session.get(Experiment, experiment_id) is not None
