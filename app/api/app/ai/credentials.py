from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import datetime
from typing import Literal

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gpstation.utils.csrf import require_web_csrf
from ai.provider import ProviderError, create_provider_adapter
from models import UserData
from settings import settings
from user_auth.db import AIProviderCredential
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


PROVIDER_MODELS = {"openai": ("gpt-5.6-luna",)}
SUPPORTED_PROVIDERS = frozenset(PROVIDER_MODELS)
REASONING_EFFORTS = ("none", "low", "medium", "high", "xhigh", "max")
CONNECTION_TEST_SECONDS = 30

router = APIRouter(prefix="/ai", tags=["ai"])
logger = logging.getLogger(__name__)


class ProviderCredentialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    apiKey: SecretStr


class ProviderModelData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    display_name: str = Field(alias="displayName")
    reasoning_efforts: list[
        Literal["none", "low", "medium", "high", "xhigh", "max"]
    ] = Field(alias="reasoningEfforts")


class ProviderData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    provider: str
    display_name: str = Field(alias="displayName")
    models: list[ProviderModelData]
    configured: bool
    credential_version: int | None = Field(alias="credentialVersion")
    updated_at: datetime | None = Field(alias="updatedAt")


class ProvidersResponse(BaseModel):
    providers: list[ProviderData]


class ProviderConnectionTestData(BaseModel):
    provider: str
    model: str
    ok: Literal[True]


def _fernet() -> MultiFernet:
    if not settings.AI_CREDENTIAL_FERNET_KEYS:
        raise RuntimeError("AI credential encryption is not configured")
    try:
        return MultiFernet(
            [
                Fernet(key.get_secret_value().encode("ascii"))
                for key in settings.AI_CREDENTIAL_FERNET_KEYS
            ]
        )
    except (TypeError, ValueError, UnicodeEncodeError):
        raise RuntimeError("AI credential encryption is not configured") from None


def _provider_data(
    provider: str,
    credential_version: int | None,
    updated_at: datetime | None,
) -> ProviderData:
    return ProviderData(
        provider=provider,
        display_name="OpenAI",
        models=[
            ProviderModelData(
                id="gpt-5.6-luna",
                display_name="GPT-5.6 Luna",
                reasoning_efforts=list(REASONING_EFFORTS),
            )
        ],
        configured=credential_version is not None,
        credential_version=credential_version,
        updated_at=updated_at,
    )


def _require_provider(provider: str) -> None:
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "provider_not_supported",
                "message": "Provider is not supported.",
            },
        )


async def get_provider_credential(
    db: AsyncSession,
    user_id: str,
    provider: str,
) -> tuple[str, int]:
    if provider not in SUPPORTED_PROVIDERS:
        raise LookupError("Provider is not supported")
    credential = (
        await db.execute(
            select(
                AIProviderCredential.encrypted_api_key,
                AIProviderCredential.version,
            ).where(
                AIProviderCredential.user_id == user_id,
                AIProviderCredential.provider == provider,
            )
        )
    ).one_or_none()
    if credential is None:
        raise LookupError("Provider credential is not configured")
    try:
        api_key = _fernet().decrypt(credential.encrypted_api_key).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError):
        raise RuntimeError("Provider credential could not be decrypted") from None
    return api_key, credential.version


async def get_provider_api_key(
    db: AsyncSession,
    user_id: str,
    provider: str,
) -> str:
    api_key, _ = await get_provider_credential(db, user_id, provider)
    return api_key


@router.get("/providers", response_model=ProvidersResponse)
async def list_providers(
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
) -> ProvidersResponse:
    credentials = {
        row.provider: (row.version, row.updated_at)
        for row in (
            await db.execute(
                select(
                    AIProviderCredential.provider,
                    AIProviderCredential.version,
                    AIProviderCredential.updated_at,
                ).where(
                    AIProviderCredential.user_id == user.id,
                    AIProviderCredential.provider.in_(SUPPORTED_PROVIDERS),
                )
            )
        ).all()
    }
    return ProvidersResponse(
        providers=[
            _provider_data(provider, *(credentials.get(provider) or (None, None)))
            for provider in sorted(SUPPORTED_PROVIDERS)
        ]
    )


@router.put(
    "/providers/{provider}/credential",
    response_model=ProviderData,
    dependencies=[Depends(require_web_csrf)],
)
async def put_provider_credential(
    provider: str,
    payload: ProviderCredentialRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
) -> ProviderData:
    _require_provider(provider)
    api_key = payload.apiKey.get_secret_value().strip()
    if not api_key or len(api_key) > 4096:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid_api_key", "message": "API key is invalid."},
        )
    try:
        encrypted_api_key = _fernet().encrypt(api_key.encode("utf-8"))
    except RuntimeError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "credential_encryption_unavailable",
                "message": "Credential encryption is unavailable.",
            },
        ) from error

    statement = insert(AIProviderCredential).values(
        user_id=user.id,
        provider=provider,
        encrypted_api_key=encrypted_api_key,
        version=1,
    )
    statement = statement.on_conflict_do_update(
        constraint="uq_ai_provider_credentials_user_id_provider",
        set_={
            "encrypted_api_key": statement.excluded.encrypted_api_key,
            "version": AIProviderCredential.version + 1,
            "updated_at": func.now(),
        },
    ).returning(
        AIProviderCredential.version,
        AIProviderCredential.updated_at,
    )
    result = (await db.execute(statement)).one()
    await db.commit()
    return _provider_data(provider, result.version, result.updated_at)


@router.delete(
    "/providers/{provider}/credential",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_web_csrf)],
)
async def delete_provider_credential(
    provider: str,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
) -> Response:
    _require_provider(provider)
    await db.execute(
        delete(AIProviderCredential).where(
            AIProviderCredential.user_id == user.id,
            AIProviderCredential.provider == provider,
        )
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/providers/{provider}/credential/test",
    response_model=ProviderConnectionTestData,
    dependencies=[Depends(require_web_csrf)],
)
async def test_provider_credential(
    provider: str,
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
) -> ProviderConnectionTestData:
    _require_provider(provider)
    model = PROVIDER_MODELS[provider][0]
    try:
        api_key, _ = await get_provider_credential(db, user.id, provider)
    except LookupError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "credential_not_configured",
                "message": "Provider credential is not configured.",
            },
        ) from error
    finally:
        await db.rollback()

    adapter = create_provider_adapter(provider, model, api_key)

    async def ignore_delta(_value: str) -> None:
        return None

    try:
        await asyncio.wait_for(
            adapter.generate(
                instructions="Return only OK. This is a Caemble provider connection test.",
                input_items=[
                    {
                        "type": "message",
                        "role": "user",
                        "content": "Verify that this model can complete a Responses API request.",
                    }
                ],
                tools=[],
                reasoning_effort="none",
                reasoning_context="current_turn",
                prompt_cache_key=(
                    "caemble-provider-test-"
                    + hashlib.sha256(user.id.encode("utf-8")).hexdigest()[:32]
                ),
                on_delta=ignore_delta,
                cancel_event=asyncio.Event(),
            ),
            timeout=CONNECTION_TEST_SECONDS,
        )
    except TimeoutError as error:
        failure = ProviderError(
            "The OpenAI connection test timed out.",
            code="provider_timeout",
            retryable=True,
        )
        _log_connection_test_failure(user.id, provider, model, failure)
        raise HTTPException(
            status_code=status.HTTP_424_FAILED_DEPENDENCY,
            detail=failure.public_data(),
        ) from error
    except ProviderError as error:
        _log_connection_test_failure(user.id, provider, model, error)
        raise HTTPException(
            status_code=status.HTTP_424_FAILED_DEPENDENCY,
            detail=error.public_data(),
        ) from error
    finally:
        try:
            await adapter.close()
        except Exception:
            logger.warning(
                "ai_provider.connection_test.close_failed",
                extra={
                    "ai_user_id": user.id,
                    "ai_provider": provider,
                    "ai_model": model,
                },
            )

    logger.info(
        "ai_provider.connection_test.completed",
        extra={
            "ai_user_id": user.id,
            "ai_provider": provider,
            "ai_model": model,
        },
    )
    return ProviderConnectionTestData(provider=provider, model=model, ok=True)


def _log_connection_test_failure(
    user_id: str,
    provider: str,
    model: str,
    error: ProviderError,
) -> None:
    logger.warning(
        "ai_provider.connection_test.failed",
        extra={
            "ai_user_id": user_id,
            "ai_provider": provider,
            "ai_model": model,
            "ai_error_code": error.code or "provider_request_failed",
            "ai_provider_status": error.status_code,
            "ai_provider_error_code": error.upstream_code,
            "ai_provider_parameter": error.parameter,
            "ai_provider_request_id": error.request_id,
        },
    )
