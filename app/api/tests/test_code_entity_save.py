import hashlib
import json

import pytest

from db import Experiment, Structure
from settings import settings
from tests.helpers import auth_headers, create_user


def code_hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def bundle(experiment_source="export default experiment({ varsSchema: {}, recordedData: {} })", python_source=None):
    return {
        "formatVersion": 1,
        "files": {
            "experiment.tsx": experiment_source,
            "simulate.py": python_source or "async def simulate(*, sim, tasks, vars):\n    return None\n",
            "tasks/main.tsx": "export default defineTask({})",
        },
    }


def bundle_hash(source_bundle):
    value = json.dumps(source_bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return code_hash(value)


def save_payload(code: str, semantic_hash: str, **extra):
    return {
        "name": "Saved definition",
        "description": "description",
        "code": code,
        "rawCodeHash": code_hash(code),
        "semanticHash": semantic_hash,
        "semanticHashVersion": 1,
        **extra,
    }


def experiment_save_payload(source_bundle, semantic_hash, **extra):
    return {
        "name": "Saved Experiment",
        "description": "description",
        "sourceBundle": source_bundle,
        "bundleHash": bundle_hash(source_bundle),
        "semanticHash": semantic_hash,
        "semanticHashVersion": 2,
        **extra,
    }


@pytest.mark.asyncio
async def test_structure_save_updates_formatting_and_forks_structural_changes(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    first = "export default 1;"
    created = await client.post("/structure/save", headers=headers, json=save_payload(first, "1" * 64))
    assert created.status_code == 200
    entity_id = created.json()["id"]

    formatted = "export default 1\n"
    updated = await client.post(
        "/structure/save",
        headers=headers,
        json=save_payload(
            formatted,
            "1" * 64,
            id=entity_id,
            baseRawCodeHash=code_hash(first),
            baseSemanticHash="1" * 64,
        ),
    )
    assert updated.json()["action"] == "updated"

    changed = "export default 2;"
    forked = await client.post(
        "/structure/save",
        headers=headers,
        json=save_payload(
            changed,
            "2" * 64,
            id=entity_id,
            baseRawCodeHash=code_hash(formatted),
            baseSemanticHash="1" * 64,
        ),
    )
    assert forked.json()["action"] == "forked"
    assert (await db_session.get(Structure, forked.json()["id"])).parent_id == entity_id


@pytest.mark.asyncio
async def test_experiment_bundle_save_is_atomic_and_forks_semantic_changes(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    first = bundle()

    mismatched = experiment_save_payload(first, "1" * 64)
    mismatched["bundleHash"] = "0" * 64
    assert (await client.post("/experiment/save", headers=headers, json=mismatched)).status_code == 400

    created = await client.post(
        "/experiment/save", headers=headers, json=experiment_save_payload(first, "1" * 64)
    )
    assert created.status_code == 200
    entity_id = created.json()["id"]

    formatted = bundle(experiment_source=f"{first['files']['experiment.tsx']}\n")
    updated = await client.post(
        "/experiment/save",
        headers=headers,
        json=experiment_save_payload(
            formatted,
            "1" * 64,
            id=entity_id,
            baseBundleHash=bundle_hash(first),
            baseSemanticHash="1" * 64,
        ),
    )
    assert updated.json() == {"id": entity_id, "action": "updated", "parentId": None}

    changed = bundle(python_source="async def simulate(*, sim, tasks, vars):\n    return await sim.random()\n")
    stale = await client.post(
        "/experiment/save",
        headers=headers,
        json=experiment_save_payload(
            changed,
            "2" * 64,
            id=entity_id,
            baseBundleHash=bundle_hash(first),
            baseSemanticHash="1" * 64,
        ),
    )
    assert stale.status_code == 409

    forked = await client.post(
        "/experiment/save",
        headers=headers,
        json=experiment_save_payload(
            changed,
            "2" * 64,
            id=entity_id,
            baseBundleHash=bundle_hash(formatted),
            baseSemanticHash="1" * 64,
        ),
    )
    assert forked.status_code == 200
    assert forked.json()["action"] == "forked"
    child = await db_session.get(Experiment, forked.json()["id"])
    assert child.parent_id == entity_id
    assert child.source_bundle == changed
    assert (await db_session.get(Experiment, entity_id)).source_bundle == formatted


@pytest.mark.asyncio
async def test_generic_upsert_keeps_experiment_bundle_immutable(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    source_bundle = bundle()
    entity = Experiment(name="Existing", source_bundle=source_bundle, user_id=owner.id)
    db_session.add(entity)
    await db_session.commit()

    metadata = await client.post(
        "/experiment/upsert",
        headers=headers,
        json=[{"id": entity.id, "name": "Renamed", "source_bundle": source_bundle}],
    )
    assert metadata.status_code == 200

    changed = await client.post(
        "/experiment/upsert",
        headers=headers,
        json=[{"id": entity.id, "name": "Renamed", "source_bundle": bundle("changed")}],
    )
    assert changed.status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize(("path", "model"), (("structure", Structure), ("experiment", Experiment)))
async def test_delete_reparents_children_to_surviving_ancestor(client, db_session, monkeypatch, path, model):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)

    def create(name, parent_id=None):
        source = {"code": name} if model is Structure else {"source_bundle": bundle(name)}
        return model(name=name, user_id=owner.id, parent_id=parent_id, **source)

    root = create("Root")
    db_session.add(root)
    await db_session.flush()
    middle = create("Middle", root.id)
    db_session.add(middle)
    await db_session.flush()
    leaf = create("Leaf", middle.id)
    db_session.add(leaf)
    await db_session.flush()
    child = create("Child", leaf.id)
    db_session.add(child)
    await db_session.commit()

    response = await client.request("DELETE", f"/{path}/", headers=headers, json=[middle.id, leaf.id])
    assert response.status_code == 200
    await db_session.refresh(child)
    assert child.parent_id == root.id
