"""Access token issuance uses the application's account and scope policy."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from db import get_db
from gpstation.models import AccessKeyCreateResult
from gpstation.utils.csrf import require_web_csrf
from user_auth.access_keys import create_access_token
from user_auth.schemas import AccessKeyCreate, UserData
from user_auth.utils.auth_wrapper import require_roles

router = APIRouter(prefix="/web", dependencies=[Depends(require_web_csrf)])


@router.post(
    "/users/me/access-tokens",
    response_model=AccessKeyCreateResult,
    tags=["web-users"],
)
async def create_my_access_token(
    payload: AccessKeyCreate,
    db: AsyncSession = Depends(get_db),
    current_user: UserData = Depends(require_roles(["admin", "user"])),
) -> AccessKeyCreateResult:
    return await create_access_token(db, current_user.id, payload)


@router.post(
    "/users/{user_id}/access-tokens",
    response_model=AccessKeyCreateResult,
    tags=["web-users"],
)
async def create_user_access_token(
    user_id: str,
    payload: AccessKeyCreate,
    db: AsyncSession = Depends(get_db),
    _current_user: UserData = Depends(require_roles(["admin"])),
) -> AccessKeyCreateResult:
    return await create_access_token(db, user_id, payload)

