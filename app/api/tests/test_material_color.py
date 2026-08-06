import pytest

from db import Material
from settings import settings
from tests.helpers import auth_headers, create_user


@pytest.mark.asyncio
async def test_material_color_is_validated_and_normalized(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    owner = await create_user(db_session)
    headers = auth_headers(owner)

    response = await client.post("/material/upsert", headers=headers, json=[{"color": "#A1B2C3"}])
    assert response.status_code == 200
    material = await db_session.get(Material, response.json()[0]["id"])
    assert material.color == "#a1b2c3"

    invalid = await client.post("/material/upsert", headers=headers, json=[{"color": "blue"}])
    assert invalid.status_code == 422
