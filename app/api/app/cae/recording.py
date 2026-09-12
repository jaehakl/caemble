"""Convert worker records to the existing persisted DataTensor contract."""

import base64
import json
import math
import struct

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from cae.db import CaeBatch
from db import ExperimentRecord, Measurement, MeasurementVisualization, RecordedData
from gpstation.db import Job, JobRecord, JobVisualization
from gpstation.service.state import utcnow
from service.box_grid import validate_box_grid_tensor, validate_result_provenance

INLINE_BYTES = 64 * 1024
NUMERIC_FORMATS = {
    "complex64": "ff",
    "float16": "e",
    "float32": "f",
    "float64": "d",
    "int8": "b",
    "uint8": "B",
    "int16": "h",
    "uint16": "H",
    "int32": "i",
    "uint32": "I",
    "int64": "q",
    "uint64": "Q",
    "bool": "B",
}


def persist_record(schema: dict, value: dict, attachments: dict[str, bytes]) -> dict:
    if "dtype" not in schema:
        return {
            name: persist_record(member, value[name], attachments)
            for name, member in schema.items()
        }
    tensor = {"shape": value["shape"], **{key: value[key] for key in ("axes", "boxGrid", "provenance") if key in value}}
    storage = value["storage"]
    if storage["kind"] == "base64":
        from storage.contracts import ObjectReference
        data = storage["data"]
        if isinstance(data, dict):
            ref = ObjectReference.model_validate(data)
            if ref.encoding != "base64" or ref.byteLength != storage["byteLength"]:
                raise ValueError("Recorded binary reference has the wrong encoding or size.")
            size = ref.byteLength
        else:
            size = len(base64.b64decode(data, validate=True))
            if size != storage["byteLength"]:
                raise ValueError("Recorded binary size mismatch.")
        if schema["dtype"] != "string" and size != math.prod(value["shape"]) * struct.calcsize("<" + NUMERIC_FORMATS[schema["dtype"]]):
            raise ValueError("Recorded binary shape mismatch.")
        tensor["storage"] = storage
        return tensor
    if storage["kind"] == "inline":
        tensor["storage"] = storage
        return tensor
    raw = b"".join(attachments[item] for item in storage["ids"])
    if len(raw) != storage["byteLength"]:
        raise ValueError("Tensor attachment byte length does not match.")
    dtype = schema["dtype"]
    shape = tensor["shape"]
    if dtype != "string" and len(raw) != math.prod(shape) * struct.calcsize(
        "<" + NUMERIC_FORMATS[dtype]
    ):
        raise ValueError("Tensor shape does not match its attachment.")
    if len(raw) > INLINE_BYTES and tensor["shape"]:
        tensor["storage"] = {
            "kind": "base64",
            "data": base64.b64encode(raw).decode("ascii"),
            "byteLength": len(raw),
        }
    else:
        if dtype == "string":
            inline = json.loads(raw.decode("utf-8"))
        else:
            values = [{"re": item[0], "im": item[1]} if dtype == "complex64" else item[0] for item in struct.iter_unpack("<" + NUMERIC_FORMATS[dtype], raw)]
            if dtype == "bool":
                values = [bool(item) for item in values]
            inline = values[0] if not shape else values
            for axis in reversed(range(1, len(shape))):
                width = shape[axis]
                inline = [
                    inline[index * width : (index + 1) * width]
                    for index in range(math.prod(shape[:axis]))
                ]
        tensor["storage"] = {"kind": "inline", "value": inline}
    return tensor


async def stage_record(db: AsyncSession, job: Job, payload: dict, attachments: list) -> None:
    if job.input.get("storage_version") == 1:
        from storage.service import bind_objects
        measurement = await db.scalar(select(Measurement).where(Measurement.job_id == job.id))
        if measurement is None and not job.input.get("preflight"):
            raise ValueError("Assigned Measurement is missing.")
        await bind_objects(db, payload, user_id=job.user_id, experiment_id=measurement.experiment_id if measurement else None,
                           job_id=job.id, attempt=job.attempt_count, measurement_id=measurement.id if measurement else None, bind=False)
    sequence, name = payload["sequence"], payload["name"]
    schemas = job.input["measurement"]["experiment"]["simulationProgram"]["recordedData"]
    if (
        name not in schemas
        or not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or sequence <= 0
    ):
        raise ValueError("Invalid record identity.")
    validate_box_grid_tensor(schemas[name], payload["value"])
    contract = job.input["measurement"]["experiment"]["simulationProgram"]["resultContracts"][name]
    if any(payload["value"]["provenance"][key] != contract[key] for key in ("task", "solver", "catalogRevision")):
        raise ValueError("Recorded provenance differs from its frozen output contract.")
    data = persist_record(
        schemas[name], payload["value"], {item.id: item.data for item in attachments}
    )
    previous = await db.get(JobRecord, (job.id, job.attempt_count, sequence))
    if previous:
        if previous.name != name or previous.payload != data:
            raise ValueError("A repeated record has different contents.")
        return
    rows = (
        await db.scalars(
            select(JobRecord)
            .where(JobRecord.job_id == job.id, JobRecord.attempt_count == job.attempt_count)
            .order_by(JobRecord.sequence)
        )
    ).all()
    visual_sequences = (await db.scalars(select(JobVisualization.sequence).where(
        JobVisualization.job_id == job.id, JobVisualization.attempt_count == job.attempt_count,
    ))).all()
    if sequence != len(rows) + len(visual_sequences) + 1 or any(row.name == name for row in rows):
        raise ValueError("Record sequence is out of order or the name was already recorded.")
    db.add(
        JobRecord(
            job_id=job.id,
            attempt_count=job.attempt_count,
            sequence=sequence,
            name=name,
            payload=data,
        )
    )


async def stage_visualization(db: AsyncSession, job: Job, payload: dict, attachments: list) -> None:
    sequence, task, entries = payload.get("sequence"), payload.get("task"), payload.get("visualizations")
    program = job.input["measurement"]["experiment"]["simulationProgram"]
    tasks = program["tasks"]
    if type(sequence) is not int or sequence < 1 or not isinstance(task, str) or task not in tasks or not isinstance(entries, dict):
        raise ValueError("Invalid visualization identity.")
    persisted = {}
    frozen = program["visualizationContracts"].get(task, {})
    if not set(entries).issubset(frozen):
        raise ValueError("Visualization entries differ from the frozen Task contracts.")
    batch = await db.get(CaeBatch, job.batch_id)
    catalog_revision = batch.spec.get("catalog_revision") if batch is not None else None
    if not isinstance(catalog_revision, str) or not catalog_revision.strip():
        raise ValueError("Visualization requires its frozen Batch Catalog revision.")
    for key, item in entries.items():
        if not isinstance(key, str) or not key or not isinstance(item, dict) or set(item) != {"contract", "schema", "data", "provenance"}:
            raise ValueError("Invalid visualization entry.")
        contract, provenance = item["contract"], item["provenance"]
        validate_result_provenance(provenance)
        if provenance["catalogRevision"] != catalog_revision:
            raise ValueError("Visualization provenance differs from its frozen Catalog revision.")
        if not isinstance(contract, dict) or contract != {name: value for name, value in frozen[key].items() if name != "schema"} or item["schema"] != frozen[key]["schema"]:
            raise ValueError("Visualization requires its frozen contract and tensor schema.")
        if not isinstance(provenance, dict) or provenance.get("task") != task or provenance.get("solver") != tasks[task]["kernel"] or type(provenance.get("invocation")) is not int or provenance["invocation"] < 1:
            raise ValueError("Visualization provenance differs from its Task.")
        persisted[key] = {**item, "data": persist_record(item["schema"], item["data"], {part.id: part.data for part in attachments})}
    if job.input.get("storage_version") == 1:
        from storage.service import bind_objects
        measurement = await db.scalar(select(Measurement).where(Measurement.job_id == job.id))
        if measurement is None and not job.input.get("preflight"):
            raise ValueError("Assigned Measurement is missing.")
        await bind_objects(db, persisted, user_id=job.user_id, experiment_id=measurement.experiment_id if measurement else None,
                           job_id=job.id, attempt=job.attempt_count, measurement_id=measurement.id if measurement else None, bind=False)
    previous = await db.get(JobVisualization, (job.id, job.attempt_count, sequence))
    if previous is not None:
        if previous.task != task or previous.payload != persisted:
            raise ValueError("A repeated visualization has different contents.")
        return
    rows = (await db.scalars(select(JobVisualization).where(
        JobVisualization.job_id == job.id, JobVisualization.attempt_count == job.attempt_count,
    ))).all()
    records = (await db.scalars(select(JobRecord.sequence).where(
        JobRecord.job_id == job.id, JobRecord.attempt_count == job.attempt_count,
    ))).all()
    if sequence != len(rows) + len(records) + 1 or any(row.task == task for row in rows):
        raise ValueError("Visualization sequence is out of order or the Task was already finalized.")
    db.add(JobVisualization(job_id=job.id, attempt_count=job.attempt_count, sequence=sequence, task=task, payload=persisted))


async def complete_job(db: AsyncSession, job: Job, packet: dict) -> dict:
    visual_rows = (await db.scalars(select(JobVisualization).where(
        JobVisualization.job_id == job.id, JobVisualization.attempt_count == job.attempt_count,
    ).order_by(JobVisualization.sequence))).all()
    if [row.sequence for row in visual_rows] != packet["visualizationSequences"]:
        raise ValueError("Terminal visualizations differ from the staged payloads.")
    all_sequences = sorted([*packet["recordSequences"], *packet["visualizationSequences"]])
    if all_sequences != list(range(1, len(all_sequences) + 1)):
        raise ValueError("Terminal payload sequences must be complete and unique.")
    if job.input.get("preflight"):
        from storage.service import bind_objects
        if job.input.get("execution_mode") == "brief":
            raise ValueError("Brief execution is no longer supported. Start a new Preflight.")
        staged = (await db.scalars(select(JobRecord).where(
            JobRecord.job_id == job.id, JobRecord.attempt_count == job.attempt_count
        ).order_by(JobRecord.sequence))).all()
        schemas = job.input["measurement"]["experiment"]["simulationProgram"]["recordedData"]
        if [row.sequence for row in staged] != packet["recordSequences"] or {row.name for row in staged} != set(schemas):
            raise ValueError("Preflight terminal records differ from the declared outputs.")
        for row in staged:
            await bind_objects(db, row.payload, user_id=job.user_id, experiment_id=None,
                               job_id=job.id, attempt=job.attempt_count)
        for row in visual_rows:
            await bind_objects(db, row.payload, user_id=job.user_id, experiment_id=None,
                               job_id=job.id, attempt=job.attempt_count)
        # finish_job deletes staging records in this same transaction. Keep the
        # completed tensors (including object references) on their owning job.
        job.artifact_metadata = {
            **(job.artifact_metadata or {}),
            "recorded_data": {row.name: row.payload for row in staged},
            "visualizations": {row.task: row.payload for row in visual_rows},
            "execution_trace": packet.get("executionTrace", []),
        }
        await db.flush()
        return {"preflight_id": job.batch_id}
    sequences = packet["recordSequences"]
    measurement = await db.scalar(
        select(Measurement).where(Measurement.job_id == job.id).with_for_update()
    )
    if measurement is None or measurement.recorded_at is not None:
        raise ValueError("The assigned Measurement is unavailable or already recorded.")
    staged = (
        await db.scalars(
            select(JobRecord)
            .where(JobRecord.job_id == job.id, JobRecord.attempt_count == job.attempt_count)
            .order_by(JobRecord.sequence)
        )
    ).all()
    if [record.sequence for record in staged] != sequences:
        raise ValueError("The terminal record sequence does not match stored records.")
    contracts = {
        record.name: record
        for record in (
            await db.scalars(
                select(ExperimentRecord).where(
                    ExperimentRecord.experiment_id == measurement.experiment_id
                )
            )
        ).all()
    }
    schemas = job.input["measurement"]["experiment"]["simulationProgram"]["recordedData"]
    if {record.name for record in staged} != set(schemas):
        raise ValueError("Terminal records differ from the declared Outputs.")

    def add_leaves(name: str, schema: dict, value: dict) -> None:
        if "dtype" in schema:
            record = contracts.get(name)
            if record is None:
                raise ValueError(f"ExperimentRecord {name!r} is unavailable.")
            db.add(
                RecordedData(
                    user_id=measurement.user_id,
                    measurement_id=measurement.id,
                    experiment_record_id=record.id,
                    data=value,
                    data_url=None,
                    file_size=None,
                )
            )
        else:
            for member_name, member_schema in schema.items():
                add_leaves(f"{name}.{member_name}", member_schema, value[member_name])

    for record in staged:
        validate_box_grid_tensor(schemas[record.name], record.payload)
        if job.input.get("storage_version") == 1:
            from storage.service import bind_objects
            await bind_objects(db, record.payload, user_id=job.user_id, experiment_id=measurement.experiment_id,
                               job_id=job.id, attempt=job.attempt_count, measurement_id=measurement.id)
        add_leaves(record.name, schemas[record.name], record.payload)
    for row in visual_rows:
        if job.input.get("storage_version") == 1:
            from storage.service import bind_objects
            await bind_objects(db, row.payload, user_id=job.user_id, experiment_id=measurement.experiment_id,
                               job_id=job.id, attempt=job.attempt_count, measurement_id=measurement.id)
        db.add(MeasurementVisualization(measurement_id=measurement.id, task=row.task, data=row.payload))
    measurement.recorded_at = utcnow()
    await db.flush()
    return {"measurement_id": measurement.id}


async def storage_packet(db, job, packet):
    from fastapi import HTTPException
    from storage.service import prepare_upload, finish_upload, owned_object, object_refs, download_parts
    operation = packet["type"].removeprefix("job.storage.")
    measurement = await db.scalar(select(Measurement).where(Measurement.job_id == job.id))
    if (measurement is None and not job.input.get("preflight")) or job.input.get("storage_version") != 1:
        raise ValueError("Job does not support object storage.")
    if operation == "prepare":
        result = await prepare_upload(db, packet["manifest"], user_id=job.user_id,
            experiment_id=measurement.experiment_id if measurement else None, purpose="record", job_id=job.id,
            attempt=job.attempt_count, measurement_id=measurement.id if measurement else None)
    elif operation == "complete":
        row = await owned_object(db, packet["object_id"], job.user_id)
        if row.job_id != job.id or row.attempt != job.attempt_count or row.purpose != "record":
            raise HTTPException(403, "Object belongs to another attempt.")
        result = await finish_upload(db, row)
    elif operation == "read":
        if packet["reference"] not in list(object_refs(job.input)):
            raise HTTPException(403, "Object is not an assigned input.")
        result = await download_parts(db, packet["reference"])
    else:
        raise ValueError("Unknown storage operation.")
    return {"type": f"job.storage.{operation}.ack", **result}
