"""Convert worker records to the existing persisted DataTensor contract."""

import base64
import json
import math
import struct

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import ExperimentRecord, Measurement, RecordedData
from gpstation.db import Job, JobRecord
from gpstation.service.state import utcnow

INLINE_BYTES = 64 * 1024
NUMERIC_FORMATS = {
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
    tensor = {"shape": value["shape"], **({"axes": value["axes"]} if "axes" in value else {})}
    storage = value["storage"]
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
            values = [item[0] for item in struct.iter_unpack("<" + NUMERIC_FORMATS[dtype], raw)]
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
    sequence, name = payload["sequence"], payload["name"]
    schemas = job.input["measurement"]["experiment"]["simulationProgram"]["recordedData"]
    if (
        name not in schemas
        or not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or sequence <= 0
    ):
        raise ValueError("Invalid record identity.")
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
    if sequence != len(rows) + 1 or any(row.name == name for row in rows):
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


async def complete_job(db: AsyncSession, job: Job, packet: dict) -> dict:
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
        add_leaves(record.name, schemas[record.name], record.payload)
    measurement.recorded_at = utcnow()
    await db.flush()
    return {"measurement_id": measurement.id}
