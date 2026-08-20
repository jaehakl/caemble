import hashlib
import json

import pytest

from db import Experiment, Measurement
from settings import settings
from tests.helpers import auth_headers, create_user, experiment_source_bundle

pytestmark = pytest.mark.slow


def source_hash(bundle):
    value = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def list_payload(**extra):
    return {
        "scope": "visible",
        "offset": 0,
        "limit": None,
        "selected_ids": [],
        "search_text": None,
        "text_filter": {},
        "filter": {},
        "sort": ["updated_at", "desc"],
        **extra,
    }


@pytest.mark.asyncio
async def test_measurements_list_by_experiment_without_pair_contract(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    first_bundle = experiment_source_bundle("first")
    second_bundle = experiment_source_bundle("second")
    first = Experiment(name="First", source_bundle=first_bundle, source_hash=source_hash(first_bundle), user_id=owner.id)
    second = Experiment(name="Second", source_bundle=second_bundle, source_hash=source_hash(second_bundle), user_id=owner.id)
    db_session.add_all([first, second])
    await db_session.flush()
    db_session.add_all(
        [
            Measurement(user_id=owner.id, experiment_id=first.id, vars={"n": 1}, material_parameters={"schemaVersion": 2, "experiment": {"schemaVersion": 1, "materials": {}}, "tasks": {"main": {"schemaVersion": 1, "materials": {}}}}),
            Measurement(user_id=owner.id, experiment_id=first.id, vars={"n": 2}, material_parameters={"schemaVersion": 2, "experiment": {"schemaVersion": 1, "materials": {}}, "tasks": {"main": {"schemaVersion": 1, "materials": {}}}}),
            Measurement(user_id=owner.id, experiment_id=second.id, vars={"n": 3}, material_parameters={"schemaVersion": 2, "experiment": {"schemaVersion": 1, "materials": {}}, "tasks": {"main": {"schemaVersion": 1, "materials": {}}}}),
        ]
    )
    await db_session.commit()
    headers = auth_headers(owner)

    response = await client.post(
        "/measurement/list",
        headers=headers,
        json=list_payload(filter={"experiment_id": [first.id, first.id]}),
    )
    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert {row["vars"]["n"] for row in response.json()["items"]} == {1, 2}
    assert (await client.post("/measurement/context-list", headers=headers, json={})).status_code == 404
    assert (await client.post("/measurement/pair-list", headers=headers, json={})).status_code == 404


@pytest.mark.asyncio
async def test_experiment_history_remains_single_unified_lineage(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    root_bundle = experiment_source_bundle("root")
    child_bundle = experiment_source_bundle("child")
    root = Experiment(name="Root", source_bundle=root_bundle, source_hash=source_hash(root_bundle), user_id=owner.id)
    db_session.add(root)
    await db_session.flush()
    child = Experiment(
        name="Child",
        parent_id=root.id,
        source_bundle=child_bundle,
        source_hash=source_hash(child_bundle),
        user_id=owner.id,
    )
    db_session.add(child)
    await db_session.commit()

    response = await client.post(
        "/experiment/history",
        headers=auth_headers(owner),
        json={"id": child.id},
    )
    assert response.status_code == 200
    assert response.json()["root_id"] == root.id
    assert [item["id"] for item in response.json()["items"]] == [root.id, child.id]
