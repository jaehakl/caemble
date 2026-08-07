from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from models import UserData
from service.user_sevice import UserService
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles

router = APIRouter(tags=["users"])


@router.get("/user_admin/get_all_users/{limit}/{offset}", response_model=list[UserData])
async def api_get_user_list(
    limit: int | None = None,
    offset: int | None = None,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_roles(["admin"])),
):
    return await UserService.get_users(limit, offset, db=db, user_id=user.id)


@router.get("/user_admin/delete/{id}")
async def api_delete_user(id: str, db: AsyncSession = Depends(get_db), user=Depends(require_roles(["admin"]))):
    return await UserService.delete_user(id, db=db, user_id=user.id)


@router.get("/user_data/summary/admin/{user_id}", response_model=UserData | None)
async def api_get_user_summary_admin(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_roles(["admin"])),
):
    return await UserService.get_user_summary(user_id, db=db, user_id=user.id)


@router.get("/user_data/summary/user", response_model=UserData | None)
async def api_get_user_summary_user(
    db: AsyncSession = Depends(get_db),
    user=Depends(require_roles(["admin", "user"])),
):
    return await UserService.get_user_summary("me", db=db, user_id=user.id)

