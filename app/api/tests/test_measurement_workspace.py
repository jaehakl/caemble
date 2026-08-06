import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from db import Experiment, Measurement, RecordedData, Sample, Setup, Structure
from settings import settings
from tests.helpers import auth_headers, create_user


async def create_measurement_graph(db_session, user_id):
    structure = Structure(name="Structure", code="structure", user_id=user_id)
    experiment = Experiment(name="Experiment", code="experiment", user_id=user_id)
    db_session.add_all([structure, experiment])
    await db_session.flush()
    sample = Sample(structure_id=structure.id, user_id=user_id, vars={}, material_parameters={})
    setup = Setup(experiment_id=experiment.id, user_id=user_id, vars={}, material_parameters={})
    db_session.add_all([sample, setup])
    await db_session.flush()
    measurement = Measurement(sample_id=sample.id, setup_id=setup.id, user_id=user_id)
    db_session.add(measurement)
    await db_session.flush()
    recorded = RecordedData(
        measurement_id=measurement.id,
        user_id=user_id,
        name="Result",
        quantity_kind="Dimensionless",
        tensor_order=0,
        dtype="float64",
        data={"value": 1},
    )
    db_session.add(recorded)
    await db_session.commit()
    return sample, setup, measurement, recorded


@pytest.mark.asyncio
async def test_context_list_filters_by_structure_experiment_and_owner(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    structure = Structure(name="Structure", code="structure", user_id=owner.id)
    other_structure = Structure(name="Other structure", code="other structure", user_id=owner.id)
    experiment = Experiment(name="Experiment", code="experiment", user_id=owner.id)
    db_session.add_all([structure, other_structure, experiment])
    await db_session.flush()

    sample = Sample(structure_id=structure.id, user_id=owner.id, vars={}, material_parameters={})
    other_sample = Sample(structure_id=structure.id, user_id=other.id, vars={}, material_parameters={})
    unrelated_sample = Sample(structure_id=other_structure.id, user_id=owner.id, vars={}, material_parameters={})
    setup = Setup(experiment_id=experiment.id, user_id=owner.id, vars={}, material_parameters={})
    other_setup = Setup(experiment_id=experiment.id, user_id=other.id, vars={}, material_parameters={})
    db_session.add_all([sample, other_sample, unrelated_sample, setup, other_setup])
    await db_session.flush()

    expected = Measurement(sample_id=sample.id, setup_id=setup.id, user_id=owner.id)
    hidden_owner = Measurement(sample_id=other_sample.id, setup_id=other_setup.id, user_id=other.id)
    unrelated = Measurement(sample_id=unrelated_sample.id, setup_id=setup.id, user_id=owner.id)
    db_session.add_all([expected, hidden_owner, unrelated])
    await db_session.commit()

    response = await client.post(
        "/measurement/context-list",
        headers=auth_headers(owner),
        json={"structure_id": structure.id, "experiment_id": experiment.id},
    )

    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert [item["id"] for item in response.json()["items"]] == [expected.id]


@pytest.mark.asyncio
async def test_save_measurement_persists_inline_recorded_data_atomically(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    structure = Structure(name="Structure", code="structure", user_id=owner.id)
    experiment = Experiment(name="Experiment", code="experiment", user_id=owner.id)
    db_session.add_all([structure, experiment])
    await db_session.flush()
    sample = Sample(
        structure_id=structure.id,
        user_id=owner.id,
        vars={"width": 3},
        material_parameters={},
    )
    setup = Setup(
        experiment_id=experiment.id,
        user_id=owner.id,
        vars={"voltage": 5},
        material_parameters={},
    )
    db_session.add_all([sample, setup])
    await db_session.commit()

    response = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    "name": "Current",
                    "quantity_kind": "ElectricCurrent",
                    "tensor_order": 0,
                    "dtype": "float64",
                    "data": {"value": 2.5, "axes": []},
                }
            ],
        },
    )

    assert response.status_code == 200
    measurement = await db_session.get(Measurement, response.json()["id"])
    assert measurement is not None
    assert measurement.user_id == owner.id
    assert (measurement.sample_id, measurement.setup_id) == (sample.id, setup.id)
    recorded = await db_session.scalar(
        select(RecordedData).where(RecordedData.measurement_id == measurement.id)
    )
    assert recorded is not None
    assert recorded.user_id == owner.id
    assert recorded.data == {"value": 2.5, "axes": []}
    assert recorded.data_url is None
    assert recorded.file_size is None
    measurement_id = measurement.id
    sample_id = sample.id
    setup_id = setup.id
    created_at = measurement.created_at
    recorded_id = recorded.id

    replacement_response = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    "name": "Voltage",
                    "quantity_kind": "ElectricPotential",
                    "tensor_order": 0,
                    "dtype": "float64",
                    "data": {"value": 5.0},
                }
            ],
        },
    )

    assert replacement_response.status_code == 200
    assert replacement_response.json()["id"] == measurement_id
    db_session.expire_all()
    replaced_measurement = await db_session.get(Measurement, measurement_id)
    assert replaced_measurement is not None
    assert replaced_measurement.created_at == created_at
    assert (
        await db_session.scalar(
            select(func.count(Measurement.id)).where(
                Measurement.sample_id == sample_id,
                Measurement.setup_id == setup_id,
            )
        )
        == 1
    )
    replacement_rows = list(
        (
            await db_session.scalars(
                select(RecordedData).where(
                    RecordedData.measurement_id == measurement_id
                )
            )
        ).all()
    )
    assert len(replacement_rows) == 1
    assert replacement_rows[0].id != recorded_id
    assert replacement_rows[0].name == "Voltage"
    assert replacement_rows[0].data == {"value": 5.0}


@pytest.mark.asyncio
async def test_save_measurement_rejects_foreign_realizations(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    structure = Structure(name="Structure", code="structure", user_id=other.id)
    experiment = Experiment(name="Experiment", code="experiment", user_id=other.id)
    db_session.add_all([structure, experiment])
    await db_session.flush()
    sample = Sample(structure_id=structure.id, user_id=other.id, vars={}, material_parameters={})
    setup = Setup(experiment_id=experiment.id, user_id=other.id, vars={}, material_parameters={})
    db_session.add_all([sample, setup])
    await db_session.commit()
    measurement_count = await db_session.scalar(select(func.count(Measurement.id)))

    response = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={"sample_id": sample.id, "setup_id": setup.id, "recorded_data": []},
    )

    assert response.status_code == 404
    assert await db_session.scalar(select(func.count(Measurement.id))) == measurement_count


@pytest.mark.asyncio
async def test_save_measurement_rolls_back_when_result_commit_fails(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    structure = Structure(name="Structure", code="structure", user_id=owner.id)
    experiment = Experiment(name="Experiment", code="experiment", user_id=owner.id)
    db_session.add_all([structure, experiment])
    await db_session.flush()
    sample = Sample(structure_id=structure.id, user_id=owner.id, vars={}, material_parameters={})
    setup = Setup(experiment_id=experiment.id, user_id=owner.id, vars={}, material_parameters={})
    db_session.add_all([sample, setup])
    await db_session.commit()
    initial_response = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    "name": "Original",
                    "quantity_kind": "Dimensionless",
                    "tensor_order": 0,
                    "dtype": "float64",
                    "data": {"value": 0},
                }
            ],
        },
    )
    assert initial_response.status_code == 200
    measurement_id = initial_response.json()["id"]
    measurement_count = await db_session.scalar(select(func.count(Measurement.id)))
    recorded_data_count = await db_session.scalar(select(func.count(RecordedData.id)))

    async def fail_commit():
        raise IntegrityError("commit measurement", {}, RuntimeError("forced failure"))

    monkeypatch.setattr(db_session, "commit", fail_commit)
    response = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    "name": "Result",
                    "quantity_kind": "Dimensionless",
                    "tensor_order": 0,
                    "dtype": "float64",
                    "data": {"value": 1},
                }
            ],
        },
    )

    assert response.status_code == 409
    assert await db_session.scalar(select(func.count(Measurement.id))) == measurement_count
    assert await db_session.scalar(select(func.count(RecordedData.id))) == recorded_data_count
    db_session.expire_all()
    persisted_rows = list(
        (
            await db_session.scalars(
                select(RecordedData).where(
                    RecordedData.measurement_id == measurement_id
                )
            )
        ).all()
    )
    assert len(persisted_rows) == 1
    assert persisted_rows[0].name == "Original"
    assert persisted_rows[0].data == {"value": 0}


@pytest.mark.asyncio
async def test_delete_sample_cascades_measurement_and_recorded_data(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    sample, setup, measurement, recorded = await create_measurement_graph(db_session, owner.id)
    sample_id, setup_id, measurement_id, recorded_id = sample.id, setup.id, measurement.id, recorded.id

    response = await client.request(
        "DELETE",
        "/sample/",
        headers=auth_headers(owner),
        json=[sample_id],
    )

    assert response.status_code == 200
    db_session.expire_all()
    assert await db_session.get(Sample, sample_id) is None
    assert await db_session.get(Setup, setup_id) is not None
    assert await db_session.get(Measurement, measurement_id) is None
    assert await db_session.get(RecordedData, recorded_id) is None


@pytest.mark.asyncio
async def test_delete_setup_cascades_measurement_and_recorded_data(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    sample, setup, measurement, recorded = await create_measurement_graph(db_session, owner.id)
    sample_id, setup_id, measurement_id, recorded_id = sample.id, setup.id, measurement.id, recorded.id

    response = await client.request(
        "DELETE",
        "/setup/",
        headers=auth_headers(owner),
        json=[setup_id],
    )

    assert response.status_code == 200
    db_session.expire_all()
    assert await db_session.get(Sample, sample_id) is not None
    assert await db_session.get(Setup, setup_id) is None
    assert await db_session.get(Measurement, measurement_id) is None
    assert await db_session.get(RecordedData, recorded_id) is None


@pytest.mark.asyncio
async def test_delete_measurement_keeps_sample_and_setup(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    sample, setup, measurement, recorded = await create_measurement_graph(db_session, owner.id)
    sample_id, setup_id, measurement_id, recorded_id = sample.id, setup.id, measurement.id, recorded.id

    response = await client.request(
        "DELETE",
        "/measurement/",
        headers=auth_headers(owner),
        json=[measurement_id],
    )

    assert response.status_code == 200
    db_session.expire_all()
    assert await db_session.get(Sample, sample_id) is not None
    assert await db_session.get(Setup, setup_id) is not None
    assert await db_session.get(Measurement, measurement_id) is None
    assert await db_session.get(RecordedData, recorded_id) is None


@pytest.mark.asyncio
async def test_delete_realizations_and_measurement_rejects_foreign_owner(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)
    sample, setup, measurement, recorded = await create_measurement_graph(db_session, other.id)

    for path, item_id in (
        ("/sample/", sample.id),
        ("/setup/", setup.id),
        ("/measurement/", measurement.id),
    ):
        response = await client.request(
            "DELETE",
            path,
            headers=auth_headers(owner),
            json=[item_id],
        )
        assert response.status_code == 404

    assert await db_session.get(Sample, sample.id) is not None
    assert await db_session.get(Setup, setup.id) is not None
    assert await db_session.get(Measurement, measurement.id) is not None
    assert await db_session.get(RecordedData, recorded.id) is not None
