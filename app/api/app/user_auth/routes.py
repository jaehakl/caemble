import asyncio
import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import requests
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from google.auth import jwt as google_jwt
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from gpstation.utils.csrf import require_web_csrf
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from db import SessionLocal
from models import AuthenticatedUserData, ExperimentNamespaceRequest, UserData
from service.experiment import change_experiment_namespace
from settings import settings
from user_auth.db import Identity, OAuthProvider, OAuthState, Role, User, UserRole
from user_auth.utils.auth_utils import (
    pkce_challenge,
    pop_return_to_cookie,
    random_urlsafe,
    safe_return_to,
    set_return_to_cookie,
)
from user_auth.utils.jwt import make_access, make_refresh, verify_token

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPES = "openid email profile"
PROVIDER = OAuthProvider.google


async def get_db():
    async with SessionLocal() as db:
        try:
            yield db
        except Exception:
            await db.rollback()
            raise


def auth_cookie_kwargs() -> dict[str, object]:
    kwargs: dict[str, object] = {
        "httponly": True,
        "secure": settings.SECURE_COOKIES,
        "samesite": "lax",
    }
    if settings.COOKIE_DOMAIN:
        kwargs["domain"] = settings.COOKIE_DOMAIN
    return kwargs


def set_auth_cookies(resp: Response, access: str, refresh: str):
    kwargs = auth_cookie_kwargs()
    resp.set_cookie("access_token", access, max_age=settings.ACCESS_TTL_SEC, path="/", **kwargs)
    resp.set_cookie("refresh_token", refresh, max_age=settings.REFRESH_TTL_SEC, path="/", **kwargs)


def user_data(user: User) -> UserData:
    return UserData(
        id=str(user.id),
        email=user.email,
        display_name=user.display_name,
        picture_url=user.picture_url,
        is_active=user.is_active,
        created_at=user.created_at,
        updated_at=user.updated_at,
        experiment_namespace=user.experiment_namespace,
        roles=[entry.role.name for entry in user.user_roles],
    )


def authenticated_user_data(user: User) -> AuthenticatedUserData:
    return AuthenticatedUserData(**user_data(user).model_dump())


@router.get("/google/start")
async def google_start(return_to: str | None = None, db: AsyncSession = Depends(get_db)):
    state = random_urlsafe(32)
    nonce = random_urlsafe(32)
    code_verifier = random_urlsafe(64)
    db.add(OAuthState(
        provider=PROVIDER,
        state=state,
        nonce=nonce,
        code_verifier=code_verifier,
        redirect_uri=settings.google_redirect_uri,
    ))
    await db.commit()

    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.google_redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "state": state,
        "nonce": nonce,
        "code_challenge": pkce_challenge(code_verifier),
        "code_challenge_method": "S256",
    }
    response = RedirectResponse(f"{AUTH_URL}?{urlencode(params)}")
    set_return_to_cookie(response, return_to)
    return response


@router.get("/google/callback")
async def google_callback(request: Request, state: str = "", code: str = "", db: AsyncSession = Depends(get_db)):
    if not state or not code:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "missing state or code")

    created_after = datetime.now(timezone.utc) - timedelta(seconds=settings.oauth_state_ttl_sec)
    oauth_state = await db.scalar(select(OAuthState).where(
        OAuthState.state == state,
        OAuthState.provider == PROVIDER,
        OAuthState.consumed_at.is_(None),
        OAuthState.created_at >= created_after,
    ))
    if not oauth_state:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid, expired, or used state")

    oauth_state.consumed_at = datetime.now(timezone.utc)
    await db.commit()
    token_response = await asyncio.to_thread(requests.post, TOKEN_URL, data={
        "code": code,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "redirect_uri": oauth_state.redirect_uri or settings.google_redirect_uri,
        "grant_type": "authorization_code",
        "code_verifier": oauth_state.code_verifier,
    }, timeout=10)
    if token_response.status_code != 200:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "token exchange failed")
    id_token_value = token_response.json().get("id_token")
    if not id_token_value:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "token response missing id_token")

    try:
        idinfo = await asyncio.to_thread(
            google_id_token.verify_oauth2_token,
            id_token_value,
            google_requests.Request(),
            settings.google_client_id,
            clock_skew_in_seconds=settings.google_id_token_clock_skew_sec,
        )
    except Exception as error:
        issuer_valid = audience_valid = token_expired = token_issued_in_future = None
        iat_offset_seconds = nonce_present = nonce_matches = None
        try:
            unverified_claims = google_jwt.decode(id_token_value, verify=False)
            issuer_valid = unverified_claims.get("iss") in {"accounts.google.com", "https://accounts.google.com"}
            audience = unverified_claims.get("aud")
            audience_valid = (
                settings.google_client_id in audience
                if isinstance(audience, list)
                else audience == settings.google_client_id
            )
            now = int(datetime.now(timezone.utc).timestamp())
            expires_at = unverified_claims.get("exp")
            token_expired = (
                expires_at <= now
                if isinstance(expires_at, (int, float))
                else None
            )
            issued_at = unverified_claims.get("iat")
            token_issued_in_future = issued_at > now if isinstance(issued_at, (int, float)) else None
            iat_offset_seconds = issued_at - now if isinstance(issued_at, (int, float)) else None
            token_nonce = unverified_claims.get("nonce")
            nonce_present = isinstance(token_nonce, str) and bool(token_nonce)
            nonce_matches = token_nonce == oauth_state.nonce if oauth_state.nonce else None
        except Exception:
            pass
        logger.warning(
            "google_oauth_id_token_verification_failed "
            "error_type=%s issuer_valid=%s audience_valid=%s token_expired=%s "
            "token_issued_in_future=%s iat_offset_seconds=%s nonce_present=%s nonce_matches=%s",
            type(error).__name__,
            issuer_valid,
            audience_valid,
            token_expired,
            token_issued_in_future,
            iat_offset_seconds,
            nonce_present,
            nonce_matches,
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "id_token verification failed") from error
    if oauth_state.nonce and idinfo.get("nonce") != oauth_state.nonce:
        logger.warning(
            "google_oauth_nonce_mismatch expected_nonce_present=%s token_nonce_present=%s",
            True,
            isinstance(idinfo.get("nonce"), str) and bool(idinfo.get("nonce")),
        )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "id_token verification failed")

    provider_user_id = idinfo.get("sub")
    if not isinstance(provider_user_id, str) or not provider_user_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "id_token missing sub")
    email = idinfo.get("email")
    email_verified = bool(idinfo.get("email_verified", False))
    identity = await db.scalar(select(Identity).where(
        Identity.provider == PROVIDER,
        Identity.provider_user_id == provider_user_id,
    ))
    user = await db.get(User, identity.user_id) if identity else None
    if identity and not user:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "identity user not found")

    if not user and isinstance(email, str) and email_verified:
        user = await db.scalar(select(User).where(func.lower(User.email) == email.lower()))
    if not user:
        user = User(
            email=email if isinstance(email, str) else None,
            email_verified_at=datetime.now(timezone.utc) if email_verified else None,
            display_name=idinfo.get("name"),
            picture_url=idinfo.get("picture"),
            is_active=True,
        )
        db.add(user)
        await db.flush()

    if not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User inactive")
    user.display_name = idinfo.get("name") or user.display_name
    user.picture_url = idinfo.get("picture") or user.picture_url
    if isinstance(email, str) and email_verified:
        user.email = email
        user.email_verified_at = user.email_verified_at or datetime.now(timezone.utc)

    role = await db.scalar(select(Role).where(Role.name == "user"))
    if not role:
        role = Role(name="user")
        db.add(role)
        await db.flush()
    if not await db.get(UserRole, (user.id, role.id)):
        db.add(UserRole(user_id=user.id, role_id=role.id))

    if not identity:
        identity = Identity(
            user_id=user.id,
            provider=PROVIDER,
            provider_user_id=provider_user_id,
        )
        db.add(identity)
    identity.email = email if isinstance(email, str) else None
    identity.email_verified = email_verified
    identity.raw_profile = idinfo
    await db.commit()

    user = await db.scalar(select(User).options(
        selectinload(User.user_roles).selectinload(UserRole.role),
    ).where(User.id == user.id))
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User inactive")

    response = RedirectResponse(safe_return_to(request.cookies.get("rt")))
    set_auth_cookies(response, make_access(user), make_refresh(str(user.id)))
    pop_return_to_cookie(response)
    return response


@router.get("/me", response_model=AuthenticatedUserData)
async def check_user(request: Request, db: AsyncSession = Depends(get_db)) -> AuthenticatedUserData:
    token = request.cookies.get("access_token")
    if not token:
        authorization = request.headers.get("Authorization", "")
        if authorization.lower().startswith("bearer "):
            token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")

    try:
        claims = verify_token(token, "access")
    except Exception as error:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid access token") from error
    user = await db.scalar(select(User).options(
        selectinload(User.user_roles).selectinload(UserRole.role),
    ).where(User.id == claims["sub"]).execution_options(populate_existing=True))
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User inactive")
    return authenticated_user_data(user)


@router.put("/experiment-namespace", response_model=AuthenticatedUserData)
async def set_experiment_namespace(
    payload: ExperimentNamespaceRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _csrf: None = Depends(require_web_csrf),
) -> AuthenticatedUserData:
    authenticated = await check_user(request, db)
    user = await change_experiment_namespace(
        db,
        authenticated.id,
        payload.namespace,
    )
    return authenticated_user_data(user)


@router.get("/refresh")
async def refresh(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    refresh_token = request.cookies.get("refresh_token")
    if not refresh_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No refresh token")
    try:
        claims = verify_token(refresh_token, "refresh")
    except Exception as error:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token") from error

    user = await db.scalar(select(User).options(
        selectinload(User.user_roles).selectinload(UserRole.role),
    ).where(User.id == claims["sub"]))
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User inactive")
    set_auth_cookies(response, make_access(user), make_refresh(str(user.id)))
    return {"ok": True}


@router.post("/logout")
async def logout(response: Response):
    kwargs = auth_cookie_kwargs()
    response.delete_cookie("access_token", path="/", **kwargs)
    response.delete_cookie("refresh_token", path="/", **kwargs)
    return {"ok": True}
