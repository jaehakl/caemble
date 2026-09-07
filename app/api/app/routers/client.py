from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from models import UserData
from service.data_tools import VisibleDataError, VisibleDataReader
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles

router = APIRouter(tags=["client"])
authenticated = require_roles(["admin", "user"])
Resource = Literal["material", "experiment", "calculation", "measurement", "recorded_data"]


@router.get("/client/capabilities")
async def capabilities(request: Request, user: UserData = Depends(authenticated)):
    return {"protocol": 1, "builder_version": "1",
            "catalog_revision": request.app.state.catalog.meta()["catalogRevision"],
            "chunk_bytes": 8 * 1024 * 1024,
            "authentication": ["cookie", "caemble"], "server_prepare": False}


@router.get("/data/search")
async def search(
    resource: Resource, query: str = "", limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated),
):
    return await VisibleDataReader(db, user.id).search(resource, query, limit)


@router.get("/data/{resource}/{resource_id}")
async def detail(
    resource: Resource, resource_id: int, db: AsyncSession = Depends(get_db),
    user: UserData = Depends(authenticated),
):
    try:
        return await VisibleDataReader(db, user.id).detail(resource, resource_id)
    except VisibleDataError as error:
        raise HTTPException(404, str(error)) from error


@router.get("/data/recorded_data/{resource_id}/slice")
async def recorded_slice(
    resource_id: int, offset: int = Query(0, ge=0), count: int = Query(100, ge=1, le=10000),
    db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated),
):
    try:
        return await VisibleDataReader(db, user.id).read_recorded_slice(resource_id, offset, count)
    except VisibleDataError as error:
        raise HTTPException(422, str(error)) from error
