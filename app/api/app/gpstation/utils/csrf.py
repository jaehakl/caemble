from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time

from fastapi import HTTPException, Request, status

from settings import settings
from user_auth.utils.auth_utils import hash_token, random_urlsafe
from user_auth.utils.jwt import verify_token


CSRF_HEADER_NAME = "x-csrf-token"
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def require_web_csrf(request: Request) -> None:
    if request.method.upper() not in UNSAFE_METHODS:
        return
    refresh_token = request.cookies.get("refresh_token")
    csrf_token = request.headers.get(CSRF_HEADER_NAME)
    if not refresh_token or not csrf_token:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token required")
    try:
        verify_token(refresh_token, "refresh")
        session_hash = csrf_token_session_hash(csrf_token)
    except Exception as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid CSRF token") from error
    if not secrets.compare_digest(session_hash, refresh_session_hash(refresh_token)):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid CSRF token")


def make_csrf_token(refresh_token: str, expires_at: int | None = None) -> str:
    expires = str(expires_at if expires_at is not None else int(time.time()) + settings.CSRF_TTL_SEC)
    unsigned = f"{refresh_session_hash(refresh_token)}.{expires}.{random_urlsafe(16)}"
    return f"{unsigned}.{csrf_signature(unsigned)}"


def csrf_token_session_hash(token: str) -> str:
    parts = token.split(".")
    if len(parts) != 4:
        raise ValueError("Invalid CSRF token")
    session_hash, expires, nonce, signature = parts
    unsigned = f"{session_hash}.{expires}.{nonce}"
    if not secrets.compare_digest(signature, csrf_signature(unsigned)):
        raise ValueError("Invalid CSRF token")
    if int(expires) <= int(time.time()):
        raise ValueError("Expired CSRF token")
    return session_hash


def refresh_session_hash(refresh_token: str) -> str:
    return base64.urlsafe_b64encode(hash_token(refresh_token)).rstrip(b"=").decode("ascii")


def csrf_signature(unsigned: str) -> str:
    digest = hmac.new(
        settings.JWT_SECRET.encode("utf-8"),
        unsigned.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
