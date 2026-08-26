from __future__ import annotations

import json
from typing import Any

from sdk.protocol.messages import DataChannelAttachment, DataChannelMessage
from sdk.slave import SlaveApp, SlaveContext
from sdk.slave.runtime import emit

from app.errors import CaeError, ProtocolError
from app.runtime_kernel.coordinator.run import create_run, started_payload
from app.runtime_kernel.catalog import solver_catalog
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
    manifests = solver_catalog.manifests()
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
    payload = decode_attachment_tensors(message.payload, message.attachments)
    runs = memory.setdefault("runs", {})
    if any(candidate.job_id == context.session_id for candidate in runs.values()):
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
    payload = message.payload
    run_id = payload["runId"]
    ack_sequence = payload.get("ackSequence")
    run = memory["runs"].get(run_id)
    if run is None:
        raise ProtocolError(f"unknown CAE run: {run_id}")
    if run.job_id != context.session_id:
        raise ProtocolError("CAE run belongs to a different Caemble job")
    return await run.next(ack_sequence, context)
