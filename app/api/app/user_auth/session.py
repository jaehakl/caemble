"""Shared user authentication and cookie session policy."""
from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from db import get_db
from settings import settings
from user_auth.db import User, UserRole
from user_auth.schemas import UserData
from user_auth.utils.jwt import verify_token

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
        experiment_namespaces=sorted(item.namespace for item in user.experiment_namespaces),
        roles=[entry.role.name for entry in user.user_roles],
    )


async def check_user(request: Request, db: AsyncSession = Depends(get_db)) -> UserData:
    authorization = request.headers.get("Authorization", "")
    if authorization.lower().startswith("bearer csk_"):
        from user_auth.access_keys import authenticate_caemble

        return await authenticate_caemble(request, db, authorization)
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
    return user_data(user)

