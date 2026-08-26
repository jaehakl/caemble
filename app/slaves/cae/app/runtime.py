from __future__ import annotations

import asyncio
import copy
import contextlib
import logging
import time
import uuid
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Awaitable, Callable

import numpy as np
from sdk.protocol.messages import DataChannelAttachment, DataChannelMessage
from sdk.slave import SlaveContext
from sdk.slave.runtime import emit

from app.errors import CaeError, ProtocolError
from app.kernels import normalize_kernel_tasks, resolve_output_specs, run_kernel, solver_spec
from app.program import validate_and_load_simulate
from app.solver_framework.geometry import GeometryService
from app.solver_framework.registry import registry
from app.tensor import encode_recorded_data

FIRST_NEXT_TIMEOUT_SECONDS = 30
RECORD_ACK_TIMEOUT_SECONDS = 120
DEFAULT_MAX_RUN_SECONDS = 2 * 60 * 60
HEARTBEAT_SECONDS = 5
LIVENESS_SECONDS = 5 * 60
logger = logging.getLogger(__name__)


@dataclass
class RecordPacket:
    sequence: int
    name: str
    value: dict[str, Any]
    attachments: list[DataChannelAttachment]
    byte_length: int
    ack: asyncio.Future[None]
    ack_watchdog: asyncio.Task[None] | None = None


class _TaskHandles(Mapping[str, Any]):
    def __init__(self, tasks: dict[str, Any]) -> None:
        self._tasks = MappingProxyType(tasks)

    def __getitem__(self, name: str) -> Any:
        if not isinstance(name, str):
            raise CaeError(
                "invalid_input",
                f"simulate.py tasks[{name!r}] requires a declared Task name string",
            )
        try:
            return self._tasks[name]
        except KeyError:
            raise CaeError(
                "invalid_input",
                f"simulate.py tasks[{name!r}] is not declared",
            ) from None

    def __iter__(self) -> Iterator[str]:
        return iter(self._tasks)

    def __len__(self) -> int:
        return len(self._tasks)

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name in self._tasks


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
        normalized_tasks = normalize_kernel_tasks(tasks)
        canonical_tasks = copy.deepcopy(
            tasks if normalized_tasks is None else normalized_tasks
        )
        self._task_descriptors = {
            name: solver_spec(task, name)
            for name, task in canonical_tasks.items()
        }
        self._output_specs = {
            name: resolve_output_specs(task, name)
            for name, task in canonical_tasks.items()
        }
        self._task_scenes = self.measurement["experiment"]["taskScenes"]
        self._task_material_parameters = self.measurement["taskMaterialParameters"]
        self._task_material_warnings = self.measurement["taskMaterialWarnings"]
        task_handles = {
            name: _read_only(task)
            for name, task in canonical_tasks.items()
        }
        self.tasks = _TaskHandles(task_handles)
        self._registered_tasks = tuple(
            (name, task_handles[name], canonical_tasks[name])
            for name in canonical_tasks
        )
        self.run_id = str(uuid.uuid4())
        self.max_run_seconds = max_run_seconds
        self.job_id = job_id
        self.queue: asyncio.Queue[RecordPacket | dict[str, Any]] = asyncio.Queue()
        self.pending: RecordPacket | None = None
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

    async def record(self, name: str, value: Any) -> None:
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
        packet = RecordPacket(self.sequence, name, encoded, attachments, byte_length, ack)
        packet.ack_watchdog = asyncio.create_task(self._watch_record_ack(packet))
        await self.queue.put(packet)
        await asyncio.shield(ack)
        self.completed_sequences.append(packet.sequence)

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

    def release(self, value: Any) -> None:
        if isinstance(value, np.ndarray):
            if not value.flags.owndata:
                raise CaeError("invalid_release", "sim.release cannot release a NumPy view")
            try:
                value.resize((0,), refcheck=False)
            except ValueError as exc:
                raise CaeError("invalid_release", "sim.release could not release the NumPy buffer") from exc
            return
        if isinstance(value, dict):
            for item in list(value.values()):
                self.release(item)
            value.clear()
            return
        if isinstance(value, list):
            for item in list(value):
                self.release(item)
            value.clear()

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
        self.pending = None
        packet.attachments.clear()
        if packet.ack_watchdog is not None:
            packet.ack_watchdog.cancel()
        if not packet.ack.done():
            packet.ack.set_result(None)

    async def _execute(self) -> None:
        started = time.perf_counter()
        try:
            sim = SimulationApi(self)
            simulation_vars = _read_only(_variables(self.measurement))
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
        if self.pending is not None and not preserve_pending:
            self.pending.attachments.clear()
            if self.pending.ack_watchdog is not None:
                self.pending.ack_watchdog.cancel()
            if not self.pending.ack.done():
                self.pending.ack.cancel()
            self.pending = None
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
            packet.attachments.clear()
            if self.pending is packet:
                self.pending = None
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
        self.on_cleanup(self.run_id)
        emit(
            {
                "type": "cae.run.cleaned",
                "job_id": self.job_id,
                "run_id": self.run_id,
            }
        )

    def abort(self) -> None:
        if self.pending is not None:
            self.pending.attachments.clear()
            if self.pending.ack_watchdog is not None:
                self.pending.ack_watchdog.cancel()
            if not self.pending.ack.done():
                self.pending.ack.cancel()
            self.pending = None
        if self.task is not None and self.task is not asyncio.current_task() and not self.task.done():
            self.task.cancel()
        self._close()


class SimulationApi:
    def __init__(self, run: CaeRun) -> None:
        self._run = run
        self._releasable: dict[int, Any] = {}
        self._artifact_provenance: dict[int, dict[str, Any]] = {}
        self._artifact_sequence = 0
        self._state_revisions: dict[int, tuple[Any, int]] = {}
        self._state_sequence = 0
        self._geometry = GeometryService()

    async def run(
        self,
        task: dict[str, Any],
        options: dict[str, Any] | None = None,
        *,
        state: Any = None,
        inputs: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        started_at = int(time.time() * 1000)
        if options is not None and (state is not None or inputs is not None):
            raise CaeError("invalid_input", "sim.run accepts either options or state/inputs keywords")
        if options is None:
            options = {
                **({"state": state} if state is not None else {}),
                **({"inputs": inputs} if inputs is not None else {}),
            }
        if not isinstance(options, dict) or any(key not in {"state", "inputs"} for key in options):
            raise CaeError("invalid_input", "sim.run options may contain only state and inputs")
        kernel_state = options.get("state")
        kernel_inputs = options.get("inputs", {})
        if not isinstance(kernel_inputs, dict):
            raise CaeError("invalid_input", "sim.run inputs must be an object")
        registered = next(
            (
                (name, normalized)
                for name, candidate, normalized in self._run._registered_tasks
                if candidate is task
            ),
            None,
        )
        if registered is None:
            raise CaeError(
                "invalid_input",
                "sim.run only accepts a task registered by this BuiltMeasurement",
            )
        task_name, normalized_task = registered
        task = copy.deepcopy(normalized_task)
        kernel = task.get("kernel") or {}
        kernel_world = {
            "experiment": self._run.measurement["experiment"]["scene"],
            "task": self._run._task_scenes[task_name],
            "materials": {
                "experiment": {
                    "parameters": self._run.measurement["materialParameters"],
                    "warnings": self._run.measurement["materialWarnings"],
                },
                "task": {
                    "parameters": self._run._task_material_parameters[task_name],
                    "warnings": self._run._task_material_warnings[task_name],
                },
            },
        }
        input_state_revision = self.state_revision(kernel_state)
        trace_inputs = self._validate_inputs(
            task_name,
            self._run._task_descriptors[task_name],
            kernel_inputs,
        )

        async def report(progress: Any) -> None:
            value = progress if isinstance(progress, dict) else {}
            await self._run.progress(
                {
                    "runId": self._run.run_id,
                    "task": task_name,
                    "kernel": {
                        "name": kernel.get("name"),
                        "version": kernel.get("version"),
                    },
                    **value,
                }
            )

        result = await run_kernel(
            task,
            kernel_state,
            kernel_inputs,
            kernel_world,
            report,
            self._geometry,
        )
        finished_at = int(time.time() * 1000)
        artifacts = result.get("artifacts", {})
        output_specs = self._run._output_specs[task_name]
        pending_provenance: list[tuple[Any, dict[str, Any]]] = []
        for output_name, artifact in artifacts.items():
            spec = output_specs.get(output_name, {})
            self._artifact_sequence += 1
            pending_provenance.append(
                (
                    artifact,
                    {
                        "artifact": artifact,
                        "id": f"artifact-{self._artifact_sequence}",
                        "producerTask": task_name,
                        "output": output_name,
                        "artifactType": spec.get("artifactType"),
                        "data": copy.deepcopy(spec.get("data")),
                    },
                )
            )
        output = {
            "state": result.get("state"),
            "artifacts": artifacts,
        }
        output_state_revision = self._register_state(output["state"], kernel_state, input_state_revision)
        self._register_releasable(output)
        for artifact, provenance in pending_provenance:
            self._artifact_provenance[id(artifact)] = provenance
        self._run.trace.append(
            {
                "task": task_name,
                "kernel": {
                    "name": kernel.get("name"),
                    "version": kernel.get("version"),
                },
                "inputStateRevision": input_state_revision,
                "outputStateRevision": output_state_revision,
                "inputArtifacts": trace_inputs,
                "status": "succeeded",
                "startedAt": started_at,
                "finishedAt": finished_at,
                "durationMs": int((time.perf_counter() - started) * 1000),
                "observations": result.get("observations", {}),
            }
        )
        return output

    async def record(self, name: str, value: Any) -> None:
        await self._run.record(name, value)

    def release(self, value: Any) -> None:
        if self._releasable.get(id(value)) is not value:
            raise CaeError("invalid_release", "sim.release accepts only live values returned by sim.run")
        released: dict[int, Any] = {}

        def collect(item: Any) -> None:
            if isinstance(item, (np.ndarray, dict, list)):
                item_id = id(item)
                if item_id in released:
                    return
                if self._releasable.get(item_id) is not item:
                    raise CaeError(
                        "invalid_release",
                        "sim.release found a value that is not live or was not returned by sim.run",
                    )
                released[item_id] = item
            if isinstance(item, dict):
                for child in item.values():
                    collect(child)
            elif isinstance(item, list):
                for child in item:
                    collect(child)

        collect(value)
        self._run.release(value)
        for item_id, item in released.items():
            if self._releasable.get(item_id) is item:
                del self._releasable[item_id]
            provenance = self._artifact_provenance.get(item_id)
            if provenance is not None and provenance["artifact"] is item:
                del self._artifact_provenance[item_id]
            state = self._state_revisions.get(item_id)
            if state is not None and state[0] is item:
                del self._state_revisions[item_id]

    def state_revision(self, value: Any) -> int:
        if value is None:
            return 0
        registered = self._state_revisions.get(id(value))
        if registered is None or registered[0] is not value:
            raise CaeError(
                "invalid_state",
                "simulation state must be None or a live state returned by sim.run",
            )
        return registered[1]

    def _register_state(self, value: Any, input_state: Any, input_revision: int) -> int:
        if value is input_state:
            return input_revision
        if value is None:
            return 0
        registered = self._state_revisions.get(id(value))
        if registered is not None and registered[0] is value:
            return registered[1]
        self._state_sequence += 1
        self._state_revisions[id(value)] = (value, self._state_sequence)
        return self._state_sequence

    def _register_releasable(self, value: Any) -> None:
        if isinstance(value, np.ndarray):
            self._releasable[id(value)] = value
        elif isinstance(value, dict):
            self._releasable[id(value)] = value
            for item in value.values():
                self._register_releasable(item)
        elif isinstance(value, list):
            self._releasable[id(value)] = value
            for item in value:
                self._register_releasable(item)

    def _validate_inputs(
        self,
        task_name: str,
        descriptor: dict[str, Any],
        inputs: dict[str, Any],
    ) -> dict[str, Any]:
        ports = descriptor["inputPorts"]
        unknown = next((name for name in inputs if name not in ports), None)
        if unknown is not None:
            raise CaeError(
                "invalid_input",
                f"task {task_name} input port {unknown!r} is not declared",
            )
        trace_inputs: dict[str, Any] = {}
        for port_name, port in ports.items():
            present = port_name in inputs
            if not present and port["minimumOccurrences"] > 0:
                raise CaeError(
                    "invalid_input",
                    f"task {task_name} input port {port_name!r} is required",
                )
            if not present:
                continue
            raw = inputs[port_name]
            artifacts = raw if isinstance(raw, list) else [raw]
            if not port["minimumOccurrences"] <= len(artifacts) <= port["maximumOccurrences"]:
                raise CaeError(
                    "invalid_input",
                    f"task {task_name} input port {port_name!r} requires "
                    f"{port['minimumOccurrences']}..{port['maximumOccurrences']} artifacts",
                )
            trace_artifacts = []
            for artifact in artifacts:
                provenance = self._artifact_provenance.get(id(artifact))
                if (
                    provenance is None
                    or provenance["artifact"] is not artifact
                    or self._releasable.get(id(artifact)) is not artifact
                ):
                    raise CaeError(
                        "invalid_input",
                        f"task {task_name} input port {port_name!r} accepts only a live "
                        "artifact returned by sim.run",
                    )
                if provenance["artifactType"] not in port["artifactTypes"]:
                    raise CaeError(
                        "invalid_input",
                        f"task {task_name} input port {port_name!r} rejects artifact type "
                        f"{provenance['artifactType']!r}",
                    )
                trace_artifacts.append(
                    {"id": provenance["id"], "artifactType": provenance["artifactType"]}
                )
            trace_inputs[port_name] = trace_artifacts if isinstance(raw, list) else trace_artifacts[0]
        return trace_inputs


def _read_only(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _read_only(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_read_only(item) for item in value)
    return value


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
