"""Atomic Experiment saves with independently owned, permanent preview results."""
import asyncio
import base64
import hashlib
import io
import json
from datetime import timedelta
from uuid import UUID, uuid4

from fastapi import HTTPException
from PIL import Image
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from db import (Experiment, ExperimentRecord, ExperimentSaveReceipt, ExperimentThumbnail,
                Measurement, MeasurementSnapshot, MeasurementVisualization, RecordedData)
from cae.db import CaeBatch
from gpstation.db import Job
from gpstation.service.state import utcnow
from settings import settings
from storage.db import StorageObject
from storage.service import bucket_client, object_refs, part_key, reference


def thumbnail_bytes(value):
    if value is None:
        return None
    try:
        prefix, encoded = value.split(",", 1)
        if prefix != "data:image/webp;base64":
            raise ValueError()
        data = base64.b64decode(encoded, validate=True)
        if not data or len(data) > 512 * 1024:
            raise ValueError()
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "WEBP" or image.width > 640 or image.height > 480 or image.width * 3 != image.height * 4:
                raise ValueError()
            image.load()
        return data
    except Exception as error:
        raise HTTPException(422, "썸네일은 640×480 이하, 4:3 비율, 512KiB 이하 WebP여야 합니다.") from error


async def copy_preflight_objects(db, value, *, job, measurement, copies):
    replacements = {}
    for ref in object_refs(value):
        if ref["id"] in replacements:
            continue
        source = await db.scalar(select(StorageObject).where(StorageObject.id == ref["id"]).with_for_update())
        if (source is None or not source.ready or source.deleting or source.user_id != job.user_id
                or source.job_id != job.id or source.experiment_id is not None or reference(source) != ref):
            raise HTTPException(410, "Preflight 저장 객체를 사용할 수 없습니다.")
        target = StorageObject(id=str(uuid4()), user_id=measurement.user_id, experiment_id=measurement.experiment_id,
                               measurement_id=measurement.id, purpose="measurement", manifest=source.manifest,
                               ready=True, bound=True, deleting=False, updated_at=utcnow())
        # Keep every attempted destination for rollback cleanup, including partial copies.
        copies.append({"id": target.id, "manifest": target.manifest, "user_id": target.user_id})
        def copy_parts():
            client = bucket_client()
            for index in range(len(source.manifest["chunks"])):
                client.copy_object(Bucket=settings.s3_bucket, Key=part_key(target, index),
                    CopySource={"Bucket": settings.s3_bucket, "Key": part_key(source, index)}, ChecksumAlgorithm="SHA256")
        await asyncio.to_thread(copy_parts)
        db.add(target)
        replacements[ref["id"]] = reference(target)

    def replace(item):
        if isinstance(item, dict):
            if item.get("kind") == "caemble.object":
                return replacements[item["id"]]
            return {key: replace(child) for key, child in item.items()}
        if isinstance(item, list):
            return [replace(child) for child in item]
        return item
    return replace(value)


async def promote_preflight(db, batch_id, experiment, user, copies):
    job = await db.scalar(select(Job).where(Job.batch_id == batch_id, Job.user_id == user.id).with_for_update())
    batch = await db.get(CaeBatch, batch_id)
    if job is None or batch is None or not batch.spec.get("preflight"):
        raise HTTPException(404, "Preflight를 찾을 수 없습니다.")
    if job.state != "succeeded" or job.finished_at is None:
        raise HTTPException(409, "완료된 Preflight만 함께 저장할 수 있습니다.")
    if job.finished_at + timedelta(hours=24) <= utcnow() or not job.input:
        raise HTTPException(410, "Preflight가 만료되었습니다. 다시 실행하거나 포함 옵션을 해제하세요.")
    frozen = job.input["measurement"]
    program = frozen["experiment"]["simulationProgram"]
    if (batch.spec.get("source_bundle") != experiment.source_bundle
            or batch.spec.get("source_hash") != experiment.source_hash
            or program["resultContracts"] != experiment.result_contracts):
        raise HTTPException(409, "Preflight 소스 또는 결과 계약이 저장할 Experiment와 다릅니다.")
    payload = job.artifact_metadata or {}
    records = payload.get("recorded_data")
    if not isinstance(records, dict) or set(records) != set(program["recordedData"]):
        raise HTTPException(410, "Preflight 결과가 유실되어 저장할 수 없습니다.")
    measurement = Measurement(user_id=experiment.user_id, experiment_id=experiment.id,
                              vars={}, material_snapshot={}, recorded_at=job.finished_at)
    db.add(measurement)
    await db.flush()
    artifact = job.input.get("artifact", {"measurement": frozen,
        **({"presentation": payload["presentation"]} if "presentation" in payload else {})})
    durable = await copy_preflight_objects(db, {"input": frozen, "artifact": artifact, "records": records,
        "visualizations": payload.get("visualizations", {}), "trace": payload.get("execution_trace", [])},
        job=job, measurement=measurement, copies=copies)
    frozen = durable["input"]
    measurement.vars = frozen["experiment"]["variables"]
    measurement.material_snapshot = {"experiment": frozen["materialSnapshot"], "tasks": frozen["taskMaterialSnapshots"],
        "modelDefinitions": frozen["modelDefinitions"], "selections": frozen["materialSelections"],
        "sourceHash": frozen["experiment"]["sourceHash"], "varsHash": frozen["varsHash"]}
    contracts = {row.name: row for row in (await db.scalars(select(ExperimentRecord).where(
        ExperimentRecord.experiment_id == experiment.id))).all()}
    for name, data in durable["records"].items():
        contract = contracts.get(name)
        if contract is None:
            raise HTTPException(409, "Preflight 결과의 ExperimentRecord가 없습니다.")
        db.add(RecordedData(user_id=measurement.user_id, measurement_id=measurement.id,
                            experiment_record_id=contract.id, data=data))
    for task, data in durable["visualizations"].items():
        db.add(MeasurementVisualization(measurement_id=measurement.id, task=task, data=data))
    db.add(MeasurementSnapshot(measurement_id=measurement.id, artifact=durable["artifact"], execution_trace=durable["trace"],
        metadata_json={"source_hash": experiment.source_hash, "catalog_revision": batch.spec.get("catalog_revision"),
                       "builder_version": batch.spec.get("builder_version"), "preflight_batch_id": batch_id}))
    return measurement.id


async def save_with_assets(db, request, user):
    from service.experiment import _derived_counts, _save_experiment
    image = thumbnail_bytes(request.thumbnail)
    copies = []
    try:
        request_id = str(UUID(request.requestId)) if request.requestId else None
        payload_hash = hashlib.sha256(json.dumps(request.model_dump(), sort_keys=True).encode()).hexdigest()
        if request_id:
            # One transaction at a time per request, without reversing owner/row locks.
            lock_key = int.from_bytes(hashlib.sha256(f"{user.id}:{request_id}".encode()).digest()[:8], "big", signed=True)
            await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_key})
            receipt = await db.get(ExperimentSaveReceipt, (user.id, request_id))
            if receipt:
                if receipt.payload_hash != payload_hash:
                    raise HTTPException(409, "같은 저장 요청 ID에 다른 내용을 사용할 수 없습니다.")
                result = receipt.response
                await db.commit()
                return result
        result = await _save_experiment(db, request, user=user, commit=False)
        experiment = await db.get(Experiment, result["id"])
        if image is not None:
            thumbnail = await db.get(ExperimentThumbnail, experiment.id)
            if thumbnail is None:
                thumbnail = ExperimentThumbnail(experiment_id=experiment.id)
                db.add(thumbnail)
            thumbnail.data = image
            thumbnail.sha256 = hashlib.sha256(image).hexdigest()
            experiment.thumbnail_url = f"/experiment/{experiment.id}/thumbnail?v={thumbnail.sha256}"
        if request.preflightBatchId:
            result["measurementId"] = await promote_preflight(db, request.preflightBatchId, experiment, user, copies)
        else:
            result["measurementId"] = None
        await db.flush()
        result["thumbnail_url"] = experiment.thumbnail_url
        result["derivedCounts"] = (await _derived_counts(db, [experiment.id]))[experiment.id]
        result["sourceLocked"] = result["derivedCounts"]["measurements"] > 0
        if request_id:
            db.add(ExperimentSaveReceipt(user_id=user.id, request_id=request_id, payload_hash=payload_hash, response=result))
        await db.commit()
        return result
    except Exception:
        await db.rollback()
        if copies:
            # A separate transaction leaves durable tombstones even when S3 removal
            # fails. No permanent result ever references these rolled-back copies.
            async with AsyncSession(db.bind) as cleanup:
                for copy in copies:
                    cleanup.add(StorageObject(**copy, purpose="measurement", ready=False, bound=False,
                        deleting=True, updated_at=utcnow() - timedelta(hours=25)))
                await cleanup.commit()
        raise
