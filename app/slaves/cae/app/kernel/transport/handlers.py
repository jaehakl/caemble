from __future__ import annotations

import asyncio
from typing import Any

from sdk.protocol.packets import Attachment
from sdk.slave.server import ServerJobContext

from app.kernel.api.errors import CaeError, ProtocolError
from app.kernel.coordinator.run import CaeRun, DEFAULT_MAX_RUN_SECONDS
from app.kernel.transport.records import RecordPacket
from app.kernel.transport.tensor import decode_attachment_tensors

RECORD_ACK_TIMEOUT_SECONDS = 120


async def run_measurement(
    message: dict[str, Any],
    attachments: list[Attachment],
    context: ServerJobContext,
) -> dict[str, Any]:
    if message.get("execution_mode") == "brief":
        raise ProtocolError("Brief execution is no longer supported. Start a new Preflight with the current settings.")
    from app.kernel.transport.object_storage import externalize_record, read_object, resolve_input
    if "artifact" in message:
        artifact = await read_object(context, message["artifact"])
        built = artifact["measurement"]
        projection = {**built, "experiment": {**built["experiment"], "scene": {},
                      "taskScenes": {name: {} for name in built["experiment"]["taskScenes"]}}}
        if projection != await resolve_input(context, message["measurement"]):
            raise ProtocolError("Stored input differs from its registered Measurement metadata.")
        message = {**message, "measurement": built}
    async def progress(value: Any) -> None:
        await context.send({"type": "job.progress", "progress": value})

    run = CaeRun(
        measurement=decode_attachment_tensors(message["measurement"], attachments),
        max_run_seconds=DEFAULT_MAX_RUN_SECONDS,
        job_id=context.job_id,
        on_progress=progress,
    )
    try:
        run.start()
        while True:
            item = await run.queue.get()
            if isinstance(item, RecordPacket):
                run.pending = item
                stored = message.get("storage_version") == 1
                value = await externalize_record(context, item.value, {part.id: part.data for part in item.attachments}) if stored else item.value
                await context.send(
                    {"type": "job.record", "sequence": item.sequence, "name": item.name, "value": value},
                    () if stored else item.attachments,
                )
                acknowledgement, _ = await asyncio.wait_for(
                    context.receive(), timeout=RECORD_ACK_TIMEOUT_SECONDS,
                )
                if acknowledgement.get("type") != "job.record.ack":
                    raise ProtocolError("Expected job.record.ack")
                run.acknowledge(acknowledgement.get("sequence"))
                continue
            if item["kind"] == "failed":
                raise CaeError(item["error"]["code"], item["error"]["message"])
            if item["kind"] == "complete":
                return {"recordSequences": item["recordSequences"],
                        **({"executionTrace": run.trace} if message.get("preflight") else {})}
    finally:
        await run.close()
