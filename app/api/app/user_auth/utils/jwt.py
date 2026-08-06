import time
import uuid
from typing import Any, Dict, Literal

import jwt

from settings import settings
from user_auth.db import User


def _now() -> int:
    return int(time.time())


def make_token(sub: str, ttl_sec: int, token_type: Literal["access", "refresh"], extra: Dict[str, Any] | None = None) -> str:
    now = _now()
    payload = {
        "sub": sub,
        "typ": token_type,
        "iat": now,
        "nbf": now - 5,
        "exp": now + ttl_sec,
        "jti": str(uuid.uuid4()),
        **(extra or {}),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALG)


def make_access(user: User) -> str:
    roles = [user_role.role.name for user_role in user.user_roles]
    return make_token(
        str(user.id),
        settings.ACCESS_TTL_SEC,
        "access",
        {
            "roles": roles,
            "email": user.email,
            "display_name": user.display_name,
            "picture_url": user.picture_url,
        },
    )


def make_refresh(user_id: str) -> str:
    return make_token(user_id, settings.REFRESH_TTL_SEC, "refresh")


def verify_token(token: str, expected_type: Literal["access", "refresh"] | None = None) -> Dict[str, Any]:
    claims = jwt.decode(
        token,
        settings.JWT_SECRET,
        algorithms=[settings.JWT_ALG],
        options={"require": ["exp", "iat", "nbf", "sub", "typ"]},
        leeway=30,
    )
    if expected_type is not None and claims.get("typ") != expected_type:
        raise jwt.InvalidTokenError(f"Expected a {expected_type} token")
    return claims
