from uuid import UUID

from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from db import get_db
from gpstation.utils.csrf import require_web_csrf
from storage import objects
from user_auth.schemas import UserData
from user_auth.utils.auth_wrapper import require_roles

router = APIRouter(prefix="/storage", tags=["storage"], dependencies=[Depends(require_web_csrf)])


@router.post("/uploads")
async def prepare(body: dict = Body(), db: AsyncSession = Depends(get_db),
                  user: UserData = Depends(require_roles(["admin", "user"]))):
    return await objects.prepare(body, db, user)


@router.post("/uploads/{object_id}/complete")
async def complete(object_id: UUID, db: AsyncSession = Depends(get_db),
                   user: UserData = Depends(require_roles(["admin", "user"]))):
    return await objects.complete(object_id, db, user)


@router.get("/objects/{object_id}")
async def read(object_id: UUID, db: AsyncSession = Depends(get_db),
               user: UserData | None = Depends(require_roles(["*"]))):
    return await objects.read(object_id, db, user)
