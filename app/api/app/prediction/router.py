"""HTTP facade for owned Prediction assets and scoped Dataset downloads."""
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from db import get_db
from gpstation.utils.csrf import require_web_csrf
from prediction import datasets, grants, lifecycle, models, operations, replicas
from prediction.common import canonical_bytes
from prediction.schemas import (DatasetGrantRequest, DatasetSelection, DeleteRequest,
    LocalDatasetRegistration, ModelComplete, ModelLeaseRequest, ModelReserve, StorageRegistration,
    ArchiveUpload, AssetRename, OperationComplete, OperationCreate, ReplicaRegistration)
from prediction.schemas import TrainingSubmit, TrainingRetry, TrainingPreflight, TrainingPinReceipt
from user_auth.schemas import UserData
from user_auth.utils.auth_wrapper import require_roles

router = APIRouter(prefix="/prediction", tags=["prediction"], dependencies=[Depends(require_web_csrf)])
authenticated = require_roles(["admin", "user"])


@router.get("/algorithms")
async def algorithms(launcher_id: UUID | None = None, db: AsyncSession = Depends(get_db),
                     user: UserData = Depends(authenticated)):
    from gpstation.db import Launcher
    from prediction.resources import resolve_resources
    from prediction_contracts import ALGORITHMS, algorithm_descriptor
    launcher = await db.get(Launcher, str(launcher_id)) if launcher_id is not None else None
    if launcher_id is not None and (launcher is None or launcher.user_id != user.id):
        raise HTTPException(404, "Predictor Launcher not found.")
    items = [algorithm_descriptor(kind) for kind in ALGORITHMS]
    if launcher is not None:
        for item in items:
            item["resources"] = {purpose: resolve_resources(item["kind"], purpose, launcher.resources or {})
                                 for purpose in ("training", "inference")}
    return {"items": items}


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
    return await models.complete_model(db, str(model_id), revision, body, user.id, publish=False)


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


@router.patch("/datasets/{dataset_id}")
async def rename_dataset(dataset_id: UUID, body: AssetRename, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await lifecycle.rename_asset(db, "dataset", str(dataset_id), body.name, user.id)


@router.patch("/models/{model_id}")
async def rename_model(model_id: UUID, body: AssetRename, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await lifecycle.rename_asset(db, "model", str(model_id), body.name, user.id)


@router.post("/datasets/{dataset_id}/preview")
async def preview_dataset(dataset_id: UUID, body: DatasetSelection, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await datasets.preview_source(db, str(dataset_id), body, user.id)


@router.post("/replicas/check")
async def check_replica(body: ReplicaRegistration, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await replicas.check_replica(db, body, user.id)


@router.get("/operations")
async def list_operations(experiment_id: int | None = None, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await operations.list_operations(db, user.id, experiment_id)


@router.post("/operations")
async def create_operation(body: OperationCreate, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    return await operations.create_operation(db, body, user.id)


@router.get("/operations/{operation_id}")
async def get_operation(operation_id: UUID, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    from gpstation.service.batches import serialize_events
    await serialize_events(db)
    row = await operations.owned_operation(db, str(operation_id), user.id)
    if row.kind.startswith("delete_") and row.state != "completed":
        await operations.process_cloud_deletions(db, row)
    await operations.expire_operation(db, row)
    from prediction.training import operation_view
    return await operation_view(db, row)


@router.post("/operations/{operation_id}/submit")
async def submit_training(operation_id: UUID, body: TrainingSubmit, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    from prediction.training import submit
    return await submit(db, str(operation_id), user.id, pin_id=body.pin_id)


@router.post("/operations/{operation_id}/training/preflight")
async def preflight_training(operation_id: UUID, body: TrainingPreflight, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    from prediction.training import preflight
    return await preflight(db, str(operation_id), body.request_id, user.id)


@router.post("/operations/{operation_id}/retry")
async def retry_training(operation_id: UUID, body: TrainingRetry, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    from prediction.training import submit
    return await submit(db, str(operation_id), user.id, pin_id=body.pin_id, retry_request_id=body.request_id)


@router.get("/operations/{operation_id}/training")
async def training_authority(operation_id: UUID, authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    from prediction.training import authority
    _, _, result = await authority(db, str(operation_id), authorization)
    return result


@router.post("/operations/{operation_id}/training/pinned")
async def acknowledge_training_pin(operation_id: UUID, body: TrainingPinReceipt, authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    from prediction.training import acknowledge_pin
    return await acknowledge_pin(db, str(operation_id), authorization, body.pinId, body.artifactSaved)


@router.get("/training/jobs/{job_id}/attempts/{attempt_id}/dataset")
async def training_dataset(job_id: UUID, attempt_id: UUID, authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    from prediction.training import dataset_access
    return await dataset_access(db, str(job_id), str(attempt_id), authorization)


@router.post("/operations/{operation_id}/grants")
async def operation_grant(operation_id: UUID, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    row = await operations.owned_operation(db, str(operation_id), user.id)
    if row.kind == "prepare":
        raise HTTPException(409, "Use the training preflight and retry endpoints for model preparation.")
    await operations.issue_grant(db, row, retry=True)
    if row.kind.startswith("delete_"):
        await operations.process_cloud_deletions(db, row)
    return await operations.operation_response(db, row)


@router.post("/operations/{operation_id}/cancel")
async def cancel_operation(operation_id: UUID, db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    from prediction.training import cancel_operation
    return await cancel_operation(db, str(operation_id), user.id)


@router.post("/operations/{operation_id}/interrupt")
async def interrupt_operation(operation_id: UUID, body: dict = Body(default={}), db: AsyncSession = Depends(get_db), user: UserData = Depends(authenticated)):
    row = await operations.owned_operation(db, str(operation_id), user.id)
    if row.kind == "prepare":
        raise HTTPException(409, "Browser disconnection does not interrupt server-owned training.")
    return await operations.stop_operation(db, row, error=str(body.get("error", "Connection interrupted."))[:1000])


@router.get("/operations/{operation_id}/transfer")
async def transfer_manifest(operation_id: UUID, authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    row = await operations.granted_operation(db, str(operation_id), authorization)
    return await operations.transfer_manifest(db, row)


@router.post("/operations/{operation_id}/grant/renew")
async def renew_operation_grant(operation_id: UUID, authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    row = await operations.granted_operation(db, str(operation_id), authorization, renew=True)
    return await operations.issue_grant(db, row)


@router.post("/operations/{operation_id}/archives/{slot}/uploads")
async def prepare_archive(operation_id: UUID, slot: str, body: ArchiveUpload, authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    row = await operations.granted_operation(db, str(operation_id), authorization)
    return await operations.prepare_archive(db, row, slot, body)


@router.post("/operations/{operation_id}/archives/{slot}/complete")
async def complete_archive(operation_id: UUID, slot: str, authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    row = await operations.granted_operation(db, str(operation_id), authorization)
    return await operations.complete_archive(db, row, slot)


@router.post("/operations/{operation_id}/complete")
async def complete_operation(operation_id: UUID, body: OperationComplete, request: Request,
        authorization: str = Header(default=""), db: AsyncSession = Depends(get_db)):
    # This one endpoint supports the operation-only worker credential and the
    # authenticated UI replaying a durable receipt after a lost response.
    token = authorization.removeprefix("Bearer ")
    import jwt
    try:
        claims = jwt.decode(token, options={"verify_signature": False}) if token else {}
    except jwt.InvalidTokenError:
        claims = {}
    if claims.get("typ") == "prediction_operation":
        row = await operations.granted_operation(db, str(operation_id), authorization)
    else:
        from user_auth.session import check_user
        user = await authenticated(await check_user(request, db))
        row = await operations.owned_operation(db, str(operation_id), user.id)
    return await operations.complete_operation(db, row, body)
