import hashlib
import json

import pytest

from db import DesignerModel, Experiment, PredictorModel
from settings import settings
from tests.helpers import auth_headers, create_user, experiment_source_bundle

pytestmark = pytest.mark.slow


def bundle_hash(bundle: dict) -> str:
    value = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def list_payload(scope="visible"):
    return {
        "scope": scope,
        "offset": 0,
        "limit": None,
        "selected_ids": [],
        "search_text": None,
        "text_filter": {},
        "filter": {},
        "sort": ["updated_at", "desc"],
    }


def experiment_row(user, name: str, key: str, bundle: dict) -> Experiment:
    return Experiment(
        user_id=user.id,
        namespace=user.experiment_namespace,
        repository_slug="tests",
        experiment_key=key,
        version_major=0,
        version_minor=1,
        version_patch=0,
        name=name,
        source_bundle=bundle,
        source_hash=bundle_hash(bundle),
    )


@pytest.mark.asyncio
async def test_experiment_visibility_and_removed_split_endpoints(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    mine_bundle = experiment_source_bundle("mine")
    other_bundle = experiment_source_bundle("other")
    db_session.add_all(
        [
            experiment_row(owner, "Mine", "mine", mine_bundle),
            experiment_row(other, "Other", "other", other_bundle),
        ]
    )
    await db_session.commit()

    assert (await client.post("/experiment/list", json=list_payload())).json()["items"] == []
    headers = auth_headers(owner)
    visible = await client.post("/experiment/list", headers=headers, json=list_payload())
    assert {item["name"] for item in visible.json()["items"]} == {"Mine"}
    assert all(len(item["source_hash"]) == 64 for item in visible.json()["items"])

    for endpoint in ("structure", "sample", "setup"):
        assert (await client.post(f"/{endpoint}/list", headers=headers, json=list_payload())).status_code == 404


@pytest.mark.asyncio
async def test_model_artifacts_are_scoped_only_by_experiment(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    mine_bundle = experiment_source_bundle("mine")
    target_bundle = experiment_source_bundle("target")
    other_bundle = experiment_source_bundle("other")
    mine = experiment_row(owner, "Mine", "mine-model", mine_bundle)
    target = experiment_row(owner, "Target", "target-model", target_bundle)
    hidden = experiment_row(other, "Hidden", "hidden-model", other_bundle)
    db_session.add_all([mine, target, hidden])
    await db_session.commit()
    headers = auth_headers(owner)

    designer = await client.post(
        "/designer_model/upsert",
        headers=headers,
        json=[{"experiment_id": mine.id, "model_url": "designer.bin"}],
    )
    predictor = await client.post(
        "/predictor_model/upsert",
        headers=headers,
        json=[{"experiment_id": mine.id, "model_url": "predictor.bin"}],
    )
    assert designer.status_code == predictor.status_code == 200
    assert (await db_session.get(DesignerModel, designer.json()[0]["id"])).experiment_id == mine.id
    assert (await db_session.get(PredictorModel, predictor.json()[0]["id"])).experiment_id == mine.id

    for endpoint, response in (("designer_model", designer), ("predictor_model", predictor)):
        reparented = await client.post(
            f"/{endpoint}/upsert",
            headers=headers,
            json=[
                {
                    "id": response.json()[0]["id"],
                    "experiment_id": target.id,
                    "model_url": "moved.bin",
                }
            ],
        )
        assert reparented.status_code == 409
        assert "experiment_id cannot be changed" in reparented.json()["detail"]
    mine_id = mine.id
    hidden_id = hidden.id
    db_session.expire_all()
    assert (await db_session.get(DesignerModel, designer.json()[0]["id"])).experiment_id == mine_id
    assert (await db_session.get(PredictorModel, predictor.json()[0]["id"])).experiment_id == mine_id

    forbidden = await client.post(
        "/designer_model/upsert",
        headers=headers,
        json=[{"experiment_id": hidden_id}],
    )
    assert forbidden.status_code == 404
