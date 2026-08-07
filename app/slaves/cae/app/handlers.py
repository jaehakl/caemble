from __future__ import annotations

import json
from typing import Any

from sdk.protocol.messages import DataChannelAttachment, DataChannelMessage
from sdk.slave import SlaveApp, SlaveContext
from sdk.slave.runtime import emit

from app.errors import CaeError, ProtocolError
from app.runtime import CaeRun, create_run, started_payload
from app.solver_framework.registry import registry
from app.tensor import decode_attachment_tensors


def register_handlers(app: SlaveApp) -> None:
    app.handler("cae.solvers.manifests")(cae_solver_manifests)
    app.handler("cae.simulation.start")(cae_simulation_start)
    app.handler("cae.simulation.next")(cae_simulation_next)


async def cae_solver_manifests(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    del memory, context
    if message.attachments:
        raise ProtocolError("cae.solvers.manifests does not accept attachments")
    if message.payload != {}:
        raise ProtocolError("cae.solvers.manifests payload must be an empty object")
    manifests = registry.manifests()
    data = json.dumps(
        manifests,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    attachment_id = "solver-manifests"
    return DataChannelMessage(
        id=message.id,
        type="cae.solvers.manifests.result",
        payload={
            "formatVersion": 1,
            "count": len(manifests),
            "attachmentId": attachment_id,
        },
        attachments=[
            DataChannelAttachment(
                id=attachment_id,
                name="solver-manifests.json",
                mimeType="application/json; charset=utf-8",
                data=data,
            )
        ],
    )


async def cae_simulation_start(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    if memory is None:
        raise RuntimeError("CAE slave memory is unavailable")
    try:
        payload = decode_attachment_tensors(message.payload, message.attachments)
    except CaeError as exc:
        if exc.code != "resource_limit":
            raise
        emit({"type": "cae.run.cleaned", "job_id": context.session_id, "run_id": None})
        return DataChannelMessage(
            id=message.id,
            type="cae.simulation.start.result",
            payload={
                "kind": "failed",
                "sequence": 0,
                "error": {"code": exc.code, "message": str(exc)},
            },
        )
    if not isinstance(payload, dict):
        raise ProtocolError("cae.simulation.start payload must be an object")
    runs = memory.setdefault("runs", {})
    if not isinstance(runs, dict):
        raise RuntimeError("CAE slave run memory is invalid")
    if any(isinstance(candidate, CaeRun) and candidate.job_id == context.session_id for candidate in runs.values()):
        raise ProtocolError("a CAE run has already been started for this job")

    def cleanup(run_id: str) -> None:
        runs.pop(run_id, None)

    try:
        run = create_run(payload, job_id=context.session_id, on_cleanup=cleanup)
    except CaeError as exc:
        emit({"type": "cae.run.cleaned", "job_id": context.session_id, "run_id": None})
        return DataChannelMessage(
            id=message.id,
            type="cae.simulation.start.result",
            payload={
                "kind": "failed",
                "sequence": 0,
                "error": {"code": exc.code, "message": str(exc)},
            },
        )
    for previous in list(runs.values()):
        if isinstance(previous, CaeRun):
            previous.abort()
    runs[run.run_id] = run
    return DataChannelMessage(
        id=message.id,
        type="cae.simulation.start.result",
        payload=started_payload(run),
    )


async def cae_simulation_next(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    if message.attachments:
        raise ProtocolError("cae.simulation.next does not accept attachments")
    if memory is None or not isinstance(memory.get("runs"), dict):
        raise ProtocolError("CAE run memory is unavailable")
    payload = message.payload
    if not isinstance(payload, dict) or set(payload) != {"runId", "ackSequence"}:
        raise ProtocolError("next payload must contain exactly runId and ackSequence")
    run_id = payload.get("runId")
    ack_sequence = payload.get("ackSequence")
    if not isinstance(run_id, str):
        raise ProtocolError("runId must be a string")
    if ack_sequence is not None and (
        not isinstance(ack_sequence, int) or isinstance(ack_sequence, bool) or ack_sequence < 1
    ):
        raise ProtocolError("ackSequence must be null or a positive integer")
    run = memory["runs"].get(run_id)
    if not isinstance(run, CaeRun):
        raise ProtocolError(f"unknown CAE run: {run_id}")
    if run.job_id != context.session_id:
        raise ProtocolError("CAE run belongs to a different Caemble job")
    return await run.next(ack_sequence, context)
