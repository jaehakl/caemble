from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import AccessKeyCreate, AccessKeyCreateResult, AccessKeyData
from runtime_state import runtime
from service.auth_audit_service import add_auth_audit
from user_auth.db import APIKey, Role, User, UserRole
from user_auth.utils.auth_utils import hash_token, random_urlsafe


ACCESS_KEY_PREFIX = "csk_"
ACCESS_KEY_TYPE = "user_api"
ACCESS_KEY_DISPLAY_PREFIX_LENGTH = 16
ALLOWED_ACCESS_KEY_SCOPES = {"client", "launcher"}


def access_key_to_data(access_key: APIKey) -> AccessKeyData:
    return AccessKeyData(
        id=str(access_key.id),
        user_id=str(access_key.user_id),
        key_type=access_key.key_type,
        name=access_key.name or "",
        key_prefix=access_key.key_prefix,
        scopes=[str(item) for item in (access_key.scopes or [])],
        status=access_key.status,
        rate_limit_per_minute=access_key.rate_limit_per_minute,
        allowed_ips=access_key.allowed_ips,
        allowed_origins=access_key.allowed_origins,
        last_used_at=access_key.last_used_at,
        expires_at=access_key.expires_at,
        created_at=access_key.created_at,
        revoked_at=access_key.revoked_at,
    )


class AccessKeyService:
    @staticmethod
    async def active_launcher_key_ids(db: AsyncSession, access_key_ids: set[str]) -> set[str]:
        if not access_key_ids:
            return set()
        now = datetime.now(timezone.utc)
        rows = await db.scalars(
            select(APIKey.id)
            .join(User, User.id == APIKey.user_id)
            .join(UserRole, UserRole.user_id == User.id)
            .join(Role, Role.id == UserRole.role_id)
            .where(
                APIKey.id.in_(access_key_ids),
                APIKey.status == "active",
                APIKey.revoked_at.is_(None),
                or_(APIKey.expires_at.is_(None), APIKey.expires_at > now),
                APIKey.scopes.contains(["launcher"]),
                User.is_active.is_(True),
                Role.name.in_(("admin", "user")),
            )
        )
        return {str(key_id) for key_id in rows.all()}

    @staticmethod
    async def is_active_launcher_key(
        db: AsyncSession,
        access_key_id: str,
        user_id: str | None = None,
    ) -> bool:
        now = datetime.now(timezone.utc)
        stmt = (
            select(APIKey.id)
            .join(User, User.id == APIKey.user_id)
            .join(UserRole, UserRole.user_id == User.id)
            .join(Role, Role.id == UserRole.role_id)
            .where(
                APIKey.id == access_key_id,
                APIKey.status == "active",
                APIKey.revoked_at.is_(None),
                or_(APIKey.expires_at.is_(None), APIKey.expires_at > now),
                APIKey.scopes.contains(["launcher"]),
                User.is_active.is_(True),
                Role.name.in_(("admin", "user")),
            )
        )
        if user_id is not None:
            stmt = stmt.where(APIKey.user_id == user_id)
        return await db.scalar(stmt) is not None

    @staticmethod
    async def create_user_access_key(
        db: AsyncSession,
        user_id: str,
        payload: AccessKeyCreate,
    ) -> AccessKeyCreateResult:
        user = await db.get(User, user_id)
        role = await db.scalar(
            select(Role.id)
            .join(UserRole, UserRole.role_id == Role.id)
            .where(UserRole.user_id == user_id, Role.name.in_(("admin", "user")))
            .limit(1)
        )
        if user is None:
            raise ValueError("User not found")
        if not user.is_active or role is None:
            raise ValueError("Access Tokens require an active admin or user account")

        name = payload.name.strip()
        if not name:
            raise ValueError("Access Token name is required")
        scopes = list(dict.fromkeys(payload.scopes or []))
        if not scopes or any(scope not in ALLOWED_ACCESS_KEY_SCOPES for scope in scopes):
            raise ValueError("Invalid Access Token scope")

        secret = f"{ACCESS_KEY_PREFIX}{random_urlsafe(48)}"
        access_key = APIKey(
            user_id=user_id,
            key_type=ACCESS_KEY_TYPE,
            name=name,
            key_prefix=secret[:ACCESS_KEY_DISPLAY_PREFIX_LENGTH],
            key_hash=hash_token(secret),
            scopes=scopes,
            status="active",
            expires_at=normalize_optional_datetime(payload.expires_at),
        )
        db.add(access_key)
        add_auth_audit(
            db,
            "token_created",
            user_id=user_id,
            details={
                "name": name,
                "key_prefix": access_key.key_prefix,
                "scopes": scopes,
            },
        )
        await db.commit()
        await db.refresh(access_key)
        return AccessKeyCreateResult(access_key=access_key_to_data(access_key), secret=secret)

    @staticmethod
    async def revoke_access_keys(
        db: AsyncSession,
        ids: list[str],
        *,
        user_id: str | None,
    ) -> int:
        stmt = select(APIKey).where(APIKey.id.in_(ids))
        if user_id is not None:
            stmt = stmt.where(APIKey.user_id == user_id)
        rows = list((await db.scalars(stmt)).all())
        now = datetime.now(timezone.utc)
        for row in rows:
            row.status = "revoked"
            row.revoked_at = row.revoked_at or now
            add_auth_audit(
                db,
                "token_revoked",
                user_id=str(row.user_id),
                details={
                    "access_key_id": str(row.id),
                    "key_prefix": row.key_prefix,
                },
            )
        await db.commit()
        for row in rows:
            await runtime.close_launchers_for_access_key(str(row.id))
        return len(rows)


def normalize_optional_datetime(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)
