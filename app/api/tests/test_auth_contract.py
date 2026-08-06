from datetime import datetime, timezone
import logging
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import jwt as pyjwt
import pytest
from sqlalchemy import func, select

from settings import settings
from user_auth import routes as auth_routes
from user_auth.db import Identity, OAuthState, User
from user_auth.utils.auth_utils import pkce_challenge, safe_return_to
from user_auth.utils.jwt import make_access, make_refresh, verify_token


class SuccessfulTokenResponse:
    status_code = 200

    @staticmethod
    def json():
        return {"id_token": "mock-id-token"}


def test_jwt_token_types_are_not_interchangeable(monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    user = SimpleNamespace(
        id="00000000-0000-0000-0000-000000000001",
        email="user@example.com",
        display_name="User",
        picture_url=None,
        user_roles=[SimpleNamespace(role=SimpleNamespace(name="user"))],
    )
    access = make_access(user)
    refresh = make_refresh(user.id)
    assert verify_token(access, "access")["typ"] == "access"
    assert verify_token(refresh, "refresh")["typ"] == "refresh"
    with pytest.raises(Exception):
        verify_token(access, "refresh")
    with pytest.raises(Exception):
        verify_token(refresh, "access")


def test_return_to_is_restricted_to_configured_origins(monkeypatch):
    monkeypatch.setattr(settings, "app_base_url", "https://app.example.com")
    monkeypatch.setattr(settings, "allowed_app_origins", ("https://app.example.com", "https://preview.example.com"))
    assert safe_return_to("/viewer?sample=3") == "https://app.example.com/viewer?sample=3"
    assert safe_return_to("https://preview.example.com/docs") == "https://preview.example.com/docs"
    assert safe_return_to("https://evil.example/viewer") == "https://app.example.com"
    assert safe_return_to("//evil.example/viewer") == "https://app.example.com"


@pytest.mark.asyncio
async def test_google_oauth_pkce_callback_relogin_and_cookies(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
    monkeypatch.setattr(settings, "app_base_url", "https://app.example.com")
    monkeypatch.setattr(settings, "allowed_app_origins", ("https://app.example.com",))
    monkeypatch.setattr(settings, "SECURE_COOKIES", True)
    monkeypatch.setattr(settings, "COOKIE_DOMAIN", None)

    start = await client.get(
        "/auth/google/start",
        params={"return_to": "https://app.example.com/viewer?structure=7"},
        follow_redirects=False,
    )
    assert start.status_code == 307
    parameters = parse_qs(urlsplit(start.headers["location"]).query)
    assert parameters["code_challenge_method"] == ["S256"]
    assert parameters["nonce"][0]
    oauth_state = await db_session.scalar(select(OAuthState).where(OAuthState.state == parameters["state"][0]))
    assert oauth_state is not None
    assert parameters["code_challenge"] == [pkce_challenge(oauth_state.code_verifier)]
    assert "HttpOnly" in start.headers["set-cookie"]
    assert "Secure" in start.headers["set-cookie"]

    verification_clock_skews = []

    def verify_google_token(*args, **kwargs):
        verification_clock_skews.append(kwargs.get("clock_skew_in_seconds"))
        return {
            "sub": "google-user-1",
            "email": "oauth@example.com",
            "email_verified": True,
            "name": "OAuth User",
            "picture": "https://images.example.com/avatar.png",
            "nonce": oauth_state.nonce,
        }

    monkeypatch.setattr(auth_routes.requests, "post", lambda *args, **kwargs: SuccessfulTokenResponse())
    monkeypatch.setattr(auth_routes.google_id_token, "verify_oauth2_token", verify_google_token)
    callback = await client.get(
        "/auth/google/callback",
        params={"state": oauth_state.state, "code": "mock-code"},
        follow_redirects=False,
    )
    assert callback.status_code == 307
    assert callback.headers["location"] == "https://app.example.com/viewer?structure=7"
    assert callback.cookies.get("access_token")
    assert callback.cookies.get("refresh_token")
    assert verification_clock_skews == [settings.google_id_token_clock_skew_sec]

    me = await client.get("/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == "oauth@example.com"
    assert me.json()["roles"] == ["user"]
    first_user_id = me.json()["id"]

    reused = await client.get(
        "/auth/google/callback",
        params={"state": oauth_state.state, "code": "mock-code"},
        follow_redirects=False,
    )
    assert reused.status_code == 400

    second_start = await client.get("/auth/google/start", follow_redirects=False)
    second_parameters = parse_qs(urlsplit(second_start.headers["location"]).query)
    second_state = await db_session.scalar(select(OAuthState).where(OAuthState.state == second_parameters["state"][0]))
    assert second_state is not None
    monkeypatch.setattr(auth_routes.google_id_token, "verify_oauth2_token", lambda *args, **kwargs: {
        "sub": "google-user-1",
        "email": "oauth@example.com",
        "email_verified": True,
        "name": "OAuth User",
        "nonce": second_state.nonce,
    })
    second_callback = await client.get(
        "/auth/google/callback",
        params={"state": second_state.state, "code": "mock-code-2"},
        follow_redirects=False,
    )
    assert second_callback.status_code == 307
    assert (await client.get("/auth/me")).json()["id"] == first_user_id
    assert await db_session.scalar(select(func.count()).select_from(Identity).where(Identity.provider_user_id == "google-user-1")) == 1

    refresh_token = callback.cookies["refresh_token"]
    client.cookies.clear()
    client.cookies.set("access_token", refresh_token)
    assert (await client.get("/auth/me")).status_code == 401
    client.cookies.clear()
    client.cookies.set("refresh_token", refresh_token)
    assert (await client.get("/auth/refresh")).status_code == 200
    logout = await client.post("/auth/logout")
    assert logout.status_code == 200
    assert "access_token=" in logout.headers.get_list("set-cookie")[0]

    user = await db_session.get(User, first_user_id)
    user.is_active = False
    await db_session.commit()
    client.cookies.clear()
    client.cookies.set("access_token", second_callback.cookies["access_token"])
    client.cookies.set("refresh_token", second_callback.cookies["refresh_token"])
    assert (await client.get("/auth/me")).status_code == 401
    assert (await client.get("/auth/refresh")).status_code == 401


@pytest.mark.asyncio
async def test_google_oauth_verification_failure_is_logged_without_secrets(
    client,
    db_session,
    monkeypatch,
    caplog,
):
    start = await client.get("/auth/google/start", follow_redirects=False)
    parameters = parse_qs(urlsplit(start.headers["location"]).query)
    oauth_state = await db_session.scalar(select(OAuthState).where(OAuthState.state == parameters["state"][0]))
    assert oauth_state is not None
    issued_at = int(datetime.now(timezone.utc).timestamp()) + 5
    diagnostic_token = pyjwt.encode(
        {
            "iss": "https://accounts.google.com",
            "aud": settings.google_client_id,
            "iat": issued_at,
            "exp": issued_at + 3600,
            "nonce": oauth_state.nonce,
        },
        "test-diagnostic-signing-key-at-least-32-bytes",
        algorithm="HS256",
    )

    class SensitiveTokenResponse:
        status_code = 200

        @staticmethod
        def json():
            return {"id_token": diagnostic_token}

    def reject_token(*args, **kwargs):
        raise ValueError("signature verification failed")

    monkeypatch.setattr(auth_routes.requests, "post", lambda *args, **kwargs: SensitiveTokenResponse())
    monkeypatch.setattr(auth_routes.google_id_token, "verify_oauth2_token", reject_token)

    with caplog.at_level(logging.WARNING, logger=auth_routes.__name__):
        callback = await client.get(
            "/auth/google/callback",
            params={"state": oauth_state.state, "code": "sensitive-authorization-code"},
            follow_redirects=False,
        )

    assert callback.status_code == 400
    assert callback.json() == {"detail": "id_token verification failed"}
    assert "google_oauth_id_token_verification_failed" in caplog.text
    assert "error_type=ValueError" in caplog.text
    assert "token_issued_in_future=True" in caplog.text
    assert "iat_offset_seconds=" in caplog.text
    assert diagnostic_token not in caplog.text
    assert "sensitive-authorization-code" not in caplog.text
    assert settings.google_client_secret not in caplog.text


@pytest.mark.parametrize("token_nonce", [None, "sensitive-wrong-nonce"])
@pytest.mark.asyncio
async def test_google_oauth_nonce_failure_is_logged_without_nonce(
    token_nonce,
    client,
    db_session,
    monkeypatch,
    caplog,
):
    start = await client.get("/auth/google/start", follow_redirects=False)
    parameters = parse_qs(urlsplit(start.headers["location"]).query)
    oauth_state = await db_session.scalar(select(OAuthState).where(OAuthState.state == parameters["state"][0]))
    assert oauth_state is not None

    monkeypatch.setattr(auth_routes.requests, "post", lambda *args, **kwargs: SuccessfulTokenResponse())
    monkeypatch.setattr(
        auth_routes.google_id_token,
        "verify_oauth2_token",
        lambda *args, **kwargs: {"nonce": token_nonce},
    )

    with caplog.at_level(logging.WARNING, logger=auth_routes.__name__):
        callback = await client.get(
            "/auth/google/callback",
            params={"state": oauth_state.state, "code": "mock-code"},
            follow_redirects=False,
        )

    assert callback.status_code == 400
    assert callback.json() == {"detail": "id_token verification failed"}
    assert "google_oauth_nonce_mismatch" in caplog.text
    assert oauth_state.nonce not in caplog.text
    if token_nonce:
        assert token_nonce not in caplog.text
