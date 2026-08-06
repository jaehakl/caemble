import pytest

from tests.helpers import auth_headers, create_user
from user_auth.db import GPStationConnection


@pytest.mark.asyncio
async def test_user_can_create_replace_restore_and_delete_gpstation_connection(
    client,
    db_session,
    monkeypatch,
):
    from settings import settings

    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    other = await create_user(db_session)

    unauthenticated = await client.put(
        "/user_data/gpstation",
        json={"api_base_url": "https://gps.example.com", "access_token": "gpsk_secret"},
    )
    assert unauthenticated.status_code == 401

    created = await client.put(
        "/user_data/gpstation",
        headers=auth_headers(owner),
        json={
            "api_base_url": " https://gps.example.com/root/ ",
            "access_token": " gpsk_secret ",
        },
    )
    assert created.status_code == 200
    assert created.json()["gpstation_connection"] == {
        "api_base_url": "https://gps.example.com/root",
        "access_token": "gpsk_secret",
    }
    stored = await db_session.get(GPStationConnection, owner.id)
    assert stored is not None
    assert stored.api_base_url == "https://gps.example.com/root"
    assert stored.access_token == "gpsk_secret"

    restored = await client.get("/auth/me", headers=auth_headers(owner))
    assert restored.status_code == 200
    assert restored.json()["gpstation_connection"] == created.json()["gpstation_connection"]
    other_me = await client.get("/auth/me", headers=auth_headers(other))
    assert other_me.status_code == 200
    assert other_me.json()["gpstation_connection"] is None

    replaced = await client.put(
        "/user_data/gpstation",
        headers=auth_headers(owner),
        json={"api_base_url": "http://localhost:8000/", "access_token": "gpsk_replaced"},
    )
    assert replaced.status_code == 200
    assert replaced.json()["gpstation_connection"] == {
        "api_base_url": "http://localhost:8000",
        "access_token": "gpsk_replaced",
    }

    deleted = await client.delete("/user_data/gpstation", headers=auth_headers(owner))
    assert deleted.status_code == 200
    assert deleted.json()["gpstation_connection"] is None
    assert await db_session.get(GPStationConnection, owner.id) is None


@pytest.mark.parametrize(
    "api_base_url",
    [
        "",
        "ftp://gps.example.com",
        "https://user:password@gps.example.com",
        "https://gps.example.com?token=value",
        "https://gps.example.com/#fragment",
        "https://gps.example.com:99999",
    ],
)
@pytest.mark.asyncio
async def test_gpstation_connection_rejects_invalid_api_url(
    api_base_url,
    client,
    db_session,
    monkeypatch,
):
    from settings import settings

    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    response = await client.put(
        "/user_data/gpstation",
        headers=auth_headers(owner),
        json={"api_base_url": api_base_url, "access_token": "gpsk_secret"},
    )
    assert response.status_code == 422
    assert await db_session.get(GPStationConnection, owner.id) is None


@pytest.mark.asyncio
async def test_admin_user_responses_never_include_gpstation_secret(
    client,
    db_session,
    monkeypatch,
):
    from settings import settings

    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    admin = await create_user(db_session, "admin")
    owner = await create_user(db_session)
    secret = "gpsk_must_not_be_exposed"
    db_session.add(
        GPStationConnection(
            user_id=owner.id,
            api_base_url="https://gps.example.com",
            access_token=secret,
        )
    )
    await db_session.commit()

    users = await client.get("/user_admin/get_all_users/100/0", headers=auth_headers(admin))
    summary = await client.get(
        f"/user_data/summary/admin/{owner.id}",
        headers=auth_headers(admin),
    )
    assert users.status_code == 200
    assert summary.status_code == 200
    assert secret not in users.text
    assert secret not in summary.text
    assert all("gpstation_connection" not in item for item in users.json())
    assert "gpstation_connection" not in summary.json()


@pytest.mark.asyncio
async def test_gpstation_connection_is_deleted_with_its_user(db_session):
    owner = await create_user(db_session)
    db_session.add(
        GPStationConnection(
            user_id=owner.id,
            api_base_url="https://gps.example.com",
            access_token="gpsk_secret",
        )
    )
    await db_session.commit()

    await db_session.delete(owner)
    await db_session.commit()

    assert await db_session.get(GPStationConnection, owner.id) is None
