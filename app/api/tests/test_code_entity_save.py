import hashlib
import json

import pytest
from sqlalchemy import select

from db import Experiment, Measurement, RecordedData
from settings import settings
from tests.helpers import auth_headers, create_user, experiment_source_bundle


pytestmark = pytest.mark.slow


def bundle_hash(bundle: dict) -> str:
    canonical = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def create_payload(bundle: dict, **extra) -> dict:
    return {
        "mode": "create",
        "repository": "examples",
        "key": "beam",
        "initialVersion": "0.1.0",
        "name": "Experiment",
        "description": None,
        "sourceBundle": bundle,
        "bundleHash": bundle_hash(bundle),
        **extra,
    }


def update_payload(mode: str, experiment_id: int, base_hash: str, bundle: dict, **extra) -> dict:
    return {
        "mode": mode,
        "experimentId": experiment_id,
        "baseBundleHash": base_hash,
        "name": "Experiment",
        "description": None,
        "sourceBundle": bundle,
        "bundleHash": bundle_hash(bundle),
        **extra,
    }


@pytest.mark.asyncio
async def test_experiment_save_modes_versions_and_latest_semver(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    first = experiment_source_bundle("first")
    created = await client.post("/experiment/save", headers=headers, json=create_payload(first))
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["action"] == "create"
    assert body["version"] == "0.1.0"
    assert body["coordinate"].startswith(f"caemble:experiment/{owner.experiment_namespace}/examples/beam@")
    assert body["bundleHash"] == bundle_hash(first)

    metadata = await client.post(
        "/experiment/save",
        headers=headers,
        json=update_payload(
            "overwrite",
            body["id"],
            body["bundleHash"],
            first,
            name="Renamed",
        ),
    )
    assert metadata.status_code == 200, metadata.text
    assert metadata.json()["action"] == "overwrite"
    assert metadata.json()["id"] == body["id"]

    minor_bundle = experiment_source_bundle("minor")
    minor = await client.post(
        "/experiment/save",
        headers=headers,
        json=update_payload(
            "new_version",
            body["id"],
            body["bundleHash"],
            minor_bundle,
            bump="minor",
        ),
    )
    assert minor.status_code == 200, minor.text
    assert minor.json()["version"] == "0.2.0"

    patch = await client.post(
        "/experiment/save",
        headers=headers,
        json=update_payload(
            "new_version",
            body["id"],
            body["bundleHash"],
            first,
            bump="patch",
        ),
    )
    assert patch.status_code == 200, patch.text
    assert patch.json()["version"] == "0.2.1"
    versions = await client.get(f"/experiment/{body['id']}/versions", headers=headers)
    assert versions.status_code == 200
    assert [item["version"] for item in versions.json()["items"]] == ["0.2.1", "0.2.0", "0.1.0"]


@pytest.mark.asyncio
async def test_overwrite_source_lock_usage_and_hard_delete_cascade(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    bundle = experiment_source_bundle()
    saved = await client.post("/experiment/save", headers=headers, json=create_payload(bundle))
    experiment_id = saved.json()["id"]
    measurement = Measurement(
        user_id=owner.id,
        experiment_id=experiment_id,
        vars={},
        material_parameters={
            "schemaVersion": 2,
            "experiment": {"schemaVersion": 1, "materials": {}},
            "tasks": {"main": {"schemaVersion": 1, "materials": {}}},
        },
    )
    db_session.add(measurement)
    await db_session.flush()
    db_session.add(
        RecordedData(
            user_id=owner.id,
            measurement_id=measurement.id,
            name="result",
            quantity_kind=None,
            tensor_order=0,
            dtype="float64",
            data_schema={},
            data=1.0,
        )
    )
    await db_session.commit()

    usage = await client.post(
        "/experiment/usage",
        headers=headers,
        json={"experimentIds": [experiment_id]},
    )
    assert usage.json()["items"] == [
        {
            "experimentId": experiment_id,
            "sourceLocked": True,
            "derivedCounts": {
                "measurements": 1,
                "recordedData": 1,
                "designerModels": 0,
                "predictorModels": 0,
            },
        }
    ]
    changed = experiment_source_bundle("changed")
    blocked = await client.post(
        "/experiment/save",
        headers=headers,
        json=update_payload(
            "overwrite",
            experiment_id,
            saved.json()["bundleHash"],
            changed,
        ),
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "experiment_source_locked"

    metadata = await client.post(
        "/experiment/save",
        headers=headers,
        json=update_payload(
            "overwrite",
            experiment_id,
            saved.json()["bundleHash"],
            bundle,
            name="Metadata only",
        ),
    )
    assert metadata.status_code == 200
    removed = await client.request("DELETE", "/experiment/", headers=headers, json=[experiment_id])
    assert removed.status_code == 200
    assert await db_session.get(Experiment, experiment_id) is None
    assert await db_session.scalar(select(Measurement).where(Measurement.id == measurement.id)) is None


@pytest.mark.asyncio
async def test_experiment_save_rejects_bad_and_stale_hash(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    bundle = experiment_source_bundle()
    bad = await client.post(
        "/experiment/save",
        headers=headers,
        json={**create_payload(bundle), "bundleHash": "0" * 64},
    )
    assert bad.status_code == 400
    created = await client.post("/experiment/save", headers=headers, json=create_payload(bundle))
    stale = await client.post(
        "/experiment/save",
        headers=headers,
        json=update_payload(
            "overwrite",
            created.json()["id"],
            "f" * 64,
            experiment_source_bundle("changed"),
        ),
    )
    assert stale.status_code == 409


@pytest.mark.asyncio
async def test_experiment_source_has_no_generic_upsert(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    response = await client.post("/experiment/upsert", headers=auth_headers(owner), json=[])
    assert response.status_code == 404
