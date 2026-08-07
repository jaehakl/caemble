from __future__ import annotations

import argparse
import asyncio
import json
import os
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from db import SessionLocal, make_async_db_url
from service.auth_audit_service import add_auth_audit
from user_auth.db import APIKey, Identity, OAuthProvider, Role, User, UserRole


SOURCE_CLIENT_TOKEN_QUERY = """
SELECT
    ak.id::text AS source_key_id,
    ak.user_id::text AS source_user_id,
    ak.key_type,
    ak.name,
    ak.key_prefix,
    ak.key_hash,
    ak.rate_limit_per_minute,
    ak.allowed_ips,
    ak.allowed_origins,
    ak.last_used_at,
    ak.expires_at,
    ak.created_at,
    u.email AS source_user_email,
    u.display_name AS source_display_name,
    COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'provider', i.provider::text,
                'provider_user_id', i.provider_user_id,
                'email', i.email,
                'email_verified', i.email_verified
            )
        ) FILTER (WHERE i.id IS NOT NULL),
        '[]'::jsonb
    ) AS identities
FROM access_keys AS ak
JOIN users AS u ON u.id = ak.user_id
LEFT JOIN identities AS i ON i.user_id = u.id
WHERE ak.status = 'active'
  AND ak.revoked_at IS NULL
  AND (ak.expires_at IS NULL OR ak.expires_at > now())
  AND ak.scopes @> '["client"]'::jsonb
  AND u.status = 'active'
  AND u.role IN ('admin', 'user')
GROUP BY ak.id, u.id
ORDER BY ak.created_at, ak.id
"""
SOURCE_DB_URL_ENV = "CAEMBLE_GPSTATION_IMPORT_DB_URL"


def parse_user_mappings(values: list[str]) -> dict[str, str]:
    mappings: dict[str, str] = {}
    for value in values:
        source_user_id, separator, target_user_id = value.partition("=")
        source_user_id = source_user_id.strip()
        target_user_id = target_user_id.strip()
        if not separator or not source_user_id or not target_user_id:
            raise ValueError(f"Invalid user mapping: {value!r}")
        if source_user_id in mappings and mappings[source_user_id] != target_user_id:
            raise ValueError(f"Conflicting user mapping for {source_user_id}")
        mappings[source_user_id] = target_user_id
    return mappings


async def read_source_client_tokens(source_db_url: str) -> list[dict[str, Any]]:
    if not source_db_url.strip():
        raise ValueError(f"{SOURCE_DB_URL_ENV} is required")
    source_engine = create_async_engine(
        make_async_db_url(source_db_url),
        future=True,
        pool_pre_ping=True,
    )
    try:
        async with source_engine.connect() as connection:
            transaction = await connection.begin()
            try:
                await connection.execute(text("SET TRANSACTION READ ONLY"))
                rows = await connection.execute(text(SOURCE_CLIENT_TOKEN_QUERY))
                return [dict(row._mapping) for row in rows]
            finally:
                await transaction.rollback()
    finally:
        await source_engine.dispose()


async def resolve_target_user(
    db: AsyncSession,
    source: dict[str, Any],
    explicit_target_user_id: str | None,
    *,
    apply: bool,
) -> tuple[User | None, str]:
    identities = source.get("identities") or []
    valid_identities: list[tuple[OAuthProvider, str]] = []
    identity_target_ids: set[str] = set()
    for identity in identities:
        provider = parse_provider(identity.get("provider"))
        provider_user_id = str(identity.get("provider_user_id") or "").strip()
        if provider is None or not provider_user_id:
            continue
        valid_identities.append((provider, provider_user_id))
        target_id = await db.scalar(
            select(Identity.user_id).where(
                Identity.provider == provider,
                Identity.provider_user_id == provider_user_id,
            )
        )
        if target_id is not None:
            identity_target_ids.add(str(target_id))

    if len(identity_target_ids) == 1:
        target_id = next(iter(identity_target_ids))
        if explicit_target_user_id and explicit_target_user_id != target_id:
            raise ValueError(
                "explicit mapping conflicts with the provider identity mapping "
                f"for source user {source['source_user_id']}"
            )
        target = await db.get(User, target_id)
        if target is None:
            raise ValueError(f"identity target user {target_id} does not exist")
        return target, "identity"

    if len(identity_target_ids) > 1:
        raise ValueError(
            f"source user {source['source_user_id']} maps to multiple identity owners; "
            "resolve the identity ownership conflict before importing"
        )

    if explicit_target_user_id:
        target = await db.get(User, explicit_target_user_id)
        if target is None:
            raise ValueError(f"explicit target user {explicit_target_user_id} does not exist")
        return target, "explicit"

    verified_emails = {
        str(identity["email"]).strip().lower()
        for identity in identities
        if identity.get("email_verified") is True
        and isinstance(identity.get("email"), str)
        and identity["email"].strip()
    }
    if verified_emails:
        email_targets = list(
            (
                await db.scalars(
                    select(User).where(
                        func.lower(User.email).in_(verified_emails),
                    )
                )
            ).all()
        )
        target_ids = {str(user.id) for user in email_targets}
        if len(target_ids) == 1:
            target = email_targets[0]
            if target.email_verified_at is None:
                raise ValueError(
                    f"source user {source['source_user_id']} has a verified email "
                    "owned by an unverified Caemble account; provide --map"
                )
            return target, "verified_email"
        if len(target_ids) > 1:
            raise ValueError(
                f"source user {source['source_user_id']} has verified emails owned by "
                "multiple users; provide --map"
            )

    if not valid_identities:
        raise ValueError(
            f"source user {source['source_user_id']} has no safe provider identity; "
            "provide --map"
        )

    source_email = str(source.get("source_user_email") or "").strip().lower()
    if source_email in verified_emails:
        new_email: str | None = source_email
    elif len(verified_emails) == 1:
        new_email = next(iter(verified_emails))
    else:
        new_email = None

    if not apply:
        identity_label = f"{valid_identities[0][0].value}:{valid_identities[0][1]}"
        return None, f"new:{new_email or identity_label}"

    target = User(
        email=new_email,
        email_verified_at=datetime.now(timezone.utc) if new_email else None,
        display_name=source.get("source_display_name"),
        is_active=True,
    )
    db.add(target)
    await db.flush()
    role = await db.scalar(select(Role).where(Role.name == "user"))
    if role is None:
        role = Role(name="user")
        db.add(role)
        await db.flush()
    db.add(UserRole(user_id=str(target.id), role_id=role.id))
    await db.flush()
    return target, "created"


async def copy_missing_identities(
    db: AsyncSession,
    target_user_id: str,
    identities: list[dict[str, Any]],
) -> None:
    for source_identity in identities:
        provider = parse_provider(source_identity.get("provider"))
        provider_user_id = str(source_identity.get("provider_user_id") or "").strip()
        if provider is None or not provider_user_id:
            continue
        existing = await db.scalar(
            select(Identity).where(
                Identity.provider == provider,
                Identity.provider_user_id == provider_user_id,
            )
        )
        if existing is not None:
            continue
        db.add(
            Identity(
                user_id=target_user_id,
                provider=provider,
                provider_user_id=provider_user_id,
                email=source_identity.get("email"),
                email_verified=source_identity.get("email_verified"),
            )
        )
    await db.flush()


async def import_gpstation_client_tokens(
    source_db_url: str,
    mappings: dict[str, str],
    *,
    apply: bool,
    target_db: AsyncSession | None = None,
) -> dict[str, Any]:
    source_rows = await read_source_client_tokens(source_db_url)
    grouped_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in source_rows:
        row["key_hash"] = bytes(row["key_hash"])
        grouped_rows[str(row["source_user_id"])].append(row)

    owns_session = target_db is None
    db = target_db or SessionLocal()
    result: dict[str, Any] = {
        "dry_run": not apply,
        "source_keys": len(source_rows),
        "imported": 0,
        "would_import": 0,
        "skipped": 0,
        "created_users": 0,
        "errors": [],
    }
    seen_hashes: set[bytes] = set()
    seen_prefixes: set[str] = set()
    try:
        for source_user_id, rows in grouped_rows.items():
            source = rows[0]
            try:
                target_user, resolution = await resolve_target_user(
                    db,
                    source,
                    mappings.get(source_user_id),
                    apply=apply,
                )
            except ValueError as error:
                result["errors"].append(str(error))
                continue

            if target_user is not None:
                target_user_id = str(target_user.id)
                if apply:
                    await copy_missing_identities(
                        db,
                        target_user_id,
                        list(source.get("identities") or []),
                    )
                if resolution == "created":
                    result["created_users"] += 1
            else:
                target_user_id = f"new:{source_user_id}"
                if resolution.startswith("new:"):
                    result["created_users"] += 1

            for row in rows:
                key_hash = row["key_hash"]
                key_prefix = str(row["key_prefix"])
                if key_hash in seen_hashes or key_prefix in seen_prefixes:
                    result["errors"].append(
                        f"duplicate source AccessKey hash or prefix: {row['source_key_id']}"
                    )
                    continue
                seen_hashes.add(key_hash)
                seen_prefixes.add(key_prefix)

                hash_owner = await db.scalar(
                    select(APIKey).where(APIKey.key_hash == key_hash)
                )
                prefix_owner = await db.scalar(
                    select(APIKey).where(APIKey.key_prefix == key_prefix)
                )
                if (
                    hash_owner is not None
                    and prefix_owner is not None
                    and str(hash_owner.id) != str(prefix_owner.id)
                ):
                    result["errors"].append(
                        f"AccessKey prefix belongs to another row for source key "
                        f"{row['source_key_id']}"
                    )
                    continue
                if hash_owner is not None:
                    if str(hash_owner.user_id) == target_user_id:
                        result["skipped"] += 1
                    else:
                        result["errors"].append(
                            f"AccessKey hash belongs to another user for source key "
                            f"{row['source_key_id']}"
                        )
                    continue
                if prefix_owner is not None:
                    result["errors"].append(
                        f"AccessKey prefix belongs to another row for source key "
                        f"{row['source_key_id']}"
                    )
                    continue

                if not apply:
                    result["would_import"] += 1
                    continue

                access_key = APIKey(
                    user_id=target_user_id,
                    key_type=row["key_type"] or "user_api",
                    name=row["name"],
                    key_prefix=key_prefix,
                    key_hash=key_hash,
                    scopes=["client"],
                    status="active",
                    rate_limit_per_minute=row["rate_limit_per_minute"],
                    allowed_ips=row["allowed_ips"],
                    allowed_origins=row["allowed_origins"],
                    last_used_at=row["last_used_at"],
                    expires_at=row["expires_at"],
                    created_at=row["created_at"],
                )
                db.add(access_key)
                add_auth_audit(
                    db,
                    "token_imported",
                    user_id=target_user_id,
                    details={
                        "source": "gpstation",
                        "source_access_key_id": row["source_key_id"],
                        "key_prefix": key_prefix,
                        "scopes": ["client"],
                        "source_secret_may_remain_valid": True,
                    },
                )
                result["imported"] += 1

        if result["errors"]:
            await db.rollback()
            if apply:
                raise RuntimeError("; ".join(result["errors"]))
        elif apply:
            await db.commit()
        else:
            await db.rollback()
        return result
    finally:
        if owns_session:
            await db.close()


def parse_provider(value: Any) -> OAuthProvider | None:
    if isinstance(value, OAuthProvider):
        return value
    try:
        return OAuthProvider(str(value))
    except ValueError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import active GPStation client AccessKeys into Caemble",
    )
    parser.add_argument(
        "--map",
        action="append",
        default=[],
        metavar="SOURCE_USER_ID=CAEMBLE_USER_ID",
        help="Resolve a missing or conflicting source user mapping",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Commit the import; the default is a read-only dry run",
    )
    args = parser.parse_args()
    try:
        source_db_url = os.getenv(SOURCE_DB_URL_ENV, "").strip()
        if not source_db_url:
            raise ValueError(f"{SOURCE_DB_URL_ENV} is required")
        mappings = parse_user_mappings(args.map)
        result = asyncio.run(
            import_gpstation_client_tokens(
                source_db_url,
                mappings,
                apply=args.apply,
            )
        )
    except (ValueError, RuntimeError) as error:
        parser.exit(1, f"error: {error}\n")
    except Exception:
        parser.exit(1, "error: GPStation source database operation failed\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
