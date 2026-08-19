from __future__ import annotations

from datetime import datetime
from typing import Literal

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from gpstation.utils.csrf import require_web_csrf
from models import UserData
from settings import settings
from user_auth.db import AIProviderCredential
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


PROVIDER_MODELS = {"openai": ("gpt-5.6-luna",)}
SUPPORTED_PROVIDERS = frozenset(PROVIDER_MODELS)
REASONING_EFFORTS = ("none", "low", "medium", "high", "xhigh", "max")

router = APIRouter(prefix="/ai", tags=["ai"])


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
