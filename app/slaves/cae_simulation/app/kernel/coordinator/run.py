from __future__ import annotations

import asyncio
import copy
import contextlib
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from app.kernel.api.errors import CaeError, ProtocolError
from app.kernel.coordinator.plan import RunPlan, read_only
from app.kernel.coordinator.simulation import SimulationApi
from app.kernel.coordinator.program import validate_and_load_simulate
from app.kernel.transport import RecordPacket, RecordResourceHold
from app.kernel.transport.tensor import encode_recorded_data

DEFAULT_MAX_RUN_SECONDS = 2 * 60 * 60
logger = logging.getLogger(__name__)


class CaeRun:
    def __init__(
        self,
        *,
        measurement: dict[str, Any],
        max_run_seconds: int,
        job_id: str,
        on_progress: Callable[[Any], Awaitable[None]] | None = None,
    ) -> None:
        self.measurement = copy.deepcopy(measurement)
        manifest = self.measurement["experiment"]["simulationProgram"]
        source = manifest["pythonSource"]
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
        self.sequence = 0
        self.completed_sequences: list[int] = []
        self.visualization_sequences: list[int] = []
        self.recorded_names: list[str] = []
        self._recorded_name_set: set[str] = set()
        self.recorded_bytes = 0
        self.on_progress = on_progress
        self.last_progress_at = 0.0
        self.latest_progress: Any = None
        self.progress_task: asyncio.Task[None] | None = None
        self.trace: list[dict[str, Any]] = []
        self.closed = False
        self.simulation_api: SimulationApi | None = None

    def start(self) -> None:
        if self.closed or self.task is not None:
            raise ProtocolError("CAE run has already started or closed")
        self.task = asyncio.create_task(self._execute())

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

    async def visualization(self, task: str, values: Any, *, resource_hold: RecordResourceHold) -> None:
        try:
            await self._flush_progress()
            sequence = self.sequence + 1
            encoded, attachments, byte_length = {}, [], 0
            for name, entry in values.items():
                data, parts, size = encode_recorded_data(name, entry["schema"], entry["data"], sequence)
                encoded[name] = {**entry, "data": data}
                attachments.extend(parts)
                byte_length += size
            self.sequence = sequence
            ack = asyncio.get_running_loop().create_future()
            packet = RecordPacket(sequence, task, encoded, attachments, byte_length, ack,
                                  resource_hold=resource_hold, kind="visualization")
            resource_hold.hand_off()
            self._record_packets[sequence] = packet
            await self.queue.put(packet)
            await asyncio.shield(ack)
            self.visualization_sequences.append(sequence)
        except BaseException:
            if not resource_hold.handed_off:
                resource_hold.release()
            raise

    async def _emit_deferred_progress(self, delay: float) -> None:
        try:
            await asyncio.sleep(max(0, delay))
            await self._emit_latest_progress()
        except asyncio.CancelledError:
            return

    async def _emit_latest_progress(self) -> None:
        if self.on_progress is None or self.latest_progress is None:
            return
        progress = self.latest_progress
        self.latest_progress = None
        self.last_progress_at = time.monotonic()
        await self.on_progress(progress)

    async def _flush_progress(self) -> None:
        task = self.progress_task
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self.progress_task = None
        await self._emit_latest_progress()

    def acknowledge(self, ack_sequence: int | None) -> None:
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
            sim = SimulationApi(self)
            self.simulation_api = sim
            simulation_vars = read_only(self.measurement["experiment"].get("variables", {}))
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
            await sim._flush_visualizations()
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
                    "visualizationSequences": list(self.visualization_sequences),
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
        if self.on_progress is not None:
            await self.on_progress({"kind": "cae.phase", "runId": self.run_id, "status": status})

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self.progress_task is not None:
            self.progress_task.cancel()
            await asyncio.gather(self.progress_task, return_exceptions=True)
        self._cancel_record_packets()
        if self.task is not None and self.task is not asyncio.current_task():
            if not self.task.done():
                self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        if self.simulation_api is not None:
            await self.simulation_api.aclose()
            self.simulation_api = None

    def _retire_record_packet(self, packet: RecordPacket) -> None:
        if self.pending is packet:
            self.pending = None
        self._record_packets.pop(packet.sequence, None)
        packet.release_resources()

    def _cancel_record_packets(self) -> None:
        for packet in tuple(self._record_packets.values()):
            self._retire_record_packet(packet)
            if not packet.ack.done():
                packet.ack.cancel()


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
