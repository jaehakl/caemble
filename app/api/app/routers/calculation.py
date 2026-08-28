from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Calculation, Experiment
from models import (
    CalculationBase,
    CalculationListRequest,
    GetListResponseBase,
    UpsertResponseBase,
    UserData,
)
from user_auth.routes import get_db
from user_auth.utils.auth_wrapper import require_roles
from utils.crud import (
    CrudSpec,
    delete_items,
    get_list_response,
    get_scope_owner_ids,
    upsert_items,
)


router = APIRouter(prefix="/calculation", tags=["calculation"])
CRUD_SPEC = CrudSpec(
    model=Calculation,
    schema=CalculationBase,
    scope_path=("experiment",),
)


@router.post("/list", response_model=GetListResponseBase)
async def list_calculations(
    request: CalculationListRequest,
    db: AsyncSession = Depends(get_db),
    user: UserData | None = Depends(require_roles(["*"])),
):
    experiment_id = request.experiment_id
    if experiment_id is None:
        bounds = (request.filter or {}).get("experiment_id", [])
        if (
            len(bounds) >= 2
            and isinstance(bounds[0], int)
            and not isinstance(bounds[0], bool)
            and bounds[0] == bounds[1]
        ):
            experiment_id = bounds[0]
    if experiment_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Calculation list requires one Experiment.",
        )

    request.sort = ["updated_at", "desc"]
    request.random = False
    return await get_list_response(
        db,
        request,
        CRUD_SPEC,
        Calculation.experiment_id == experiment_id,
        user=user,
    )


@router.post("/upsert", response_model=list[UpsertResponseBase])
async def upsert_calculations(
    items: list[CalculationBase],
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    normalized_items: list[CalculationBase] = []
    for item in items:
        name = item.name.strip()
        if not name:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Calculation name is required.",
            )
        normalized_items.append(item.model_copy(update={"name": name}))

    experiment_ids = {item.experiment_id for item in normalized_items}
    if experiment_ids:
        await db.execute(
            select(Experiment.id)
            .where(Experiment.id.in_(experiment_ids))
            .order_by(Experiment.id)
            .with_for_update()
        )

    supplied_ids = [item.id for item in normalized_items if item.id is not None]
    existing_experiment_ids = dict(
        (
            await db.execute(
                select(Calculation.id, Calculation.experiment_id).where(
                    Calculation.id.in_(supplied_ids)
                )
            )
        ).all()
    )
    owner_ids = await get_scope_owner_ids(db, CRUD_SPEC, supplied_ids)
    admin = any(
        getattr(role, "value", role) == "admin" for role in (user.roles or [])
    )
    for item in normalized_items:
        if item.id is None or item.id not in existing_experiment_ids:
            continue
        if not admin and owner_ids.get(item.id) != user.id:
            continue
        if existing_experiment_ids[item.id] != item.experiment_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Calculation cannot be moved to another Experiment.",
            )
    return await upsert_items(db, normalized_items, CRUD_SPEC, user=user)


@router.delete("/", status_code=200)
async def delete_calculations(
    ids: list[int] = Body(...),
    db: AsyncSession = Depends(get_db),
    user: UserData = Depends(require_roles(["admin", "user"])),
):
    experiment_ids = set(
        (
            await db.scalars(
                select(Calculation.experiment_id).where(Calculation.id.in_(ids))
            )
        ).all()
    )
    if experiment_ids:
        await db.execute(
            select(Experiment.id)
            .where(Experiment.id.in_(experiment_ids))
            .order_by(Experiment.id)
            .with_for_update()
        )
    await delete_items(db, CRUD_SPEC, ids, user=user)
    return None
