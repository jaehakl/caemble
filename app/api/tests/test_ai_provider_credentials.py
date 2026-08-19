import logging

import httpx
import pytest
import pytest_asyncio
from cryptography.fernet import Fernet
from fastapi import FastAPI
from pydantic import SecretStr
from sqlalchemy import func, select

from ai.credentials import get_provider_api_key, get_provider_credential, router
from settings import settings
from tests.helpers import auth_headers, create_user
from user_auth.db import AIProviderCredential
from user_auth.routes import get_db


@pytest_asyncio.fixture
async def credential_client(db_session):
    app = FastAPI()
    app.include_router(router)

    async def override_db():
        yield db_session

    app.dependency_overrides[get_db] = override_db
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="https://testserver",
    ) as client:
        yield client


def configure_encryption(monkeypatch, *keys: bytes) -> None:
    monkeypatch.setattr(
        settings,
        "AI_CREDENTIAL_FERNET_KEYS",
        tuple(SecretStr(key.decode("ascii")) for key in keys),
    )


@pytest.mark.asyncio
async def test_provider_contract_encrypts_and_versions_credentials(
    credential_client,
    db_session,
    monkeypatch,
):
    configure_encryption(monkeypatch, Fernet.generate_key())
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    user = await create_user(db_session)
    headers = auth_headers(user)

    initial = await credential_client.get("/ai/providers", headers=headers)
    assert initial.status_code == 200
    assert initial.json() == {
        "providers": [
            {
                "provider": "openai",
                "displayName": "OpenAI",
                "models": [
                    {
                        "id": "gpt-5.6-luna",
                        "displayName": "GPT-5.6 Luna",
                        "reasoningEfforts": [
                            "none",
                            "low",
                            "medium",
                            "high",
                            "xhigh",
                            "max",
                        ],
                    }
                ],
                "configured": False,
                "credentialVersion": None,
                "updatedAt": None,
            }
        ]
    }

    first_key = "sk-test-first-key-material"
    first = await credential_client.put(
        "/ai/providers/openai/credential",
        headers=headers,
        json={"apiKey": first_key},
    )
    assert first.status_code == 200
    assert first.json()["configured"] is True
    assert first.json()["credentialVersion"] == 1
    assert "apiKey" not in first.text
    assert first_key not in first.text

    credential = await db_session.scalar(
        select(AIProviderCredential).where(AIProviderCredential.user_id == user.id)
    )
    assert credential is not None
    assert first_key.encode("utf-8") not in credential.encrypted_api_key
    assert await get_provider_api_key(db_session, user.id, "openai") == first_key
    assert await get_provider_credential(db_session, user.id, "openai") == (
        first_key,
        1,
    )

    second_key = "sk-test-second-key-material"
    second = await credential_client.put(
        "/ai/providers/openai/credential",
        headers=headers,
        json={"apiKey": second_key},
    )
    assert second.status_code == 200
    assert second.json()["credentialVersion"] == 2
    assert second_key not in second.text
    assert await get_provider_api_key(db_session, user.id, "openai") == second_key
    assert await get_provider_credential(db_session, user.id, "openai") == (
        second_key,
        2,
    )

    same_key = await credential_client.put(
        "/ai/providers/openai/credential",
        headers=headers,
        json={"apiKey": second_key},
    )
    assert same_key.status_code == 200
    assert same_key.json()["credentialVersion"] == 3
    assert await get_provider_credential(db_session, user.id, "openai") == (
        second_key,
        3,
    )
    assert (
        await db_session.scalar(
            select(func.count()).select_from(AIProviderCredential).where(
                AIProviderCredential.user_id == user.id,
                AIProviderCredential.provider == "openai",
            )
        )
        == 1
    )


@pytest.mark.asyncio
async def test_credential_access_is_isolated_and_delete_is_idempotent(
    credential_client,
    db_session,
    monkeypatch,
):
    configure_encryption(monkeypatch, Fernet.generate_key())
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    first_user = await create_user(db_session)
    second_user = await create_user(db_session)
    secret = "sk-private-to-first-user-only"

    stored = await credential_client.put(
        "/ai/providers/openai/credential",
        headers=auth_headers(first_user),
        json={"apiKey": secret},
    )
    assert stored.status_code == 200

    second_status = await credential_client.get(
        "/ai/providers",
        headers=auth_headers(second_user),
    )
    assert second_status.status_code == 200
    assert second_status.json()["providers"][0]["configured"] is False
    assert (
        await credential_client.delete(
            "/ai/providers/openai/credential",
            headers=auth_headers(second_user),
        )
    ).status_code == 204
    assert await get_provider_api_key(db_session, first_user.id, "openai") == secret

    deleted = await credential_client.delete(
        "/ai/providers/openai/credential",
        headers=auth_headers(first_user),
    )
    assert deleted.status_code == 204
    assert deleted.content == b""
    with pytest.raises(LookupError, match="not configured"):
        await get_provider_api_key(db_session, first_user.id, "openai")
    assert (
        await credential_client.delete(
            "/ai/providers/openai/credential",
            headers=auth_headers(first_user),
        )
    ).status_code == 204


@pytest.mark.asyncio
async def test_multifernet_reads_credentials_written_with_an_old_key(
    credential_client,
    db_session,
    monkeypatch,
):
    old_key = Fernet.generate_key()
    new_key = Fernet.generate_key()
    configure_encryption(monkeypatch, old_key)
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    user = await create_user(db_session)
    secret = "sk-encrypted-with-the-old-key"
    assert (
        await credential_client.put(
            "/ai/providers/openai/credential",
            headers=auth_headers(user),
            json={"apiKey": secret},
        )
    ).status_code == 200

    configure_encryption(monkeypatch, new_key, old_key)
    assert await get_provider_api_key(db_session, user.id, "openai") == secret


@pytest.mark.asyncio
async def test_invalid_requests_never_log_or_return_key_material(
    credential_client,
    db_session,
    monkeypatch,
    caplog,
):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    configure_encryption(monkeypatch)
    user = await create_user(db_session)
    secret = "sk-sensitive-key-with-unique-secret-tail"

    with caplog.at_level(logging.DEBUG):
        unavailable = await credential_client.put(
            "/ai/providers/openai/credential",
            headers=auth_headers(user),
            json={"apiKey": secret},
        )
    assert unavailable.status_code == 503
    assert unavailable.json()["detail"]["code"] == "credential_encryption_unavailable"
    assert secret not in unavailable.text
    assert secret not in caplog.text
    assert secret[-12:] not in caplog.text
    assert await db_session.scalar(select(func.count()).select_from(AIProviderCredential)) == 0

    configure_encryption(monkeypatch, Fernet.generate_key())
    unsupported = await credential_client.put(
        "/ai/providers/gemini/credential",
        headers=auth_headers(user),
        json={"apiKey": secret},
    )
    assert unsupported.status_code == 404
    assert unsupported.json()["detail"]["code"] == "provider_not_supported"
    blank = await credential_client.put(
        "/ai/providers/openai/credential",
        headers=auth_headers(user),
        json={"apiKey": "   "},
    )
    assert blank.status_code == 422
    assert blank.json()["detail"]["code"] == "invalid_api_key"


@pytest.mark.asyncio
async def test_provider_endpoints_require_authentication(credential_client):
    assert (await credential_client.get("/ai/providers")).status_code == 401
    assert (
        await credential_client.put(
            "/ai/providers/openai/credential",
            json={"apiKey": "sk-not-stored"},
        )
    ).status_code == 403
    assert (
        await credential_client.delete("/ai/providers/openai/credential")
    ).status_code == 403
