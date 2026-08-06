import base64
import hashlib
import os
from urllib.parse import urljoin, urlsplit

from fastapi import Response

from settings import settings


def random_urlsafe(nbytes: int = 32) -> str:
    return base64.urlsafe_b64encode(os.urandom(nbytes)).rstrip(b"=").decode("ascii")


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode("utf-8")).digest()


def safe_return_to(url: str | None) -> str:
    if not url:
        return settings.app_base_url
    candidate = urljoin(f"{settings.app_base_url}/", url) if url.startswith("/") and not url.startswith("//") else url
    parsed = urlsplit(candidate)
    allowed_origins = {settings.app_base_url, *settings.allowed_app_origins}
    origin = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or origin not in allowed_origins:
        return settings.app_base_url
    return candidate


def return_cookie_kwargs() -> dict[str, object]:
    kwargs: dict[str, object] = {
        "httponly": True,
        "secure": settings.SECURE_COOKIES,
        "samesite": "lax",
        "path": "/",
    }
    if settings.COOKIE_DOMAIN:
        kwargs["domain"] = settings.COOKIE_DOMAIN
    return kwargs


def set_return_to_cookie(resp: Response, url: str | None):
    resp.set_cookie(key="rt", value=safe_return_to(url), max_age=settings.oauth_state_ttl_sec, **return_cookie_kwargs())


def pop_return_to_cookie(resp: Response):
    resp.delete_cookie(key="rt", **return_cookie_kwargs())
