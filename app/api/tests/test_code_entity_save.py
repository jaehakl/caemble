import hashlib
import json

import pytest

from db import Experiment
from settings import settings
from tests.helpers import auth_headers, create_user, experiment_source_bundle

pytestmark = pytest.mark.slow


def bundle_hash(bundle: dict) -> str:
    canonical = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def save_payload(bundle: dict, **extra) -> dict:
    return {
        "name": "Experiment",
        "description": None,
        "sourceBundle": bundle,
        "bundleHash": bundle_hash(bundle),
        **extra,
    }


@pytest.mark.asyncio
async def test_experiment_save_owns_hash_and_forks_every_source_change(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    first = experiment_source_bundle("first")

    created = await client.post("/experiment/save", headers=headers, json=save_payload(first))
    assert created.status_code == 200
    created_body = created.json()
    assert created_body == {
        "id": created_body["id"],
        "action": "created",
        "parentId": None,
        "sourceHash": bundle_hash(first),
    }
    entity = await db_session.get(Experiment, created_body["id"])
    assert entity is not None
    assert entity.source_hash == bundle_hash(first)

    metadata = await client.post(
        "/experiment/save",
        headers=headers,
        json=save_payload(
            first,
            id=entity.id,
            name="Renamed",
            baseBundleHash=entity.source_hash,
        ),
    )
    assert metadata.status_code == 200
    assert metadata.json()["action"] == "updated"
    assert metadata.json()["id"] == entity.id

    changed = experiment_source_bundle("changed")
    forked = await client.post(
        "/experiment/save",
        headers=headers,
        json=save_payload(
            changed,
            id=entity.id,
            baseBundleHash=entity.source_hash,
        ),
    )
    assert forked.status_code == 200
    assert forked.json()["action"] == "forked"
    assert forked.json()["parentId"] == entity.id
    child = await db_session.get(Experiment, forked.json()["id"])
    assert child is not None
    assert child.parent_id == entity.id
    assert child.source_hash == bundle_hash(changed)


@pytest.mark.asyncio
async def test_experiment_save_rejects_bad_or_stale_hash(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    bundle = experiment_source_bundle()

    bad = await client.post(
        "/experiment/save",
        headers=headers,
        json={**save_payload(bundle), "bundleHash": "0" * 64},
    )
    assert bad.status_code == 400

    created = await client.post("/experiment/save", headers=headers, json=save_payload(bundle))
    stale = await client.post(
        "/experiment/save",
        headers=headers,
        json=save_payload(
            experiment_source_bundle("changed"),
            id=created.json()["id"],
            baseBundleHash="f" * 64,
        ),
    )
    assert stale.status_code == 409


@pytest.mark.asyncio
async def test_experiment_source_cannot_use_generic_upsert(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    response = await client.post("/experiment/upsert", headers=auth_headers(owner), json=[])
    assert response.status_code == 404
