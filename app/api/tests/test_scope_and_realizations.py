import pytest
from sqlalchemy import select

from db import Experiment, Sample, Setup, Structure
from settings import settings
from tests.helpers import auth_headers, create_user


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
async def test_visible_mine_public_scopes_and_realization_ownership(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    public_structure = Structure(name="Public", code="public", user_id=None)
    owner_structure = Structure(name="Mine", code="mine", user_id=owner.id)
    other_structure = Structure(name="Other", code="other", user_id=other.id)
    owner_experiment = Experiment(name="Experiment", code="experiment", user_id=owner.id)
    other_experiment = Experiment(name="Other experiment", code="other experiment", user_id=other.id)
    db_session.add_all([public_structure, owner_structure, other_structure, owner_experiment, other_experiment])
    await db_session.commit()

    anonymous = await client.post("/structure/list", json=list_payload())
    assert anonymous.status_code == 200
    assert {item["name"] for item in anonymous.json()["items"]} == {"Public"}
    assert (await client.post("/structure/list", json=list_payload("mine"))).status_code == 401

    headers = auth_headers(owner)
    visible = await client.post("/structure/list", json=list_payload(), headers=headers)
    assert {item["name"] for item in visible.json()["items"]} == {"Public", "Mine"}
    mine = await client.post("/structure/list", json=list_payload("mine"), headers=headers)
    assert {item["name"] for item in mine.json()["items"]} == {"Mine"}
    public = await client.post("/structure/list", json=list_payload("public"), headers=headers)
    assert {item["name"] for item in public.json()["items"]} == {"Public"}

    sample_response = await client.post("/sample/upsert", headers=headers, json=[{
        "structure_id": owner_structure.id,
        "vars": {"size": [1, 2, 3]},
        "material_parameters": {},
    }])
    assert sample_response.status_code == 200
    sample = await db_session.get(Sample, sample_response.json()[0]["id"])
    assert sample.user_id == owner.id
    assert sample.material_parameters == {}
    assert sample.vars == {"size": [1, 2, 3]}

    forbidden_sample = await client.post("/sample/upsert", headers=headers, json=[{
        "structure_id": other_structure.id,
        "vars": {},
        "material_parameters": {},
    }])
    assert forbidden_sample.status_code == 404

    setup_response = await client.post("/setup/upsert", headers=headers, json=[{
        "experiment_id": owner_experiment.id,
        "vars": {"voltage": 1},
        "material_parameters": {"schemaVersion": 1, "materials": {}},
    }])
    assert setup_response.status_code == 200
    setup = await db_session.get(Setup, setup_response.json()[0]["id"])
    assert setup.user_id == owner.id
    assert setup.vars == {"voltage": 1}
    assert setup.material_parameters == {"schemaVersion": 1, "materials": {}}
    forbidden_setup = await client.post("/setup/upsert", headers=headers, json=[{
        "experiment_id": other_experiment.id,
        "vars": {},
        "material_parameters": {},
    }])
    assert forbidden_setup.status_code == 404

    sample_rows = await client.post("/sample/list", json=list_payload("mine"), headers=headers)
    setup_rows = await client.post("/setup/list", json=list_payload("mine"), headers=headers)
    assert [item["id"] for item in sample_rows.json()["items"]] == [sample.id]
    assert [item["id"] for item in setup_rows.json()["items"]] == [setup.id]
    assert await db_session.scalar(select(Sample.id).where(Sample.id == sample.id)) == sample.id
