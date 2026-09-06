from __future__ import annotations

import asyncio
import copy
import contextlib
import logging
import time
import uuid
from collections.abc import Mapping
from typing import Any, Callable

from sdk.protocol.messages import DataChannelMessage
from sdk.slave import SlaveContext
from sdk.slave.runtime import emit

from app.errors import CaeError, ProtocolError
from app.runtime_kernel.coordinator.plan import RunPlan, read_only
from app.runtime_kernel.coordinator.simulation import SimulationApi as RuntimeSimulationApi
from app.runtime_kernel.coordinator.program import validate_and_load_simulate
from app.runtime_kernel.transport import RecordPacket, RecordResourceHold
from app.tensor import encode_recorded_data

FIRST_NEXT_TIMEOUT_SECONDS = 30
RECORD_ACK_TIMEOUT_SECONDS = 120
DEFAULT_MAX_RUN_SECONDS = 2 * 60 * 60
HEARTBEAT_SECONDS = 5
LIVENESS_SECONDS = 5 * 60
logger = logging.getLogger(__name__)


class CaeRun:
    def __init__(
        self,
        *,
        measurement: dict[str, Any],
        max_run_seconds: int,
        job_id: str,
        on_cleanup: Callable[[str], None],
    ) -> None:
        self.measurement = copy.deepcopy(measurement)
        manifest = _manifest(self.measurement)
        source = _simulation_source(self.measurement, manifest)
        tasks = manifest["tasks"]
        self.schemas = manifest["recordedData"]
        self.simulate = validate_and_load_simulate(
            source,
            task_names=tasks,
            recorded_names=self.schemas,
        )
        self.plan = RunPlan.prepare(self.measurement, tasks, self.schemas)
        self.schemas = self.plan.schemas
        self.tasks = self.plan.tasks
        self.run_id = str(uuid.uuid4())
        self.max_run_seconds = max_run_seconds
        self.job_id = job_id
        self.queue: asyncio.Queue[RecordPacket | dict[str, Any]] = asyncio.Queue()
        self.pending: RecordPacket | None = None
        self._record_packets: dict[int, RecordPacket] = {}
        self.task: asyncio.Task[None] | None = None
        self.first_next = False
        self.sequence = 0
        self.completed_sequences: list[int] = []
        self.recorded_names: list[str] = []
        self._recorded_name_set: set[str] = set()
        self.recorded_bytes = 0
        self.active_context: SlaveContext | None = None
        self.heartbeat_task: asyncio.Task[None] | None = None
        self.last_progress_at = 0.0
        self.latest_progress: Any = None
        self.progress_task: asyncio.Task[None] | None = None
        self.trace: list[dict[str, Any]] = []
        self.closed = False
        self.on_cleanup = on_cleanup
        self.first_next_watchdog = asyncio.create_task(self._watch_first_next())
        self.liveness_task: asyncio.Task[None] | None = None
        self.simulation_api: RuntimeSimulationApi | None = None

    async def next(self, ack_sequence: int | None, context: SlaveContext) -> DataChannelMessage:
        if self.closed:
            raise ProtocolError("CAE run is closed")
        await self._stop_heartbeat()
        self.active_context = context
        try:
            self._acknowledge(ack_sequence)
        except Exception:
            self.active_context = None
            self.abort()
            raise
        if not self.first_next:
            self.first_next = True
            self.first_next_watchdog.cancel()
            self.task = asyncio.create_task(self._execute())
            self.liveness_task = asyncio.create_task(self._emit_liveness())
        self.heartbeat_task = asyncio.create_task(self._emit_heartbeats(context))
        try:
            item = await self.queue.get()
        except asyncio.CancelledError:
            if self.task is not None and not self.task.done():
                self.task.cancel()
            self._close()
            raise
        if isinstance(item, RecordPacket):
            if self.pending is not None:
                self._close()
                raise ProtocolError("more than one unacknowledged record was produced")
            self.pending = item
            return DataChannelMessage(
                id=context.call_id or self.run_id,
                type="cae.simulation.next.result",
                payload={
                    "kind": "record",
                    "sequence": item.sequence,
                    "name": item.name,
                    "value": item.value,
                },
                attachments=item.attachments,
            )
        kind = item.get("kind")
        if kind in {"complete", "failed"}:
            self._close()
        return DataChannelMessage(
            id=context.call_id or self.run_id,
            type="cae.simulation.next.result",
            payload=item,
        )

    async def record(
        self,
        name: str,
        value: Any,
        *,
        resource_hold: RecordResourceHold | None = None,
    ) -> None:
        try:
            if not isinstance(name, str) or name not in self.schemas:
                raise CaeError("invalid_record", f"RecordedData {name!r} is not declared")
            if name in self._recorded_name_set:
                raise CaeError("invalid_record", f"RecordedData {name!r} was already recorded")
            _validate_record_group_members(name, self.schemas[name], value)
            await self._flush_progress()
            next_sequence = self.sequence + 1
            encoded, attachments, byte_length = encode_recorded_data(
                name,
                self.schemas[name],
                value,
                next_sequence,
            )
            self.sequence = next_sequence
            self.recorded_names.append(name)
            self._recorded_name_set.add(name)
            self.recorded_bytes += byte_length
            ack = asyncio.get_running_loop().create_future()
            packet = RecordPacket(
                self.sequence,
                name,
                encoded,
                attachments,
                byte_length,
                ack,
                resource_hold=resource_hold,
            )
            if resource_hold is not None:
                resource_hold.hand_off()
            self._record_packets[packet.sequence] = packet
            packet.ack_watchdog = asyncio.create_task(self._watch_record_ack(packet))
            await self.queue.put(packet)
            await asyncio.shield(ack)
            self.completed_sequences.append(packet.sequence)
        except BaseException:
            if resource_hold is not None and not resource_hold.handed_off:
                resource_hold.release()
            raise

    async def progress(self, progress: Any) -> None:
        await asyncio.sleep(0)
        self.latest_progress = progress
        now = time.monotonic()
        if now - self.last_progress_at < 0.1:
            if self.progress_task is None or self.progress_task.done():
                self.progress_task = asyncio.create_task(
                    self._emit_deferred_progress(0.1 - (now - self.last_progress_at))
                )
            return
        await self._emit_latest_progress()

    async def _emit_deferred_progress(self, delay: float) -> None:
        try:
            await asyncio.sleep(max(0, delay))
            await self._emit_latest_progress()
        except asyncio.CancelledError:
            return

    async def _emit_latest_progress(self) -> None:
        if self.active_context is None or self.latest_progress is None:
            return
        progress = self.latest_progress
        self.latest_progress = None
        self.last_progress_at = time.monotonic()
        await self.active_context.emit_event("progress", progress)

    async def _flush_progress(self) -> None:
        task = self.progress_task
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self.progress_task = None
        await self._emit_latest_progress()

    def _acknowledge(self, ack_sequence: int | None) -> None:
        if self.pending is None:
            if ack_sequence is not None:
                raise ProtocolError(f"unexpected ACK sequence {ack_sequence}")
            return
        if ack_sequence != self.pending.sequence:
            raise ProtocolError(
                f"ACK sequence {ack_sequence!r} does not match pending sequence {self.pending.sequence}"
            )
        packet = self.pending
        self._retire_record_packet(packet)
        if not packet.ack.done():
            packet.ack.set_result(None)

    async def _execute(self) -> None:
        started = time.perf_counter()
        try:
            sim = RuntimeSimulationApi(self)
            self.simulation_api = sim
            simulation_vars = read_only(_variables(self.measurement))
            await self._status("running")
            final_state = await asyncio.wait_for(
                self.simulate(
                    sim=sim,
                    tasks=self.tasks,
                    vars=simulation_vars,
                ),
                timeout=self.max_run_seconds,
            )
            final_state_revision = sim.state_revision(final_state)
            await self._status("finalizing")
            duration_ms = int((time.perf_counter() - started) * 1000)
            logger.info(
                "CAE run completed run_id=%s tasks=%s records=%s bytes=%s final_state_revision=%s duration_ms=%s",
                self.run_id,
                [entry["task"] for entry in self.trace],
                list(self.recorded_names),
                self.recorded_bytes,
                final_state_revision,
                duration_ms,
            )
            await self.queue.put(
                {
                    "kind": "complete",
                    "sequence": self.sequence + 1,
                    "recordSequences": list(self.completed_sequences),
                }
            )
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            await self._fail(
                CaeError("run_timeout", "simulation exceeded maxRunSeconds"),
                preserve_pending=True,
            )
        except CaeError as exc:
            await self._fail(exc)
            if exc.code == "record_ack_timeout":
                self._close()
        except Exception as exc:
            await self._fail(CaeError("simulation_error", str(exc) or type(exc).__name__))

    async def _fail(self, error: CaeError, *, preserve_pending: bool = False) -> None:
        if not preserve_pending:
            self._cancel_record_packets()
        await self.queue.put(
            {
                "kind": "failed",
                "sequence": self.sequence + 1,
                "error": {"code": error.code, "message": str(error)},
            }
        )

    async def _status(self, status: str) -> None:
        await self._flush_progress()
        emit(
            {
                "type": "job.progress",
                "job_id": self.job_id,
                "progress": {"kind": "cae.phase", "runId": self.run_id, "status": status},
            }
        )
        if self.active_context is not None:
            await self.active_context.emit_event("status", {"status": status})

    async def _watch_first_next(self) -> None:
        try:
            await asyncio.sleep(FIRST_NEXT_TIMEOUT_SECONDS)
            self._close()
        except asyncio.CancelledError:
            return

    async def _watch_record_ack(self, packet: RecordPacket) -> None:
        try:
            await asyncio.sleep(RECORD_ACK_TIMEOUT_SECONDS)
            if packet.ack.done():
                return
            self._retire_record_packet(packet)
            packet.ack.set_exception(
                CaeError("record_ack_timeout", "record ACK was not received within 120 seconds")
            )
            if self.task is None or self.task.done():
                packet.ack.exception()
            self._close()
        except asyncio.CancelledError:
            return

    async def _emit_heartbeats(self, context: SlaveContext) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            await context.emit_event("heartbeat", {"runId": self.run_id})

    async def _stop_heartbeat(self) -> None:
        task = self.heartbeat_task
        self.heartbeat_task = None
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self.active_context = None

    async def _emit_liveness(self) -> None:
        while True:
            await asyncio.sleep(LIVENESS_SECONDS)
            emit(
                {
                    "type": "job.progress",
                    "job_id": self.job_id,
                    "progress": {"kind": "cae.liveness", "runId": self.run_id},
                }
            )

    def _close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.first_next_watchdog.cancel()
        if self.liveness_task is not None:
            self.liveness_task.cancel()
        if self.progress_task is not None:
            self.progress_task.cancel()
        if self.heartbeat_task is not None:
            self.heartbeat_task.cancel()
            self.heartbeat_task = None
        self.active_context = None
        self._cancel_record_packets()
        if self.simulation_api is not None:
            simulation_api = self.simulation_api
            self.simulation_api = None
            if (
                self.task is not None
                and self.task is not asyncio.current_task()
                and not self.task.done()
            ):
                self.task.add_done_callback(lambda _: simulation_api.close())
            else:
                simulation_api.close()
        self.on_cleanup(self.run_id)
        emit(
            {
                "type": "cae.run.cleaned",
                "job_id": self.job_id,
                "run_id": self.run_id,
            }
        )

    def abort(self) -> None:
        self._cancel_record_packets()
        if self.task is not None and self.task is not asyncio.current_task() and not self.task.done():
            self.task.cancel()
        self._close()

    def _retire_record_packet(self, packet: RecordPacket) -> None:
        if self.pending is packet:
            self.pending = None
        self._record_packets.pop(packet.sequence, None)
        if (
            packet.ack_watchdog is not None
            and packet.ack_watchdog is not asyncio.current_task()
        ):
            packet.ack_watchdog.cancel()
        packet.release_resources()

    def _cancel_record_packets(self) -> None:
        for packet in tuple(self._record_packets.values()):
            self._retire_record_packet(packet)
            if not packet.ack.done():
                packet.ack.cancel()


SimulationApi = RuntimeSimulationApi


def _validate_record_group_members(path: str, schema: dict[str, Any], value: Any) -> None:
    if "dtype" in schema:
        return
    if not isinstance(value, Mapping):
        raise CaeError("invalid_record", f"RecordedData group {path!r} must be an object")
    missing = [name for name in schema if name not in value]
    unknown = [name for name in value if name not in schema]
    if missing or unknown:
        details = []
        if missing:
            details.append(f"missing {missing!r}")
        if unknown:
            details.append(f"unknown {unknown!r}")
        raise CaeError(
            "invalid_record",
            f"RecordedData group {path!r} has incorrect members: {', '.join(details)}",
        )
    for name, member_schema in schema.items():
        _validate_record_group_members(f"{path}.{name}", member_schema, value[name])


def create_run(
    payload: dict[str, Any],
    *,
    job_id: str,
    on_cleanup: Callable[[str], None],
) -> CaeRun:
    return CaeRun(
        measurement=payload["measurement"],
        max_run_seconds=DEFAULT_MAX_RUN_SECONDS,
        job_id=job_id,
        on_cleanup=on_cleanup,
    )


def started_payload(run: CaeRun) -> dict[str, Any]:
    return {
        "kind": "started",
        "runId": run.run_id,
        "maxRunSeconds": run.max_run_seconds,
    }


def _manifest(measurement: dict[str, Any]) -> dict[str, Any]:
    return measurement["experiment"]["simulationProgram"]


def _simulation_source(measurement: dict[str, Any], manifest: dict[str, Any]) -> str:
    del measurement
    return manifest["pythonSource"]


def _variables(measurement: dict[str, Any]) -> dict[str, Any]:
    return measurement["experiment"].get("variables", {})
