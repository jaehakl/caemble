import hashlib

import pytest
from sqlalchemy import func, select

from db import Experiment, Structure
from settings import settings
from tests.helpers import auth_headers, create_user


def code_hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


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


def experiment_save_payload(code: str, semantic_hash: str, simulation_code: str, **extra):
    return save_payload(
        code,
        semantic_hash,
        simulationCode=simulation_code,
        simulationRawCodeHash=code_hash(simulation_code),
        **extra,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(("path", "model"), (("structure", Structure), ("experiment", Experiment)))
async def test_save_updates_minor_changes_and_forks_structural_changes(
    client,
    db_session,
    monkeypatch,
    path,
    model,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    first_code = "export default 1;"
    simulation_code = "async def simulate(*, sim, tasks, vars, world):\n    return None\n"
    created = await client.post(
        f"/{path}/save",
        headers=headers,
        json=(
            experiment_save_payload(first_code, "1" * 64, simulation_code)
            if path == "experiment"
            else save_payload(first_code, "1" * 64)
        ),
    )
    assert created.status_code == 200
    assert created.json()["action"] == "created"
    entity_id = created.json()["id"]

    formatted_code = "export default 1\n"
    updated = await client.post(
        f"/{path}/save",
        headers=headers,
        json=(
            experiment_save_payload(
                formatted_code,
                "1" * 64,
                simulation_code,
                id=entity_id,
                baseRawCodeHash=code_hash(first_code),
                baseSemanticHash="1" * 64,
                baseSimulationRawCodeHash=code_hash(simulation_code),
            )
            if path == "experiment"
            else save_payload(
                formatted_code,
                "1" * 64,
                id=entity_id,
                baseRawCodeHash=code_hash(first_code),
                baseSemanticHash="1" * 64,
            )
        ),
    )
    assert updated.status_code == 200
    assert updated.json() == {"id": entity_id, "action": "updated", "parentId": None}
    assert (await db_session.get(model, entity_id)).code == formatted_code

    changed_code = "export default 2;"
    forked = await client.post(
        f"/{path}/save",
        headers=headers,
        json=(
            experiment_save_payload(
                changed_code,
                "2" * 64,
                simulation_code,
                id=entity_id,
                baseRawCodeHash=code_hash(formatted_code),
                baseSemanticHash="1" * 64,
                baseSimulationRawCodeHash=code_hash(simulation_code),
            )
            if path == "experiment"
            else save_payload(
                changed_code,
                "2" * 64,
                id=entity_id,
                baseRawCodeHash=code_hash(formatted_code),
                baseSemanticHash="1" * 64,
            )
        ),
    )
    assert forked.status_code == 200
    assert forked.json()["action"] == "forked"
    child = await db_session.get(model, forked.json()["id"])
    assert child.parent_id == entity_id
    assert child.user_id == owner.id
    assert (await db_session.get(model, entity_id)).code == formatted_code

    grandchild_code = "export default 3;"
    grandchild = await client.post(
        f"/{path}/save",
        headers=headers,
        json=(
            experiment_save_payload(
                grandchild_code,
                "3" * 64,
                simulation_code,
                id=child.id,
                baseRawCodeHash=code_hash(changed_code),
                baseSemanticHash="2" * 64,
                baseSimulationRawCodeHash=code_hash(simulation_code),
            )
            if path == "experiment"
            else save_payload(
                grandchild_code,
                "3" * 64,
                id=child.id,
                baseRawCodeHash=code_hash(changed_code),
                baseSemanticHash="2" * 64,
            )
        ),
    )
    assert grandchild.status_code == 200
    grandchild_entity = await db_session.get(model, grandchild.json()["id"])
    assert grandchild_entity.parent_id == child.id


@pytest.mark.asyncio
async def test_experiment_save_forks_python_only_change_and_rejects_stale_python_hash(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    code = "export default experiment({});"
    first_python = "async def simulate(*, sim, tasks, vars, world):\n    return None\n"
    second_python = "async def simulate(*, sim, tasks, vars, world):\n    return await sim.random()\n"

    mismatched = experiment_save_payload(code, "1" * 64, first_python)
    mismatched["simulationRawCodeHash"] = "0" * 64
    rejected = await client.post("/experiment/save", headers=headers, json=mismatched)
    assert rejected.status_code == 400
    assert (
        await db_session.scalar(select(func.count()).select_from(Experiment).where(Experiment.user_id == owner.id))
        == 0
    )

    created = await client.post(
        "/experiment/save",
        headers=headers,
        json=experiment_save_payload(code, "1" * 64, first_python),
    )
    assert created.status_code == 200
    entity_id = created.json()["id"]

    stale = await client.post(
        "/experiment/save",
        headers=headers,
        json=experiment_save_payload(
            code,
            "1" * 64,
            second_python,
            id=entity_id,
            baseRawCodeHash=code_hash(code),
            baseSemanticHash="1" * 64,
            baseSimulationRawCodeHash=code_hash("stale"),
        ),
    )
    assert stale.status_code == 409

    forked = await client.post(
        "/experiment/save",
        headers=headers,
        json=experiment_save_payload(
            code,
            "1" * 64,
            second_python,
            id=entity_id,
            baseRawCodeHash=code_hash(code),
            baseSemanticHash="1" * 64,
            baseSimulationRawCodeHash=code_hash(first_python),
        ),
    )
    assert forked.status_code == 200
    assert forked.json()["action"] == "forked"
    child = await db_session.get(Experiment, forked.json()["id"])
    assert child.parent_id == entity_id
    assert child.simulation_code == second_python
    assert (await db_session.get(Experiment, entity_id)).simulation_code == first_python


@pytest.mark.asyncio
async def test_generic_upsert_rejects_code_changes_and_save_rejects_stale_hash(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    entity = Structure(name="Existing", code="old", user_id=owner.id)
    db_session.add(entity)
    await db_session.commit()

    generic = await client.post("/structure/upsert", headers=headers, json=[{
        "id": entity.id,
        "name": entity.name,
        "code": "new",
    }])
    assert generic.status_code == 409

    metadata_only = await client.post("/structure/upsert", headers=headers, json=[{
        "id": entity.id,
        "name": "Renamed",
        "description": "metadata only",
        "code": "old",
    }])
    assert metadata_only.status_code == 200
    await db_session.refresh(entity)
    assert entity.name == "Renamed"

    stale = await client.post("/structure/save", headers=headers, json=save_payload(
        "new",
        "2" * 64,
        id=entity.id,
        baseRawCodeHash=code_hash("not old"),
        baseSemanticHash="1" * 64,
    ))
    assert stale.status_code == 409


@pytest.mark.asyncio
async def test_experiment_metadata_upsert_preserves_or_rejects_python_source(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    simulation_code = "async def simulate(*, sim, tasks, vars, world):\n    return None\n"
    entity = Experiment(
        name="Existing",
        code="experiment source",
        simulation_code=simulation_code,
        user_id=owner.id,
    )
    db_session.add(entity)
    await db_session.commit()

    metadata_only = await client.post(
        "/experiment/upsert",
        headers=headers,
        json=[{"id": entity.id, "name": "Renamed", "code": entity.code}],
    )
    assert metadata_only.status_code == 200
    await db_session.refresh(entity)
    assert entity.simulation_code == simulation_code

    changed = await client.post(
        "/experiment/upsert",
        headers=headers,
        json=[
            {
                "id": entity.id,
                "name": entity.name,
                "code": entity.code,
                "simulation_code": f"{simulation_code}# changed\n",
            }
        ],
    )
    assert changed.status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize(("path", "model"), (("structure", Structure), ("experiment", Experiment)))
async def test_code_entity_delete_reparents_children_to_closest_surviving_ancestor(
    client,
    db_session,
    monkeypatch,
    path,
    model,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)
    root = model(name="Root", code="root", user_id=owner.id)
    db_session.add(root)
    await db_session.flush()
    middle = model(name="Middle", code="middle", user_id=owner.id, parent_id=root.id)
    db_session.add(middle)
    await db_session.flush()
    leaf = model(name="Leaf", code="leaf", user_id=owner.id, parent_id=middle.id)
    db_session.add(leaf)
    await db_session.flush()
    child = model(name="Child", code="child", user_id=owner.id, parent_id=leaf.id)
    db_session.add(child)
    await db_session.commit()

    response = await client.request(
        "DELETE",
        f"/{path}/",
        headers=headers,
        json=[middle.id, leaf.id],
    )

    assert response.status_code == 200
    await db_session.refresh(child)
    assert child.parent_id == root.id
    assert await db_session.get(model, middle.id) is None
    assert await db_session.get(model, leaf.id) is None
