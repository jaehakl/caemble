from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from models import GpsAccessTokenData
from user_auth.db import User
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles


router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/gps-access-token", response_model=GpsAccessTokenData)
async def get_gps_access_token(
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_roles(["admin"])),
):
    user = await db.get(User, current_user.id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return GpsAccessTokenData(gps_access_token=user.gps_access_token)


@router.post("/gps-access-token", response_model=GpsAccessTokenData)
async def update_gps_access_token(
    payload: GpsAccessTokenData,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_roles(["admin"])),
):
    user = await db.get(User, current_user.id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    token = payload.gps_access_token.strip() if payload.gps_access_token else None
    user.gps_access_token = token or None
    await db.commit()
    return GpsAccessTokenData(gps_access_token=user.gps_access_token)
