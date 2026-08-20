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


@pytest.mark.asyncio
async def test_experiment_visibility_and_removed_split_endpoints(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    public_bundle = experiment_source_bundle("public")
    mine_bundle = experiment_source_bundle("mine")
    other_bundle = experiment_source_bundle("other")
    db_session.add_all(
        [
            Experiment(name="Public", source_bundle=public_bundle, source_hash=bundle_hash(public_bundle), user_id=None),
            Experiment(name="Mine", source_bundle=mine_bundle, source_hash=bundle_hash(mine_bundle), user_id=owner.id),
            Experiment(name="Other", source_bundle=other_bundle, source_hash=bundle_hash(other_bundle), user_id=other.id),
        ]
    )
    await db_session.commit()

    assert {item["name"] for item in (await client.post("/experiment/list", json=list_payload())).json()["items"]} == {"Public"}
    headers = auth_headers(owner)
    visible = await client.post("/experiment/list", headers=headers, json=list_payload())
    assert {item["name"] for item in visible.json()["items"]} == {"Public", "Mine"}
    assert all(len(item["source_hash"]) == 64 for item in visible.json()["items"])

    for endpoint in ("structure", "sample", "setup"):
        assert (await client.post(f"/{endpoint}/list", headers=headers, json=list_payload())).status_code == 404


@pytest.mark.asyncio
async def test_model_artifacts_are_scoped_only_by_experiment(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    mine_bundle = experiment_source_bundle("mine")
    other_bundle = experiment_source_bundle("other")
    mine = Experiment(name="Mine", source_bundle=mine_bundle, source_hash=bundle_hash(mine_bundle), user_id=owner.id)
    hidden = Experiment(name="Hidden", source_bundle=other_bundle, source_hash=bundle_hash(other_bundle), user_id=other.id)
    db_session.add_all([mine, hidden])
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

    forbidden = await client.post(
        "/designer_model/upsert",
        headers=headers,
        json=[{"experiment_id": hidden.id}],
    )
    assert forbidden.status_code == 404
