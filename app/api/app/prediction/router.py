"""HTTP facade for owned Prediction assets and scoped Dataset downloads."""
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Response
from sqlalchemy.ext.asyncio import AsyncSession

from db import get_db
from gpstation.utils.csrf import require_web_csrf
from prediction import datasets, grants, lifecycle, models
from prediction.common import canonical_bytes
from prediction.schemas import (DatasetGrantRequest, DatasetSelection, DeleteRequest,
    LocalDatasetRegistration, ModelComplete, ModelLeaseRequest, ModelReserve, StorageRegistration)
from user_auth.schemas import UserData
from user_auth.utils.auth_wrapper import require_roles

router = APIRouter(prefix="/prediction", tags=["prediction"], dependencies=[Depends(require_web_csrf)])
authenticated = require_roles(["admin", "user"])


@router.get("/datasets")
async def list_datasets(experiment_id: int | None = None, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await datasets.list_datasets(db, user.id, experiment_id)


@router.post("/datasets")
async def create_dataset(body: DatasetSelection, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await datasets.freeze_dataset(db, body, user.id)


@router.post("/datasets/local")
async def register_local_dataset(body: LocalDatasetRegistration, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await datasets.register_local_dataset(db, body, user.id)


@router.post("/datasets/{dataset_id}/sync")
async def sync_dataset(dataset_id: UUID, body: DatasetSelection, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await datasets.freeze_dataset(db, body, user.id, str(dataset_id))


@router.post("/datasets/{dataset_id}/grants")
async def dataset_grant(dataset_id: UUID, body: DatasetGrantRequest, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await grants.create_grant(db, str(dataset_id), body.revision, user.id)


@router.get("/datasets/{dataset_id}/revisions/{revision}/manifest")
async def dataset_manifest(dataset_id: UUID, revision: int, authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    item = await grants.read_granted_revision(db, str(dataset_id), revision, authorization)
    return Response(canonical_bytes(item.payload), media_type="application/json")


@router.post("/datasets/{dataset_id}/grants/{grant_id}/release")
async def release_dataset_grant(dataset_id: UUID, grant_id: UUID, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await grants.release_grant(db, str(dataset_id), str(grant_id), user.id)


@router.post("/datasets/{dataset_id}/revisions/{revision}/grant/renew")
async def renew_dataset_grant(dataset_id: UUID, revision: int, authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    return await grants.renew_grant(db, str(dataset_id), revision, authorization)


@router.get("/datasets/{dataset_id}/revisions/{revision}/objects/{object_id}")
async def dataset_object(dataset_id: UUID, revision: int, object_id: UUID, authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    return await grants.read_granted_object(db, str(dataset_id), revision, str(object_id), authorization)


@router.post("/datasets/{dataset_id}/delete")
async def delete_dataset(dataset_id: UUID, body: DeleteRequest, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await lifecycle.delete_asset(db, "dataset", str(dataset_id), body, user.id)


@router.post("/datasets/{dataset_id}/delete/complete")
async def complete_dataset_delete(dataset_id: UUID, body: DeleteRequest, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await lifecycle.delete_asset(db, "dataset", str(dataset_id), body, user.id, complete=True)


@router.get("/models")
async def list_models(experiment_id: int | None = None, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await models.list_models(db, user.id, experiment_id)


@router.post("/models/reserve")
async def reserve_model(body: ModelReserve, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await models.reserve_model(db, body, user.id)


@router.post("/models/{model_id}/revisions/{revision}/complete")
async def complete_model(model_id: UUID, revision: int, body: ModelComplete, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await models.complete_model(db, str(model_id), revision, body, user.id)


@router.post("/models/{model_id}/delete")
async def delete_model(model_id: UUID, body: DeleteRequest, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await lifecycle.delete_asset(db, "model", str(model_id), body, user.id)


@router.post("/models/{model_id}/leases")
async def lease_model(model_id: UUID, body: ModelLeaseRequest, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await models.lease_model(db, str(model_id), body, user.id)


@router.post("/models/{model_id}/leases/release")
async def release_model_lease(model_id: UUID, body: ModelLeaseRequest, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await models.lease_model(db, str(model_id), body, user.id, release=True)


@router.post("/models/{model_id}/delete/complete")
async def complete_model_delete(model_id: UUID, body: DeleteRequest, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await lifecycle.delete_asset(db, "model", str(model_id), body, user.id, complete=True)


@router.get("/storages")
async def list_storages(db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await lifecycle.list_storages(db, user.id)


@router.post("/storages")
async def register_storage(body: StorageRegistration, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await lifecycle.register_storage(db, body, user.id)
