from datetime import datetime, timezone

import pytest

from db import Experiment, Measurement, Sample, Setup, Structure
from settings import settings
from tests.helpers import auth_headers, create_user, experiment_source_bundle


async def add_measurement(
    db_session,
    user_id,
    structure,
    experiment,
    measured_at,
):
    sample = Sample(
        structure_id=structure.id,
        user_id=user_id,
        vars={},
        material_parameters={},
    )
    setup = Setup(
        experiment_id=experiment.id,
        user_id=user_id,
        vars={},
        material_parameters={},
    )
    db_session.add_all([sample, setup])
    await db_session.flush()
    measurement = Measurement(
        sample_id=sample.id,
        setup_id=setup.id,
        user_id=user_id,
        created_at=measured_at,
        updated_at=measured_at,
    )
    db_session.add(measurement)
    await db_session.flush()
    return measurement


@pytest.mark.asyncio
async def test_pair_list_aggregates_owned_measurements_and_supports_workbench_queries(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    admin = await create_user(db_session, "admin")
    alpha = Structure(
        name="Alpha",
        description="primary structure",
        code="alpha",
        user_id=owner.id,
    )
    beta = Structure(name="Beta", code="beta", user_id=owner.id)
    public = Structure(name="Public", code="public", user_id=None)
    hidden = Structure(name="Hidden", code="hidden", user_id=other.id)
    thermal = Experiment(
        name="Thermal",
        description="heat study",
        source_bundle=experiment_source_bundle("thermal"),
        user_id=owner.id,
    )
    modal = Experiment(
        name="Modal",
        description="needle experiment",
        source_bundle=experiment_source_bundle("modal"),
        user_id=owner.id,
    )
    hidden_experiment = Experiment(
        name="Hidden experiment",
        source_bundle=experiment_source_bundle("hidden"),
        user_id=other.id,
    )
    db_session.add_all(
        [alpha, beta, public, hidden, thermal, modal, hidden_experiment]
    )
    await db_session.flush()

    measured_at = [
        datetime(2026, 1, day, tzinfo=timezone.utc)
        for day in range(1, 7)
    ]
    first = await add_measurement(
        db_session,
        owner.id,
        alpha,
        thermal,
        measured_at[0],
    )
    latest = await add_measurement(
        db_session,
        owner.id,
        alpha,
        thermal,
        measured_at[1],
    )
    await add_measurement(db_session, owner.id, alpha, modal, measured_at[2])
    await add_measurement(db_session, owner.id, beta, thermal, measured_at[3])
    await add_measurement(db_session, owner.id, public, thermal, measured_at[4])
    await add_measurement(
        db_session,
        other.id,
        hidden,
        hidden_experiment,
        measured_at[5],
    )
    await db_session.commit()

    response = await client.post(
        "/measurement/pair-list",
        headers=auth_headers(owner),
        json={"limit": 1, "sort": ["measurement_count", "desc"]},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 4
    assert len(payload["items"]) == 1
    summary = payload["items"][0]
    assert summary == {
        "structure_id": alpha.id,
        "structure_name": "Alpha",
        "structure_description": "primary structure",
        "structure_user_id": owner.id,
        "experiment_id": thermal.id,
        "experiment_name": "Thermal",
        "experiment_description": "heat study",
        "experiment_user_id": owner.id,
        "measurement_count": 2,
        "latest_measurement_id": latest.id,
        "latest_measurement_at": "2026-01-02T00:00:00Z",
    }
    assert first.id != latest.id

    mine_response = await client.post(
        "/measurement/pair-list",
        headers=auth_headers(owner),
        json={"structure_scope": "mine", "limit": None},
    )
    assert mine_response.status_code == 200
    assert mine_response.json()["total"] == 3

    anchor_response = await client.post(
        "/measurement/pair-list",
        headers=auth_headers(owner),
        json={
            "experiment_id": thermal.id,
            "exclude_structure_id": alpha.id,
            "limit": None,
            "sort": ["structure_name", "asc"],
        },
    )
    assert anchor_response.status_code == 200
    assert {
        item["structure_id"] for item in anchor_response.json()["items"]
    } == {beta.id, public.id}

    search_response = await client.post(
        "/measurement/pair-list",
        headers=auth_headers(owner),
        json={"search_text": "needle", "limit": None},
    )
    assert search_response.status_code == 200
    assert search_response.json()["total"] == 1
    assert search_response.json()["items"][0]["experiment_id"] == modal.id

    date_response = await client.post(
        "/measurement/pair-list",
        headers=auth_headers(owner),
        json={
            "structure_id": alpha.id,
            "experiment_id": thermal.id,
            "measured_from": "2026-01-02T00:00:00Z",
            "measured_to": "2026-01-02T00:00:00Z",
        },
    )
    assert date_response.status_code == 200
    assert date_response.json()["items"][0]["measurement_count"] == 1
    assert date_response.json()["items"][0]["latest_measurement_id"] == latest.id

    unauthenticated = await client.post("/measurement/pair-list", json={})
    assert unauthenticated.status_code == 401

    admin_response = await client.post(
        "/measurement/pair-list",
        headers=auth_headers(admin),
        json={"limit": None},
    )
    assert admin_response.status_code == 200
    assert admin_response.json()["total"] == 5


@pytest.mark.asyncio
async def test_context_list_adds_paging_sort_and_filter_without_changing_defaults(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    structure = Structure(name="Structure", code="structure", user_id=owner.id)
    experiment = Experiment(
        name="Experiment",
        source_bundle=experiment_source_bundle(),
        user_id=owner.id,
    )
    db_session.add_all([structure, experiment])
    await db_session.flush()
    measurements = []
    for day in range(1, 4):
        measurements.append(
            await add_measurement(
                db_session,
                owner.id,
                structure,
                experiment,
                datetime(2026, 2, day, tzinfo=timezone.utc),
            )
        )
    await db_session.commit()

    response = await client.post(
        "/measurement/context-list",
        headers=auth_headers(owner),
        json={
            "structure_id": structure.id,
            "experiment_id": experiment.id,
            "offset": 1,
            "limit": 1,
            "filter": {
                "updated_at": [
                    "2026-02-01T00:00:00Z",
                    "2026-02-03T00:00:00Z",
                ]
            },
            "sort": ["updated_at", "asc"],
        },
    )

    assert response.status_code == 200
    assert response.json()["total"] == 3
    assert [item["id"] for item in response.json()["items"]] == [measurements[1].id]

    legacy_response = await client.post(
        "/measurement/context-list",
        headers=auth_headers(owner),
        json={
            "structure_id": structure.id,
            "experiment_id": experiment.id,
        },
    )
    assert legacy_response.status_code == 200
    assert legacy_response.json()["total"] == 3
    assert [item["id"] for item in legacy_response.json()["items"]] == [
        measurements[2].id,
        measurements[1].id,
        measurements[0].id,
    ]


@pytest.mark.asyncio
async def test_history_returns_visible_connected_metadata_without_sources(
    client,
    db_session,
    monkeypatch,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)

    structure_root = Structure(name="Root", code="root", user_id=None)
    db_session.add(structure_root)
    await db_session.flush()
    structure_selected = Structure(
        name="Selected",
        code="selected",
        parent_id=structure_root.id,
        user_id=owner.id,
    )
    hidden_sibling = Structure(
        name="Hidden sibling",
        code="hidden",
        parent_id=structure_root.id,
        user_id=other.id,
    )
    db_session.add_all([structure_selected, hidden_sibling])
    await db_session.flush()
    structure_child = Structure(
        name="Child",
        code="child",
        parent_id=structure_selected.id,
        user_id=owner.id,
    )

    experiment_root = Experiment(
        name="Experiment root",
        source_bundle=experiment_source_bundle("root"),
        user_id=None,
    )
    db_session.add_all([structure_child, experiment_root])
    await db_session.flush()
    experiment_selected = Experiment(
        name="Experiment selected",
        description="metadata only",
        source_bundle=experiment_source_bundle("selected"),
        parent_id=experiment_root.id,
        user_id=owner.id,
    )
    hidden_experiment = Experiment(
        name="Hidden experiment",
        source_bundle=experiment_source_bundle("hidden"),
        parent_id=experiment_root.id,
        user_id=other.id,
    )
    db_session.add_all([experiment_selected, hidden_experiment])
    await db_session.commit()

    structure_response = await client.post(
        "/structure/history",
        headers=auth_headers(owner),
        json={"id": structure_selected.id},
    )
    assert structure_response.status_code == 200
    structure_payload = structure_response.json()
    assert structure_payload["selected_id"] == structure_selected.id
    assert structure_payload["root_id"] == structure_root.id
    assert {item["id"] for item in structure_payload["items"]} == {
        structure_root.id,
        structure_selected.id,
        structure_child.id,
    }
    assert all("code" not in item for item in structure_payload["items"])

    experiment_response = await client.post(
        "/experiment/history",
        headers=auth_headers(owner),
        json={"id": experiment_selected.id},
    )
    assert experiment_response.status_code == 200
    experiment_payload = experiment_response.json()
    assert experiment_payload["selected_id"] == experiment_selected.id
    assert experiment_payload["root_id"] == experiment_root.id
    assert {item["id"] for item in experiment_payload["items"]} == {
        experiment_root.id,
        experiment_selected.id,
    }
    assert all("source_bundle" not in item for item in experiment_payload["items"])

    hidden_response = await client.post(
        "/structure/history",
        headers=auth_headers(owner),
        json={"id": hidden_sibling.id},
    )
    assert hidden_response.status_code == 404
