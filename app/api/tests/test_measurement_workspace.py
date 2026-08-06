import base64
import struct

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

import models as api_models
from db import Experiment, Measurement, RecordedData, Sample, Setup, Structure
from quantity_kind_catalog import QUANTITY_KIND_SOURCE_SHA256, QUANTITY_KIND_TENSOR_ORDERS
from settings import settings
from tests.helpers import auth_headers, create_user


def inline_tensor(value, shape=None):
    return {
        "tensorEncodingVersion": 1,
        "shape": [] if shape is None else shape,
        "storage": {"kind": "inline", "value": value},
    }


def test_quantity_kind_catalog_matches_the_caemble_generated_source():
    assert QUANTITY_KIND_SOURCE_SHA256 == "7f9a6ed1f2f4c2fac2b48da170afebc545faa0118c6c6c8eba6138df80ee9030"
    assert len(QUANTITY_KIND_TENSOR_ORDERS) == 1_216
    assert QUANTITY_KIND_TENSOR_ORDERS["electromagnetism.ElectricCurrentDensity"] == 1
    assert QUANTITY_KIND_TENSOR_ORDERS["mechanics.ElasticStiffnessTensor"] == 4


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
                    "quantity_kind": "electromagnetism.ElectricCurrent",
                    "tensor_order": 0,
                    "dtype": "float64",
                    "data_schema": {
                        "dtype": "float64",
                        "unit": "A",
                        "quantityKind": "electromagnetism.ElectricCurrent",
                    },
                    "data": inline_tensor(2.5),
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
    assert recorded.data_schema == {
        "dtype": "float64",
        "unit": "A",
        "quantityKind": "electromagnetism.ElectricCurrent",
    }
    assert recorded.data == inline_tensor(2.5)
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
                    "quantity_kind": "electromagnetism.ElectricPotential",
                    "tensor_order": 0,
                    "dtype": "float64",
                    "data_schema": {
                        "dtype": "float64",
                        "unit": "V",
                        "quantityKind": "electromagnetism.ElectricPotential",
                    },
                    "data": inline_tensor(5.0),
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
    assert replacement_rows[0].data == inline_tensor(5.0)


@pytest.mark.asyncio
async def test_save_measurement_validates_base64_tensor_bytes(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    sample, setup, _, _ = await create_measurement_graph(db_session, owner.id)
    raw = struct.pack("<ff", 1.5, -2.25)
    tensor = {
        "tensorEncodingVersion": 1,
        "shape": [2],
        "axes": [{"ticks": ["앞", "뒤"]}],
        "storage": {
            "kind": "base64",
            "data": base64.b64encode(raw).decode("ascii"),
            "byteLength": len(raw),
        },
    }

    response = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    "name": "Temperature",
                    "quantity_kind": "thermodynamics.Temperature",
                    "tensor_order": 0,
                    "dtype": "float32",
                    "data_schema": {
                        "dtype": "float32",
                        "unit": "K",
                        "quantityKind": "thermodynamics.Temperature",
                        "axes": [{"name": "시간", "unit": "s", "quantityKind": "Time"}],
                    },
                    "data": tensor,
                }
            ],
        },
    )

    assert response.status_code == 200
    recorded = await db_session.scalar(
        select(RecordedData).where(RecordedData.measurement_id == response.json()["id"])
    )
    assert recorded is not None
    assert recorded.data_schema == {
        "dtype": "float32",
        "unit": "K",
        "quantityKind": "thermodynamics.Temperature",
        "axes": [{"name": "시간", "unit": "s", "quantityKind": "Time"}],
    }
    assert recorded.data == tensor
    assert recorded.data_url is None
    assert recorded.file_size is None

    malformed = {
        **tensor,
        "storage": {**tensor["storage"], "byteLength": len(raw) + 1},
    }
    response = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    "name": "Temperature",
                    "quantity_kind": "thermodynamics.Temperature",
                    "tensor_order": 0,
                    "dtype": "float32",
                    "data_schema": {
                        "dtype": "float32",
                        "unit": "K",
                        "quantityKind": "thermodynamics.Temperature",
                        "axes": [{"name": "시간", "unit": "s", "quantityKind": "Time"}],
                    },
                    "data": malformed,
                }
            ],
        },
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_save_measurement_uses_catalog_order_and_persists_vector_schema(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    sample, setup, _, _ = await create_measurement_graph(db_session, owner.id)
    schema = {
        "dtype": "float32",
        "unit": "A.m-2",
        "quantityKind": "electromagnetism.ElectricCurrentDensity",
        "basis": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        "axes": [{"name": "point", "length": 2, "ticks": ["앞", "뒤"]}],
    }
    tensor = {
        "tensorEncodingVersion": 1,
        "shape": [2, 3],
        "axes": [{"ticks": ["앞", "뒤"]}],
        "storage": {"kind": "inline", "value": [[1, 2, 3], [-4, 5, -6]]},
    }
    item = {
        "name": "Current density",
        "quantity_kind": "electromagnetism.ElectricCurrentDensity",
        "tensor_order": 1,
        "dtype": "float32",
        "data_schema": schema,
        "data": tensor,
    }

    response = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={"sample_id": sample.id, "setup_id": setup.id, "recorded_data": [item]},
    )

    assert response.status_code == 200
    recorded = await db_session.scalar(
        select(RecordedData).where(RecordedData.measurement_id == response.json()["id"])
    )
    assert recorded is not None
    assert recorded.data_schema == schema
    assert recorded.tensor_order == 1

    wrong_order = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [{**item, "tensor_order": 0}],
        },
    )
    assert wrong_order.status_code == 422

    wrong_shape = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [{**item, "data": {**tensor, "shape": [2, 2]}}],
        },
    )
    assert wrong_shape.status_code == 422

    missing_basis = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    **item,
                    "data_schema": {
                        key: value
                        for key, value in schema.items()
                        if key != "basis"
                    },
                }
            ],
        },
    )
    assert missing_basis.status_code == 422

    invalid_unit = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    **item,
                    "data_schema": {**schema, "unit": "s"},
                }
            ],
        },
    )
    assert invalid_unit.status_code == 422

    mismatched_ticks = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    **item,
                    "data": {
                        **tensor,
                        "axes": [{"ticks": ["앞", "다름"]}],
                    },
                }
            ],
        },
    )
    assert mismatched_ticks.status_code == 422

    missing_dynamic_ticks = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    **item,
                    "data_schema": {
                        **schema,
                        "axes": [{"name": "point"}],
                    },
                    "data": {**tensor, "axes": [{}]},
                }
            ],
        },
    )
    assert missing_dynamic_ticks.status_code == 422


@pytest.mark.asyncio
async def test_recorded_data_list_keeps_legacy_rows_without_schema(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    _, _, measurement, recorded = await create_measurement_graph(db_session, owner.id)

    response = await client.post(
        "/recorded_data/list",
        headers=auth_headers(owner),
        json={
            "scope": "mine",
            "offset": 0,
            "limit": None,
            "selected_ids": [],
            "search_text": None,
            "text_filter": {},
            "filter": {"measurement_id": [measurement.id, measurement.id]},
            "sort": None,
            "random": False,
        },
    )

    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert response.json()["items"][0] | {
        "created_at": None,
        "updated_at": None,
    } == {
        "id": recorded.id,
        "created_at": None,
        "updated_at": None,
        "user_id": owner.id,
        "measurement_id": measurement.id,
        "name": "Result",
        "quantity_kind": "Dimensionless",
        "tensor_order": 0,
        "dtype": "float64",
        "data_schema": None,
        "data": {"value": 1},
        "data_url": None,
        "file_size": None,
    }


@pytest.mark.asyncio
async def test_save_measurement_rejects_legacy_and_aggregate_tensor_overflow(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    sample, setup, _, _ = await create_measurement_graph(db_session, owner.id)

    legacy_response = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    "name": "Legacy",
                    "quantity_kind": "Dimensionless",
                    "tensor_order": 0,
                    "dtype": "float64",
                    "data_schema": {
                        "dtype": "float64",
                        "unit": "1",
                        "quantityKind": "Dimensionless",
                    },
                    "data": {"value": 1},
                }
            ],
        },
    )
    assert legacy_response.status_code == 422

    oversized_scalar_string = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    "name": "Oversized string",
                    "quantity_kind": None,
                    "tensor_order": 0,
                    "dtype": "string",
                    "data_schema": {"dtype": "string"},
                    "data": inline_tensor("한" * 70_000),
                }
            ],
        },
    )
    assert oversized_scalar_string.status_code == 422

    monkeypatch.setattr(api_models, "MAX_RECORDED_DATA_BYTES", 8)
    raw = bytes([0, 1, 0, 1, 0])
    tensor = {
        "tensorEncodingVersion": 1,
        "shape": [5],
        "storage": {
            "kind": "base64",
            "data": base64.b64encode(raw).decode("ascii"),
            "byteLength": len(raw),
        },
    }
    overflow_response = await client.post(
        "/measurement/save",
        headers=auth_headers(owner),
        json={
            "sample_id": sample.id,
            "setup_id": setup.id,
            "recorded_data": [
                {
                    "name": name,
                    "quantity_kind": None,
                    "tensor_order": 0,
                    "dtype": "bool",
                    "data_schema": {"dtype": "bool", "axes": [{"length": 5}]},
                    "data": tensor,
                }
                for name in ("A", "B")
            ],
        },
    )
    assert overflow_response.status_code == 422


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
                    "data_schema": {
                        "dtype": "float64",
                        "unit": "1",
                        "quantityKind": "Dimensionless",
                    },
                    "data": inline_tensor(0),
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
                    "data_schema": {
                        "dtype": "float64",
                        "unit": "1",
                        "quantityKind": "Dimensionless",
                    },
                    "data": inline_tensor(1),
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
    assert persisted_rows[0].data == inline_tensor(0)


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
