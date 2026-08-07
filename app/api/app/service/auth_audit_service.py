from __future__ import annotations

from typing import Any

from starlette.requests import Request

from user_auth.db import AuthAudit, OAuthProvider


def add_auth_audit(
    db,
    event: str,
    request: Request | None = None,
    *,
    user_id: str | None = None,
    provider: OAuthProvider | None = None,
    details: dict[str, Any] | None = None,
    client_ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    db.add(
        AuthAudit(
            user_id=user_id,
            provider=provider,
            event=event,
            ip=request.client.host if request and request.client else client_ip,
            user_agent=request.headers.get("user-agent") if request else user_agent,
            details=details,
        )
    )
