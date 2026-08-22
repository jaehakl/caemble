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


def experiment_row(user, name: str, key: str, bundle: dict, version: tuple[int, int, int] = (0, 1, 0)):
    return Experiment(
        user_id=user.id,
        namespace=user.experiment_namespace,
        repository_slug="tests",
        experiment_key=key,
        version_major=version[0],
        version_minor=version[1],
        version_patch=version[2],
        name=name,
        source_bundle=bundle,
        source_hash=source_hash(bundle),
    )


@pytest.mark.asyncio
async def test_measurements_list_by_experiment_without_pair_contract(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    first_bundle = experiment_source_bundle("first")
    second_bundle = experiment_source_bundle("second")
    first = experiment_row(owner, "First", "first", first_bundle)
    second = experiment_row(owner, "Second", "second", second_bundle)
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
async def test_experiment_versions_replace_parent_lineage(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    root_bundle = experiment_source_bundle("root")
    child_bundle = experiment_source_bundle("child")
    root = experiment_row(owner, "Root", "lineage", root_bundle)
    db_session.add(root)
    await db_session.flush()
    child = experiment_row(owner, "Child", "lineage", child_bundle, (0, 2, 0))
    db_session.add(child)
    await db_session.commit()

    assert (await client.post("/experiment/history", headers=auth_headers(owner), json={"id": child.id})).status_code == 404
    response = await client.get(f"/experiment/{child.id}/versions", headers=auth_headers(owner))
    assert response.status_code == 200
    assert [item["id"] for item in response.json()["items"]] == [child.id, root.id]
