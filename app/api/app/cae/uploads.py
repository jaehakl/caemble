"""Client-built inputs: immutable chunk storage and atomic batch registration."""

from __future__ import annotations

import hashlib
import json
import math
from datetime import timedelta

from caemble_catalog import Catalog, CatalogNotFoundError
from fastapi import HTTPException
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from cae.batches import cancel_batch, require_batch
from cae.db import CaeBatch, CaeUploadChunk
from db import Experiment, Measurement
from gpstation.db import Job, JobBatch
from gpstation.service.batches import add_event, serialize_events
from gpstation.service.state import utcnow
from models import UserData
from service.material_snapshot import validate_material_snapshot
from utils.crud.common import is_admin_user

CHUNK_BYTES = 8 * 1024 * 1024


async def finalize_stored_item(db, batch_id, user_id, index, body):
    from storage.service import INLINE_BYTES, bind_objects
    await serialize_events(db)
    batch = await require_batch(db, batch_id, user_id, lock=True)
    cae = await db.get(CaeBatch, batch.id)
    if batch.state != "uploading" or cae.spec.get("storage_version") != 1:
        raise HTTPException(409, "Batch is not accepting object-backed inputs.")
    job = await db.scalar(select(Job).where(Job.batch_id == batch.id, Job.item_index == index).with_for_update())
    if job is None:
        raise HTTPException(404, "Input job not found.")
    stored = body["input"]
    external = isinstance(stored, dict) and stored.get("kind") == "caemble.object"
    item = validate_artifact_item(body.get("projection") if external else stored, cae.spec["source_hash"])
    if external:
        if stored.get("sha256") != job.artifact_metadata["input_hash"] or stored.get("byteLength") != job.artifact_metadata["byte_length"] or stored.get("encoding") != "json":
            raise HTTPException(422, "Input reference differs from the build manifest.")
    else:
        raw = json.dumps(stored, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        # Inline hashes are verified by the Client and Slave; JSON parsing may
        # change numeric spelling between JavaScript and Python.
        if len(raw) > INLINE_BYTES:
            raise HTTPException(413, "Large inputs must be uploaded directly to object storage.")
    await bind_objects(db, body, user_id=user_id, experiment_id=cae.experiment_id, job_id=job.id)
    payload = {"measurement": item["measurement"], "storage_version": 1,
               **({"artifact": stored} if external else {})}
    if job.input is not None:
        if job.input != payload:
            raise HTTPException(409, "Finalized input cannot change.")
    else:
        job.input = payload
        if not external and "presentation" in item:
            job.artifact_metadata = {**job.artifact_metadata, "presentation": item["presentation"]}
        batch.uploaded_count += 1
        await add_event(db, batch, "item.uploaded", job=job, payload={"uploaded_count": batch.uploaded_count})
    batch.updated_at = utcnow()
    await db.commit()
    return {"ok": True, "index": index, "input_hash": job.artifact_metadata["input_hash"]}


async def upload_chunk(
    db: AsyncSession, batch_id: str, user_id: str, index: int,
    chunk_index: int, sha256: str, data: bytes,
) -> dict:
    batch = await require_batch(db, batch_id, user_id, lock=True)
    if batch.state != "uploading":
        raise HTTPException(409, "Batch is no longer accepting uploads.")
    cae = await db.get(CaeBatch, batch.id)
    if cae.spec.get("storage_version") == 1:
        raise HTTPException(409, "Upload this batch's input directly to object storage.")
    job = await db.scalar(select(Job).where(Job.batch_id == batch.id, Job.item_index == index))
    if job is None:
        raise HTTPException(404, "Artifact item not found.")
    metadata = job.artifact_metadata
    chunks = math.ceil(metadata["byte_length"] / CHUNK_BYTES)
    expected = min(CHUNK_BYTES, metadata["byte_length"] - chunk_index * CHUNK_BYTES)
    if chunk_index < 0 or chunk_index >= chunks or len(data) != expected:
        raise HTTPException(422, "Chunk index or byte length does not match the manifest.")
    if hashlib.sha256(data).hexdigest() != sha256:
        raise HTTPException(422, "Chunk SHA256 does not match its bytes.")
    if job.input is not None:
        hashes = metadata.get("chunk_hashes", [])
        if chunk_index >= len(hashes) or hashes[chunk_index] != sha256:
            raise HTTPException(409, "Finalized artifact cannot be changed.")
    else:
        previous = await db.get(CaeUploadChunk, (job.id, chunk_index))
        if previous is not None and previous.sha256 != sha256:
            raise HTTPException(409, "Chunk was already uploaded with different bytes.")
        if previous is None:
            db.add(CaeUploadChunk(job_id=job.id, chunk_index=chunk_index, sha256=sha256, data=data))
    batch.updated_at = utcnow()
    await db.commit()
    return {"ok": True, "index": index, "chunk_index": chunk_index}


def validate_artifact_item(value: object, source_hash: str) -> dict:
    if not isinstance(value, dict) or set(value) - {"measurement", "presentation"}:
        raise HTTPException(422, "Artifact item must contain measurement and optional presentation.")
    measurement = value.get("measurement")
    if not isinstance(measurement, dict) or measurement.get("kind") != "measurement":
        raise HTTPException(422, "Expected a BuiltMeasurement artifact.")
    experiment = measurement.get("experiment")
    if not isinstance(experiment, dict) or experiment.get("sourceHash") != source_hash:
        raise HTTPException(409, "BuiltMeasurement source hash differs from the manifest.")
    for key in ("variables", "varsSchema", "scene", "taskScenes", "simulationProgram"):
        if not isinstance(experiment.get(key), dict):
            raise HTTPException(422, f"BuiltMeasurement experiment.{key} must be an object.")
    for key in ("materialSnapshot", "taskMaterialSnapshots", "materialSelections"):
        if not isinstance(measurement.get(key), dict):
            raise HTTPException(422, f"BuiltMeasurement {key} must be an object.")
    if any(key in measurement for key in ("materialParameters", "taskMaterialParameters", "materialWarnings", "taskMaterialWarnings")):
        raise HTTPException(422, "Legacy Material inputs are not supported. Rebuild with the current client.")
    program = experiment["simulationProgram"]
    if not isinstance(program.get("pythonSource"), str) or not program["pythonSource"].strip():
        raise HTTPException(422, "BuiltMeasurement must retain its Python program source.")
    if not isinstance(program.get("tasks"), dict) or not isinstance(program.get("recordedData"), dict):
        raise HTTPException(422, "BuiltMeasurement program tasks and recordedData must be objects.")
    tasks = set(program["tasks"])
    if tasks != set(experiment["taskScenes"]) or tasks != set(measurement["taskMaterialSnapshots"]) or tasks != set(measurement["materialSelections"]):
        raise HTTPException(422, "Frozen Task scenes and Material snapshots must match the program tasks.")
    try:
        validate_material_snapshot({
            "experiment": measurement["materialSnapshot"],
            "tasks": measurement["taskMaterialSnapshots"],
            "modelDefinitions": measurement.get("modelDefinitions"),
            "selections": measurement["materialSelections"],
            "sourceHash": experiment["sourceHash"],
            "varsHash": measurement.get("varsHash"),
        }, source_hash=source_hash, variables=experiment["variables"])
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    for name, task in program["tasks"].items():
        kernel = task.get("kernel") if isinstance(task, dict) else None
        if not isinstance(kernel, dict) or not all(isinstance(kernel.get(key), str) and kernel[key] for key in ("name", "version")):
            raise HTTPException(422, f"Task {name} must identify its Solver name and version.")
    if "presentation" in value and not isinstance(value["presentation"], dict):
        raise HTTPException(422, "Artifact presentation must be an object.")
    return value


async def finalize_item(db: AsyncSession, batch_id: str, user_id: str, index: int) -> dict:
    await serialize_events(db)
    batch = await require_batch(db, batch_id, user_id, lock=True)
    if batch.state != "uploading":
        raise HTTPException(409, "Batch is no longer accepting uploads.")
    job = await db.scalar(select(Job).where(Job.batch_id == batch.id, Job.item_index == index))
    if job is None:
        raise HTTPException(404, "Artifact item not found.")
    if job.input is None:
        metadata = dict(job.artifact_metadata)
        chunks = list((await db.scalars(select(CaeUploadChunk).where(
            CaeUploadChunk.job_id == job.id
        ).order_by(CaeUploadChunk.chunk_index))).all())
        count = math.ceil(metadata["byte_length"] / CHUNK_BYTES)
        if [chunk.chunk_index for chunk in chunks] != list(range(count)):
            raise HTTPException(409, "Artifact upload is incomplete.")
        data = b"".join(chunk.data for chunk in chunks)
        if len(data) != metadata["byte_length"] or hashlib.sha256(data).hexdigest() != metadata["input_hash"]:
            raise HTTPException(422, "Artifact SHA256 or byte length does not match its manifest.")
        try:
            value = json.loads(data.decode("utf-8"))
            # PostgreSQL JSONB and the browser JSON contract do not accept NaN/Infinity.
            json.dumps(value, allow_nan=False)
        except (UnicodeDecodeError, ValueError, RecursionError) as error:
            raise HTTPException(422, "Artifact must be finite UTF-8 JSON.") from error
        cae = await db.get(CaeBatch, batch.id)
        item = validate_artifact_item(value, cae.spec["source_hash"])
        job.input = {"measurement": item["measurement"]}
        metadata["chunk_hashes"] = [chunk.sha256 for chunk in chunks]
        if "presentation" in item:
            metadata["presentation"] = item["presentation"]
        job.artifact_metadata = metadata
        await db.execute(delete(CaeUploadChunk).where(CaeUploadChunk.job_id == job.id))
        batch.uploaded_count += 1
        await add_event(db, batch, "item.uploaded", job=job, payload={"uploaded_count": batch.uploaded_count})
    batch.updated_at = utcnow()
    await db.commit()
    return {"ok": True, "index": index, "input_hash": job.artifact_metadata["input_hash"]}


async def commit_batch(db: AsyncSession, batch_id: str, user: UserData, catalog: Catalog) -> JobBatch:
    await serialize_events(db)
    batch = await require_batch(db, batch_id, user.id, lock=True)
    cae = await db.get(CaeBatch, batch.id)
    if cae.spec.get("committed"):
        await db.commit()
        return batch
    if batch.state != "uploading":
        raise HTTPException(409, "Batch was cancelled or expired.")
    if batch.uploaded_count != batch.total:
        raise HTTPException(409, "Upload and finalize every artifact before committing.")
    if cae.spec["catalog_revision"] != catalog.meta()["catalogRevision"]:
        raise HTTPException(409, "Catalog changed. Rebuild before submitting.")
    experiment = await db.scalar(select(Experiment).where(
        Experiment.id == cae.experiment_id
    ).with_for_update())
    if experiment is None or (not is_admin_user(user) and experiment.user_id not in {None, user.id}):
        raise HTTPException(404, "Experiment not found.")
    if experiment.source_hash != cae.spec["source_hash"]:
        raise HTTPException(409, "Experiment source changed before commit.")
    total, incomplete = (await db.execute(select(
        func.count(Job.id), func.count(Job.id).filter(or_(
            Job.input.is_(None), func.jsonb_typeof(Job.input) != "object", Job.state != "staged",
        )),
    ).where(Job.batch_id == batch.id))).one()
    if total != batch.total or incomplete:
        raise HTTPException(409, "Artifact upload is incomplete.")
    jobs = await db.stream_scalars(select(Job).where(Job.batch_id == batch.id)
        .order_by(Job.item_index).with_for_update().execution_options(yield_per=1))
    try:
        async for job in jobs:
            measurement_input = job.input["measurement"]
            program = measurement_input["experiment"]["simulationProgram"]
            if program["pythonSource"] != experiment.source_bundle.get("files", {}).get("simulate.py"):
                raise HTTPException(409, "Artifact Python program differs from the saved Experiment source.")
            for name, task in program["tasks"].items():
                try:
                    catalog.get_solver_manifest(task["kernel"]["name"], task["kernel"]["version"])
                except CatalogNotFoundError as error:
                    raise HTTPException(409, f"Task {name} references a Solver unavailable in the current Catalog.") from error
            variables = measurement_input["experiment"]["variables"]
            try:
                materials = validate_material_snapshot({
                    "experiment": measurement_input["materialSnapshot"],
                    "tasks": measurement_input["taskMaterialSnapshots"],
                    "modelDefinitions": measurement_input["modelDefinitions"],
                    "selections": measurement_input["materialSelections"],
                    "sourceHash": measurement_input["experiment"]["sourceHash"],
                    "varsHash": measurement_input["varsHash"],
                }, source_hash=experiment.source_hash, variables=variables, catalog=catalog)
            except ValueError as error:
                raise HTTPException(422, str(error)) from error
            measurement_id = job.artifact_metadata.get("measurement_id")
            if measurement_id is not None:
                measurement = await db.scalar(select(Measurement).where(
                    Measurement.id == measurement_id, Measurement.user_id == user.id,
                    Measurement.experiment_id == experiment.id,
                ).with_for_update())
                if measurement is None:
                    raise HTTPException(404, "Measurement not found.")
                if measurement.job_id is not None or measurement.recorded_at is not None:
                    raise HTTPException(409, "Measurement already has an execution. Open its batch to retry.")
                from storage.service import object_refs
                has_objects = bool(list(object_refs([measurement.vars, measurement.material_snapshot, variables, materials])))
                if not has_objects and (measurement.vars != variables or measurement.material_snapshot != materials):
                    raise HTTPException(409, "Artifact differs from the saved Measurement inputs.")
                if has_objects:
                    if measurement.material_snapshot["varsHash"] != materials["varsHash"]:
                        raise HTTPException(409, "Artifact differs from the saved Measurement Vars.")
                    # The Slave compares the full downloaded artifact against this
                    # saved projection before executing; references may have different IDs.
                    frozen = measurement.material_snapshot
                    measurement_input = {**measurement_input,
                        "experiment": {**measurement_input["experiment"], "variables": measurement.vars},
                        "materialSnapshot": frozen["experiment"], "taskMaterialSnapshots": frozen["tasks"],
                        "modelDefinitions": frozen["modelDefinitions"], "materialSelections": frozen["selections"]}
                    job.input = {**job.input, "measurement": measurement_input}
                measurement.job_id = job.id
            else:
                measurement = Measurement(user_id=user.id, experiment_id=experiment.id,
                    vars=variables, material_snapshot=materials, job_id=job.id)
                db.add(measurement)
            await db.flush()
            if job.input.get("storage_version") == 1:
                from storage.service import bind_objects
                await bind_objects(db, job.input, user_id=user.id, experiment_id=experiment.id,
                                   job_id=job.id, measurement_id=measurement.id)
            job.state = "queued"
            job.updated_at = utcnow()
            await add_event(db, batch, "job.queued", job=job, payload={"measurement_id": measurement.id})
    finally:
        await jobs.close()
    cae.spec = {**cae.spec, "committed": True}
    batch.state = "queued"
    await add_event(db, batch, "batch.committed")
    await db.commit()
    return batch


async def expire_uploads(db: AsyncSession) -> int:
    # cancel_batch reacquires the same event and batch locks, preventing commit races.
    stale = list((await db.execute(select(JobBatch.id, JobBatch.user_id).where(
        JobBatch.state == "uploading", JobBatch.updated_at < utcnow() - timedelta(hours=24)
    ))).all())
    await db.rollback()
    expired = 0
    for batch_id, user_id in stale:
        await serialize_events(db)
        batch = await require_batch(db, batch_id, user_id, lock=True)
        if batch.state == "uploading" and batch.updated_at < utcnow() - timedelta(hours=24):
            await cancel_batch(db, batch_id, user_id)
            expired += 1
        else:
            await db.rollback()
    return expired


async def measurement_artifact(db: AsyncSession, measurement_id: int, user_id: str) -> dict:
    row = (await db.execute(select(Job, CaeBatch).join(
        Measurement, Measurement.job_id == Job.id
    ).join(CaeBatch, CaeBatch.batch_id == Job.batch_id).where(
        Measurement.id == measurement_id, Measurement.user_id == user_id
    ))).first()
    if row is None or row[0].input is None:
        raise HTTPException(404, "This Measurement has no saved build artifact. Rebuild with the current client.")
    job, cae = row
    metadata = job.artifact_metadata or {}
    if "artifact" in job.input:
        return job.input["artifact"]
    return {"measurement": job.input["measurement"], **({"presentation": metadata["presentation"]} if "presentation" in metadata else {})}


async def measurement_artifact_info(db: AsyncSession, measurement_id: int, user_id: str) -> dict:
    row = (await db.execute(select(Job, CaeBatch).join(
        Measurement, Measurement.job_id == Job.id
    ).join(CaeBatch, CaeBatch.batch_id == Job.batch_id).where(
        Measurement.id == measurement_id, Measurement.user_id == user_id
    ))).first()
    if row is None or row[0].input is None:
        raise HTTPException(404, "This Measurement has no saved build artifact.")
    job, cae = row
    metadata = job.artifact_metadata or {}
    return {
        "measurement_id": measurement_id,
        "input_hash": metadata.get("input_hash"),
        "byte_length": metadata.get("byte_length"),
        "source_hash": cae.spec.get("source_hash"),
        "catalog_revision": cae.spec.get("catalog_revision"),
        "builder_version": cae.spec.get("builder_version"),
    }
