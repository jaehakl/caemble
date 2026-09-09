from __future__ import annotations

import asyncio
import base64
from datetime import timedelta
from functools import lru_cache
import hashlib
import json
from uuid import UUID, uuid5

from botocore.config import Config
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from db import Calculation, Measurement
from gpstation.db import Job
from gpstation.service.state import utcnow
from settings import settings
from storage.db import StorageObject

INLINE_BYTES = 64 * 1024
CHUNK_BYTES = 8 * 1024 * 1024


@lru_cache(maxsize=1)
def bucket_client():
    import boto3

    if not all((settings.s3_bucket, settings.aws_region, settings.aws_access_key_id, settings.aws_secret_access_key)):
        raise HTTPException(503, "AWS Bucket configuration is missing.")
    return boto3.client(
        "s3", region_name=settings.aws_region,
        endpoint_url=settings.s3_endpoint_url or None,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}, connect_timeout=10, read_timeout=30,
                      retries={"max_attempts": 2, "mode": "standard"}),
    )


def object_refs(value):
    if isinstance(value, dict):
        if value.get("kind") == "caemble.object":
            yield value
        else:
            for item in value.values():
                yield from object_refs(item)
    elif isinstance(value, list):
        for item in value:
            yield from object_refs(item)


def validate_manifest(value: dict) -> dict:
    try:
        if value["encoding"] not in {"json", "base64"}:
            raise ValueError()
        size = value["byteLength"]
        if type(size) is not int or size <= 0:
            raise ValueError()
        hashes = [value["sha256"], *(part["sha256"] for part in value["chunks"])]
        if any(not isinstance(h, str) or len(h) != 64 or any(c not in "0123456789abcdef" for c in h) for h in hashes):
            raise ValueError()
        expected_count = (size + CHUNK_BYTES - 1) // CHUNK_BYTES
        if len(value["chunks"]) != expected_count:
            raise ValueError()
        for index, part in enumerate(value["chunks"]):
            if type(part["byteLength"]) is not int or part["byteLength"] != min(CHUNK_BYTES, size - index * CHUNK_BYTES):
                raise ValueError()
        if "length" in value and (type(value["length"]) is not int or value["length"] < 0):
            raise ValueError()
        return {key: value[key] for key in ("encoding", "sha256", "byteLength", "chunks", "length") if key in value}
    except (KeyError, TypeError, ValueError):
        raise HTTPException(422, "Invalid object manifest.") from None


def reference(row: StorageObject) -> dict:
    return {"kind": "caemble.object", "version": 1, "id": row.id,
            **{key: value for key, value in row.manifest.items() if key != "chunks"}}


def part_key(row: StorageObject, index: int) -> str:
    return f"caemble/objects/{row.id}/{index:08d}"


def signed_parts(row: StorageObject, *, upload: bool) -> list[dict]:
    client = bucket_client()
    result = []
    for index, part in enumerate(row.manifest["chunks"]):
        params = {"Bucket": settings.s3_bucket, "Key": part_key(row, index)}
        headers = {}
        if upload:
            checksum = base64.b64encode(bytes.fromhex(part["sha256"])).decode("ascii")
            params.update(ChecksumSHA256=checksum, IfNoneMatch="*")
            headers = {"x-amz-checksum-sha256": checksum, "If-None-Match": "*"}
        url = client.generate_presigned_url("put_object" if upload else "get_object", Params=params, ExpiresIn=900)
        result.append({**part, "url": url, "headers": headers})
    return result


async def prepare_upload(db, manifest: dict, *, user_id: str, experiment_id: int,
                         purpose: str, job_id=None, attempt=None, measurement_id=None, calculation_id=None, request_id=None):
    manifest = validate_manifest(manifest)
    identity = json.dumps([user_id, experiment_id, purpose, job_id, attempt, measurement_id, calculation_id, request_id, manifest], sort_keys=True)
    object_id = str(uuid5(UUID("718806cb-8701-47dc-9b2e-0f2eea279936"), identity))
    await db.execute(insert(StorageObject).values(id=object_id, user_id=user_id, experiment_id=experiment_id,
        purpose=purpose, job_id=job_id, attempt=attempt, measurement_id=measurement_id,
        calculation_id=calculation_id, manifest=manifest, ready=False, bound=False, deleting=False,
        updated_at=utcnow()).on_conflict_do_nothing(index_elements=[StorageObject.id]))
    row = await db.scalar(select(StorageObject).where(StorageObject.id == object_id).with_for_update())
    if row.deleting:
        raise HTTPException(409, "Object cleanup is in progress. Retry submission with a new scope.")
    row.updated_at = utcnow()
    await db.flush()
    return {"reference": reference(row), "ready": row.ready,
            "parts": [] if row.ready else await asyncio.to_thread(signed_parts, row, upload=True)}


async def owned_object(db, object_id: str, user_id: str):
    try:
        object_id = str(UUID(object_id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, "Invalid object identity.") from None
    row = await db.scalar(select(StorageObject).where(StorageObject.id == object_id).with_for_update())
    if row is None or row.user_id != user_id or row.deleting:
        raise HTTPException(404, "Object not found.")
    return row


async def finish_upload(db, row):
    if not row.ready:
        def verify():
            client = bucket_client()
            for index, part in enumerate(row.manifest["chunks"]):
                head = client.head_object(Bucket=settings.s3_bucket, Key=part_key(row, index), ChecksumMode="ENABLED")
                checksum = base64.b64encode(bytes.fromhex(part["sha256"])).decode("ascii")
                if head["ContentLength"] != part["byteLength"] or head.get("ChecksumSHA256") != checksum:
                    raise ValueError("Object checksum or size differs from its manifest.")
        try:
            await asyncio.to_thread(verify)
        except Exception:
            raise HTTPException(409, "Object upload is incomplete or its checksum does not match.") from None
        row.ready = True
    row.updated_at = utcnow()
    return {"reference": reference(row), "ready": True}


async def bind_objects(db, value, *, user_id, experiment_id, job_id=None, attempt=None,
                       measurement_id=None, calculation_id=None, calculation_data_id=None, bind=True, purpose=None):
    for ref in object_refs(value):
        from pydantic import ValidationError
        from storage.contracts import ObjectReference
        try:
            ObjectReference.model_validate(ref)
        except ValidationError:
            raise HTTPException(422, "Invalid object reference.") from None
        row = await owned_object(db, ref.get("id", ""), user_id)
        if not row.ready or reference(row) != ref or row.experiment_id != experiment_id:
            raise HTTPException(422, "Object reference is not a completed upload in this Experiment.")
        if purpose == "layout":
            if row.purpose != "layout" or (row.bound and row.calculation_id != calculation_id):
                raise HTTPException(409, "Object belongs to another Calculation layout.")
            row.calculation_id = calculation_id
            row.bound = True
            row.updated_at = utcnow()
            continue
        if job_id is not None and row.bound and measurement_id is not None and row.measurement_id == measurement_id and row.purpose == "measurement":
            continue  # Prepared inputs reuse the saved Measurement's immutable values.
        if job_id is not None and (row.job_id != job_id or row.attempt != attempt):
            raise HTTPException(409, "Object belongs to another job or attempt.")
        if calculation_id is not None and (row.calculation_id != calculation_id or row.measurement_id != measurement_id):
            raise HTTPException(409, "Object belongs to another Calculation or Measurement.")
        if job_id is None and calculation_id is None and row.purpose != "measurement":
            raise HTTPException(422, "Unexpected object upload purpose.")
        if row.purpose == "measurement" and row.bound and row.measurement_id != measurement_id:
            raise HTTPException(409, "Object is already attached to another Measurement.")
        row.bound = row.bound or bind
        if measurement_id is not None:
            row.measurement_id = measurement_id
        if calculation_data_id is not None:
            row.calculation_data_id = calculation_data_id
        row.updated_at = utcnow()


async def download_parts(db, ref: dict):
    row = await db.get(StorageObject, ref.get("id", ""))
    if row is None or row.deleting or not row.ready or reference(row) != ref:
        raise HTTPException(404, "Stored object is unavailable.")
    return {"reference": reference(row), "parts": await asyncio.to_thread(signed_parts, row, upload=False)}


async def cleanup_objects(db):
    cutoff = utcnow() - timedelta(hours=24)
    rows = (await db.scalars(select(StorageObject).where(StorageObject.updated_at < cutoff)
                            .order_by(StorageObject.updated_at).limit(100).with_for_update(skip_locked=True))).all()
    doomed = []
    for row in rows:
        alive = row.bound and row.user_id is not None and row.experiment_id is not None
        if row.purpose in {"measurement", "record", "calculation"}:
            alive = alive and row.measurement_id is not None
        if row.purpose == "calculation":
            alive = alive and row.calculation_id is not None and row.calculation_data_id is not None
        if row.purpose == "layout":
            calculation = await db.get(Calculation, row.calculation_id) if row.calculation_id else None
            alive = alive and calculation is not None and any(ref.get("id") == row.id for ref in object_refs(calculation.output_layout))
        if row.purpose == "record" and not row.bound and row.job_id:
            job = await db.get(Job, row.job_id)
            alive = (row.user_id is not None and row.experiment_id is not None and job is not None
                     and job.attempt_count == row.attempt and job.state in {"assigned", "running", "finalizing"})
        if row.purpose == "input":
            job = await db.get(Job, row.job_id) if row.job_id else None
            measurement = await db.scalar(select(Measurement.id).where(Measurement.job_id == row.job_id)) if job else None
            alive = alive and job is not None and (measurement is not None or job.state in {"staged", "queued", "assigned", "running", "finalizing"})
            alive = alive and any(ref.get("id") == row.id for ref in object_refs(job.input if job else None))
        if alive and not row.deleting:
            row.updated_at = utcnow()
            continue
        if row.bound and not row.deleting:
            # Foreign-key SET NULL does not timestamp the parent's deletion.
            # Start the grace period when a formerly bound orphan is observed.
            row.deleting = True
            row.updated_at = utcnow()
            continue
        row.deleting = True
        doomed.append(row)
    await db.commit()
    for row in doomed:
        def remove():
            client = bucket_client()
            for index in range(len(row.manifest["chunks"])):
                client.delete_object(Bucket=settings.s3_bucket, Key=part_key(row, index))
        try:
            await asyncio.to_thread(remove)
        except Exception:
            continue  # Durable tombstone: retry on the next sweep, never rebind it.
        await db.delete(row)
        await db.commit()
