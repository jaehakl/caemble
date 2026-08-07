import inspect
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from import_gpstation_client_tokens import (
    SOURCE_CLIENT_TOKEN_QUERY,
    SOURCE_DB_URL_ENV,
    import_gpstation_client_tokens,
    main,
    parse_user_mappings,
    read_source_client_tokens,
)
from tests.helpers import create_user
from user_auth.db import APIKey, AuthAudit, Identity, OAuthProvider, User, UserRole


def source_row(source_user_id: str, key_hash: bytes, identity_id: str) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "source_key_id": f"source-key-{source_user_id}",
        "source_user_id": source_user_id,
        "key_type": "user_api",
        "name": "기존 GPStation client",
        "key_prefix": f"gpsk_{source_user_id[:8]}",
        "key_hash": key_hash,
        "rate_limit_per_minute": 30,
        "allowed_ips": ["127.0.0.1/32"],
        "allowed_origins": ["https://client.example"],
        "last_used_at": now,
        "expires_at": now + timedelta(days=30),
        "created_at": now - timedelta(days=1),
        "source_user_email": f"{source_user_id}@example.com",
        "source_display_name": "가져온 사용자",
        "identities": [
            {
                "provider": "google",
                "provider_user_id": identity_id,
                "email": f"{source_user_id}@example.com",
                "email_verified": True,
            }
        ],
    }


def test_importer_contract_is_read_only_and_mapping_parser_is_strict():
    assert "SET TRANSACTION READ ONLY" in inspect.getsource(read_source_client_tokens)
    assert SOURCE_DB_URL_ENV == "CAEMBLE_GPSTATION_IMPORT_DB_URL"
    assert "SOURCE_DB_URL_ENV" in inspect.getsource(main)
    assert "--source-db-url" not in inspect.getsource(main)
    assert SOURCE_CLIENT_TOKEN_QUERY.lstrip().startswith("SELECT")
    assert "ak.scopes @> '[\"client\"]'::jsonb" in SOURCE_CLIENT_TOKEN_QUERY
    assert parse_user_mappings(["source=target"]) == {"source": "target"}
    with pytest.raises(ValueError, match="Invalid user mapping"):
        parse_user_mappings(["missing-separator"])
    with pytest.raises(ValueError, match="Conflicting user mapping"):
        parse_user_mappings(["source=one", "source=two"])


async def add_identity(db_session, user, provider_user_id):
    db_session.add(
        Identity(
            user_id=user.id,
            provider=OAuthProvider.google,
            provider_user_id=provider_user_id,
            email=user.email,
            email_verified=True,
        )
    )
    await db_session.commit()


async def add_access_key(db_session, user, key_hash, key_prefix):
    access_key = APIKey(
        user_id=user.id,
        key_type="user_api",
        name="existing",
        key_prefix=key_prefix,
        key_hash=key_hash,
        scopes=["client"],
        status="active",
    )
    db_session.add(access_key)
    await db_session.commit()
    return access_key


@pytest.mark.asyncio
async def test_importer_prefers_identity_and_preserves_old_client_key(
    db_session,
    monkeypatch,
):
    target = await create_user(db_session)
    await add_identity(db_session, target, "google-existing")
    row = source_row("source-existing", b"\x11" * 32, "google-existing")

    async def fake_source(_source_db_url):
        return [row]

    monkeypatch.setattr(
        "import_gpstation_client_tokens.read_source_client_tokens",
        fake_source,
    )
    result = await import_gpstation_client_tokens(
        "postgresql://read-only-source",
        {},
        apply=True,
        target_db=db_session,
    )
    assert result["imported"] == 1
    imported = await db_session.scalar(select(APIKey).where(APIKey.key_hash == row["key_hash"]))
    assert imported is not None
    assert str(imported.user_id) == str(target.id)
    assert imported.key_prefix == row["key_prefix"]
    assert imported.scopes == ["client"]
    assert imported.allowed_ips == row["allowed_ips"]
    audit = await db_session.scalar(
        select(AuthAudit).where(
            AuthAudit.user_id == target.id,
            AuthAudit.event == "token_imported",
        )
    )
    assert audit is not None
    assert audit.details["source_secret_may_remain_valid"] is True


@pytest.mark.asyncio
async def test_importer_creates_verified_user_with_user_role(
    db_session,
    monkeypatch,
):
    row = source_row("source-new", b"\x22" * 32, "google-new")

    async def fake_source(_source_db_url):
        return [row]

    monkeypatch.setattr(
        "import_gpstation_client_tokens.read_source_client_tokens",
        fake_source,
    )
    result = await import_gpstation_client_tokens(
        "postgresql://read-only-source",
        {},
        apply=True,
        target_db=db_session,
    )
    assert result["created_users"] == 1
    user = await db_session.scalar(select(User).where(User.email == "source-new@example.com"))
    assert user is not None
    assert user.email_verified_at is not None
    assert await db_session.scalar(
        select(UserRole.role_id).where(UserRole.user_id == user.id)
    )
    identity = await db_session.scalar(
        select(Identity).where(Identity.provider_user_id == "google-new")
    )
    assert identity is not None
    assert str(identity.user_id) == str(user.id)


@pytest.mark.asyncio
async def test_importer_creates_user_from_safe_provider_identity_without_verified_email(
    db_session,
    monkeypatch,
):
    row = source_row("source-identity-only", b"\x23" * 32, "google-identity-only")
    row["source_user_email"] = None
    row["identities"][0]["email"] = None
    row["identities"][0]["email_verified"] = False

    async def fake_source(_source_db_url):
        return [row]

    monkeypatch.setattr(
        "import_gpstation_client_tokens.read_source_client_tokens",
        fake_source,
    )
    result = await import_gpstation_client_tokens(
        "postgresql://read-only-source",
        {},
        apply=True,
        target_db=db_session,
    )
    assert result["created_users"] == 1
    identity = await db_session.scalar(
        select(Identity).where(Identity.provider_user_id == "google-identity-only")
    )
    assert identity is not None
    user = await db_session.get(User, identity.user_id)
    assert user is not None
    assert user.email is None
    assert user.email_verified_at is None


@pytest.mark.asyncio
async def test_importer_reports_source_user_without_safe_identity(
    db_session,
    monkeypatch,
):
    row = source_row("source-no-identity", b"\x24" * 32, "unused")
    row["identities"] = []

    async def fake_source(_source_db_url):
        return [row]

    monkeypatch.setattr(
        "import_gpstation_client_tokens.read_source_client_tokens",
        fake_source,
    )
    result = await import_gpstation_client_tokens(
        "postgresql://read-only-source",
        {},
        apply=False,
        target_db=db_session,
    )
    assert result["would_import"] == 0
    assert result["created_users"] == 0
    assert result["errors"] == [
        "source user source-no-identity has no safe provider identity; provide --map"
    ]


@pytest.mark.asyncio
async def test_dry_run_reports_without_mutating_the_target(db_session, monkeypatch):
    row = source_row("source-dry-run", b"\x33" * 32, "google-dry-run")

    async def fake_source(_source_db_url):
        return [row]

    monkeypatch.setattr(
        "import_gpstation_client_tokens.read_source_client_tokens",
        fake_source,
    )
    result = await import_gpstation_client_tokens(
        "postgresql://read-only-source",
        {},
        apply=False,
        target_db=db_session,
    )
    assert result == {
        "dry_run": True,
        "source_keys": 1,
        "imported": 0,
        "would_import": 1,
        "skipped": 0,
        "created_users": 1,
        "errors": [],
    }
    assert await db_session.scalar(
        select(User.id).where(User.email == "source-dry-run@example.com")
    ) is None
    assert await db_session.scalar(
        select(APIKey.id).where(APIKey.key_hash == row["key_hash"])
    ) is None


@pytest.mark.asyncio
async def test_same_hash_and_owner_is_idempotent_even_when_prefix_changed(
    db_session,
    monkeypatch,
):
    target = await create_user(db_session)
    await add_identity(db_session, target, "google-idempotent")
    row = source_row("source-idempotent", b"\x44" * 32, "google-idempotent")
    await add_access_key(db_session, target, row["key_hash"], "csk_reissued-prefix")

    async def fake_source(_source_db_url):
        return [row]

    monkeypatch.setattr(
        "import_gpstation_client_tokens.read_source_client_tokens",
        fake_source,
    )
    result = await import_gpstation_client_tokens(
        "postgresql://read-only-source",
        {},
        apply=True,
        target_db=db_session,
    )
    assert result["skipped"] == 1
    assert result["imported"] == 0
    assert result["errors"] == []
    assert len(
        (
            await db_session.scalars(
                select(APIKey.id).where(APIKey.key_hash == row["key_hash"])
            )
        ).all()
    ) == 1


@pytest.mark.asyncio
async def test_prefix_collision_aborts_apply_and_rolls_back(db_session, monkeypatch):
    target = await create_user(db_session)
    other = await create_user(db_session)
    await add_identity(db_session, target, "google-prefix-collision")
    row = source_row("source-prefix", b"\x55" * 32, "google-prefix-collision")
    await add_access_key(db_session, other, b"\x56" * 32, row["key_prefix"])

    async def fake_source(_source_db_url):
        return [row]

    monkeypatch.setattr(
        "import_gpstation_client_tokens.read_source_client_tokens",
        fake_source,
    )
    with pytest.raises(RuntimeError, match="prefix belongs to another row"):
        await import_gpstation_client_tokens(
            "postgresql://read-only-source",
            {},
            apply=True,
            target_db=db_session,
        )
    assert await db_session.scalar(
        select(APIKey.id).where(APIKey.key_hash == row["key_hash"])
    ) is None


@pytest.mark.asyncio
async def test_multiple_identity_owners_cannot_be_overridden_by_map(
    db_session,
    monkeypatch,
):
    first = await create_user(db_session)
    second = await create_user(db_session)
    first_id = str(first.id)
    await add_identity(db_session, first, "google-conflict-one")
    await add_identity(db_session, second, "google-conflict-two")
    row = source_row("source-conflict", b"\x66" * 32, "google-conflict-one")
    row["identities"].append(
        {
            "provider": "google",
            "provider_user_id": "google-conflict-two",
            "email": second.email,
            "email_verified": True,
        }
    )

    async def fake_source(_source_db_url):
        return [row]

    monkeypatch.setattr(
        "import_gpstation_client_tokens.read_source_client_tokens",
        fake_source,
    )
    dry_run = await import_gpstation_client_tokens(
        "postgresql://read-only-source",
        {row["source_user_id"]: first_id},
        apply=False,
        target_db=db_session,
    )
    assert dry_run["would_import"] == 0
    assert len(dry_run["errors"]) == 1
    assert "multiple identity owners" in dry_run["errors"][0]
    with pytest.raises(RuntimeError, match="multiple identity owners"):
        await import_gpstation_client_tokens(
            "postgresql://read-only-source",
            {row["source_user_id"]: first_id},
            apply=True,
            target_db=db_session,
        )
