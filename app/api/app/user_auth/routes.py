"""HTTP entry points for user sessions."""
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from db import get_db
from user_auth import oauth, session
from user_auth.schemas import UserData

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/google/start")
async def google_start(return_to: str | None = None, db: AsyncSession = Depends(get_db)):
    return await oauth.google_start(return_to, db)


@router.get("/google/callback")
async def google_callback(request: Request, state: str = "", code: str = "", db: AsyncSession = Depends(get_db)):
    return await oauth.google_callback(request, state, code, db)


@router.get("/me", response_model=UserData)
async def check_user(request: Request, db: AsyncSession = Depends(get_db)) -> UserData:
    return await session.check_user(request, db)


@router.get("/refresh")
async def refresh(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    return await oauth.refresh(request, response, db)


@router.post("/logout")
async def logout(response: Response):
    return await oauth.logout(response)
