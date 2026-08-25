from __future__ import annotations

import asyncio
import copy
import contextlib
import json
import logging
import math
import time
import uuid
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Awaitable, Callable

import numpy as np
from sdk.protocol.messages import DataChannelAttachment, DataChannelMessage
from sdk.slave import SlaveContext
from sdk.slave.runtime import emit

from app.errors import CaeError, ProtocolError
from app.kernels import resolve_output_specs, run_kernel, solver_spec, validate_kernel_tasks
from app.program import SIMULATION_API_VERSION, validate_and_load_simulate
from app.solver_framework.geometry import GeometryService, validate_canonical_geometry_scene
from app.solver_framework.geometry.complexity import (
    MAX_BOOLEAN_WORK,
    MAX_TRIANGLES,
    estimated_boolean_work,
    estimated_triangle_count,
)
from app.solver_framework.registry import registry
from app.tensor import (
    MAX_RECORDED_BYTES,
    MAX_SAFE_INTEGER,
    encode_tensor,
    validate_data_schema,
    validate_tensor_value,
)

FIRST_NEXT_TIMEOUT_SECONDS = 30
RECORD_ACK_TIMEOUT_SECONDS = 120
DEFAULT_MAX_RUN_SECONDS = 2 * 60 * 60
HEARTBEAT_SECONDS = 5
LIVENESS_SECONDS = 5 * 60
MAX_VARS_TENSOR_ELEMENTS = 65_536
MAX_TASK_SCENES = 128
logger = logging.getLogger(__name__)


@dataclass
class RecordPacket:
    sequence: int
    name: str
    tensor: dict[str, Any]
    attachments: list[DataChannelAttachment]
    byte_length: int
    ack: asyncio.Future[None]
    ack_watchdog: asyncio.Task[None] | None = None


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
        api_version = manifest.get("simulationApiVersion", manifest.get("simulation_api_version", SIMULATION_API_VERSION))
        if str(api_version) != SIMULATION_API_VERSION:
            raise CaeError("unsupported_program", f"simulation API version {api_version!r} is not supported")
        self.simulate = validate_and_load_simulate(source)
        tasks = manifest.get("tasks")
        self.schemas = manifest.get("recordedData")
        if not isinstance(tasks, dict) or not tasks or not isinstance(self.schemas, dict):
            raise CaeError("invalid_program", "simulation manifest tasks and recordedData are required")
        normalized_tasks = validate_kernel_tasks(tasks)
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
        for name, task in canonical_tasks.items():
            _validate_task_artifact_contract(
                name,
                self._task_descriptors[name],
                self._output_specs[name],
            )
        task_handles = {
            name: _read_only(task)
            for name, task in canonical_tasks.items()
        }
        self.tasks = MappingProxyType(task_handles)
        self._registered_tasks = tuple(
            (name, task_handles[name], canonical_tasks[name])
            for name in canonical_tasks
        )
        for name, schema in self.schemas.items():
            if not isinstance(name, str) or not name:
                raise CaeError("invalid_schema", "RecordedData names must be non-empty strings")
            validate_data_schema(schema, f"RecordedData {name}")
        self.run_id = str(uuid.uuid4())
        self.max_run_seconds = max_run_seconds
        self.job_id = job_id
        self.queue: asyncio.Queue[RecordPacket | dict[str, Any]] = asyncio.Queue()
        self.pending: RecordPacket | None = None
        self.task: asyncio.Task[None] | None = None
        self.first_next = False
        self.sequence = 0
        self.completed_sequences: list[int] = []
        self.recorded_names: set[str] = set()
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
                    "tensor": item.tensor,
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
        if name not in self.schemas:
            raise CaeError("invalid_record", f"RecordedData {name!r} is not declared")
        if name in self.recorded_names:
            raise CaeError("invalid_record", f"RecordedData {name!r} was already recorded")
        self.recorded_names.add(name)
        await self._flush_progress()
        next_sequence = self.sequence + 1
        tensor, attachments, byte_length = encode_tensor(
            name,
            self.schemas[name],
            value,
            next_sequence,
            max_byte_length=MAX_RECORDED_BYTES - self.recorded_bytes,
        )
        self.sequence = next_sequence
        self.recorded_bytes += byte_length
        ack = asyncio.get_running_loop().create_future()
        packet = RecordPacket(self.sequence, name, tensor, attachments, byte_length, ack)
        packet.ack_watchdog = asyncio.create_task(self._watch_record_ack(packet))
        await self.queue.put(packet)
        await asyncio.shield(ack)
        self.completed_sequences.append(packet.sequence)

    async def progress(self, progress: Any) -> None:
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
            await self._status("validating")
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
        artifacts = result.get("artifacts")
        if not isinstance(artifacts, dict):
            raise CaeError("invalid_output", f"task {task_name} kernel artifacts must be an object")
        output_specs = self._run._output_specs[task_name]
        if set(artifacts) != set(output_specs):
            raise CaeError(
                "invalid_output",
                f"task {task_name} kernel artifacts do not match its resolved output specs",
            )
        pending_provenance: list[tuple[Any, dict[str, Any]]] = []
        seen_artifacts: set[int] = set()
        for output_name, artifact in artifacts.items():
            if not isinstance(artifact, dict) or "value" not in artifact:
                raise CaeError(
                    "invalid_output",
                    f"task {task_name} artifact {output_name!r} must contain a value",
                )
            validate_tensor_value(
                f"task {task_name} artifact {output_name!r}",
                output_specs[output_name]["data"],
                artifact,
            )
            artifact_id = id(artifact)
            if artifact_id in seen_artifacts or (
                artifact_id in self._artifact_provenance
                and self._artifact_provenance[artifact_id]["artifact"] is artifact
            ):
                raise CaeError(
                    "invalid_output",
                    f"task {task_name} returned a reused artifact object",
                )
            seen_artifacts.add(artifact_id)
            self._artifact_sequence += 1
            pending_provenance.append(
                (
                    artifact,
                    {
                        "artifact": artifact,
                        "id": f"artifact-{self._artifact_sequence}",
                        "producerTask": task_name,
                        "output": output_name,
                        "artifactType": output_specs[output_name]["artifactType"],
                        "data": copy.deepcopy(output_specs[output_name]["data"]),
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
            raise CaeError("invalid_release", "sim.release accepts only state or artifacts returned by sim.run")
        released: dict[int, Any] = {}

        def collect(item: Any) -> None:
            if isinstance(item, (np.ndarray, dict, list)):
                item_id = id(item)
                if item_id in released:
                    return
                if self._releasable.get(item_id) is not item:
                    raise CaeError(
                        "invalid_release",
                        "sim.release found a value that was not returned by sim.run",
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
                        f"task {task_name} input port {port_name!r} accepts only a live artifact returned by sim.run",
                    )
                if provenance["artifactType"] not in port["artifactTypes"]:
                    raise CaeError(
                        "invalid_input",
                        f"task {task_name} input port {port_name!r} rejects artifact type "
                        f"{provenance['artifactType']!r}",
                    )
                expected_schema = port.get("data")
                if expected_schema is not None and provenance["data"] != expected_schema:
                    raise CaeError(
                        "invalid_input",
                        f"task {task_name} input port {port_name!r} DataSchema is incompatible with "
                        f"{provenance['producerTask']}.{provenance['output']}",
                    )
                trace_artifacts.append(
                    {
                        "id": provenance["id"],
                        "artifactType": provenance["artifactType"],
                    }
                )
            trace_inputs[port_name] = trace_artifacts if isinstance(raw, list) else trace_artifacts[0]
        return trace_inputs


def _validate_task_artifact_contract(
    task_name: str,
    descriptor: dict[str, Any],
    output_specs: dict[str, Any],
) -> None:
    ports = descriptor.get("inputPorts")
    if not isinstance(ports, dict):
        raise CaeError("descriptor_mismatch", f"task {task_name} descriptor inputPorts are invalid")
    for port_name, port in ports.items():
        if not isinstance(port_name, str) or not port_name or not isinstance(port, dict):
            raise CaeError("descriptor_mismatch", f"task {task_name} descriptor input port is invalid")
        artifact_types = port.get("artifactTypes")
        minimum = port.get("minimumOccurrences")
        maximum = port.get("maximumOccurrences")
        if (
            not isinstance(artifact_types, list)
            or not artifact_types
            or any(not isinstance(item, str) or not item for item in artifact_types)
            or not isinstance(minimum, int)
            or isinstance(minimum, bool)
            or not isinstance(maximum, int)
            or isinstance(maximum, bool)
            or minimum < 0
            or maximum < minimum
        ):
            raise CaeError(
                "descriptor_mismatch",
                f"task {task_name} descriptor input port {port_name!r} is invalid",
            )
        if port.get("data") is not None:
            validate_data_schema(port["data"], f"task {task_name}.inputPorts.{port_name}.data")

    for output_name, spec in output_specs.items():
        if (
            not isinstance(output_name, str)
            or not output_name
            or not isinstance(spec, dict)
            or set(spec) != {"artifactType", "data"}
            or not isinstance(spec.get("artifactType"), str)
            or not spec["artifactType"]
        ):
            raise CaeError(
                "invalid_program",
                f"task {task_name} resolved output artifact {output_name!r} is invalid",
            )
        validate_data_schema(spec.get("data"), f"task {task_name}.outputs.{output_name}.data")


def _read_only(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _read_only(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_read_only(item) for item in value)
    return value


def create_run(
    payload: dict[str, Any],
    *,
    job_id: str,
    on_cleanup: Callable[[str], None],
) -> CaeRun:
    if (
        not isinstance(payload, dict)
        or set(payload) != {"formatVersion", "measurement", "solverContracts"}
        or payload.get("formatVersion") != 2
        or isinstance(payload.get("formatVersion"), bool)
    ):
        raise CaeError(
            "invalid_input",
            "start payload must contain exactly formatVersion 2, measurement, and solverContracts",
        )
    measurement = payload.get("measurement")
    _validate_built_measurement(measurement)
    simulation_program = measurement["experiment"]["simulationProgram"]
    registry.validate_contracts(payload.get("solverContracts"), simulation_program.get("tasks"))
    return CaeRun(
        measurement=measurement,
        max_run_seconds=DEFAULT_MAX_RUN_SECONDS,
        job_id=job_id,
        on_cleanup=on_cleanup,
    )


def _validate_built_measurement(value: Any) -> None:
    if not isinstance(value, dict) or value.get("kind") != "measurement":
        raise CaeError("invalid_input", "start.measurement must be a BuiltMeasurement")
    if set(value) != {
        "kind", "experiment", "materialParameters", "materialWarnings",
        "taskMaterialParameters", "taskMaterialWarnings",
    }:
        raise CaeError("invalid_input", "start.measurement fields are invalid")
    snapshot = value.get("experiment")
    _validate_snapshot(snapshot)
    _validate_material_snapshot(value.get("materialParameters"), "start.measurement.materialParameters")
    warnings = value.get("materialWarnings")
    if not isinstance(warnings, list) or any(not isinstance(item, str) for item in warnings):
        raise CaeError("invalid_input", "start.measurement.materialWarnings must be an array of strings")
    task_names = set(snapshot["taskScenes"])
    material_parameters = value.get("taskMaterialParameters")
    material_warnings = value.get("taskMaterialWarnings")
    if not isinstance(material_parameters, dict) or set(material_parameters) != task_names:
        raise CaeError("invalid_input", "start.measurement.taskMaterialParameters must exactly match Task scenes")
    if not isinstance(material_warnings, dict) or set(material_warnings) != task_names:
        raise CaeError("invalid_input", "start.measurement.taskMaterialWarnings must exactly match Task scenes")
    for task_name in task_names:
        _validate_material_snapshot(
            material_parameters[task_name],
            f"start.measurement.taskMaterialParameters.{task_name}",
        )
        warnings = material_warnings[task_name]
        if not isinstance(warnings, list) or any(not isinstance(item, str) for item in warnings):
            raise CaeError(
                "invalid_input",
                f"start.measurement.taskMaterialWarnings.{task_name} must be an array of strings",
            )


def _validate_snapshot(value: Any) -> None:
    expected = {"kind", "sourceHash", "variables", "varsSchema", "scene", "taskScenes", "simulationProgram"}
    if not isinstance(value, dict) or value.get("kind") != "experiment" or set(value) != expected:
        raise CaeError("invalid_input", "Built Experiment snapshot fields are invalid")
    source_hash = value.get("sourceHash")
    if (
        not isinstance(source_hash, str)
        or len(source_hash) != 64
        or any(character not in "0123456789abcdef" for character in source_hash)
    ):
        raise CaeError("invalid_input", "Built Experiment sourceHash is invalid")
    if (
        not isinstance(value.get("variables"), dict)
        or not isinstance(value.get("varsSchema"), dict)
    ):
        raise CaeError("invalid_input", "Built Experiment variables are invalid")
    _validate_variables(
        value["variables"],
        value["varsSchema"],
        "Built Experiment",
    )
    _validate_scene(value.get("scene"), "Built Experiment.scene")
    task_scenes = value.get("taskScenes")
    if not isinstance(task_scenes, dict) or not task_scenes:
        raise CaeError("invalid_input", "Built experiment.taskScenes must be a non-empty object")
    if len(task_scenes) > MAX_TASK_SCENES:
        raise CaeError(
            "resource_limit",
            f"Built experiment.taskScenes may contain at most {MAX_TASK_SCENES} Task scenes",
        )
    for task_name, scene in task_scenes.items():
        if not isinstance(task_name, str) or not task_name.strip():
            raise CaeError("invalid_input", "Built experiment Task names must be non-empty strings")
        _validate_scene(scene, f"Built experiment.taskScenes.{task_name}")
    manifest = value.get("simulationProgram")
    tasks = manifest.get("tasks") if isinstance(manifest, dict) else None
    if not isinstance(tasks, dict) or set(tasks) != set(task_scenes):
        raise CaeError("invalid_input", "Built experiment Task scenes must exactly match simulationProgram tasks")
    geometry_roots: set[tuple[str, str]] = set()
    aggregate_triangles = 0
    aggregate_boolean_work = 0
    for scene in [value["scene"], *task_scenes.values()]:
        for root in scene["roots"]:
            identity = (scene["geometryHash"], root["id"])
            if identity in geometry_roots:
                continue
            geometry_roots.add(identity)
            aggregate_triangles += estimated_triangle_count(root["node"])
            aggregate_boolean_work = min(
                MAX_BOOLEAN_WORK + 1,
                aggregate_boolean_work + estimated_boolean_work(root["node"]),
            )
            if aggregate_triangles > MAX_TRIANGLES:
                raise CaeError(
                    "resource_limit",
                    "Built Experiment geometry roots exceed the aggregate "
                    f"limit of {MAX_TRIANGLES} estimated triangles",
                )
            if aggregate_boolean_work > MAX_BOOLEAN_WORK:
                raise CaeError(
                    "resource_limit",
                    "Built Experiment geometry roots exceed the aggregate "
                    f"Boolean work limit of {MAX_BOOLEAN_WORK}",
                )


def _validate_variables(variables: dict[str, Any], schema: dict[str, Any], path: str) -> None:
    if set(variables) != set(schema):
        raise CaeError("invalid_input", f"{path} variables must exactly match varsSchema")
    for name, entry in schema.items():
        if not isinstance(name, str) or not name.strip() or not isinstance(entry, dict):
            raise CaeError("invalid_input", f"{path}.varsSchema.{name} is invalid")
        if "shape" not in entry:
            raise CaeError(
                "invalid_input",
                f"{path}.varsSchema.{name}.shape is required by CAD API v9; update the Experiment source",
            )
        if set(entry) != {"shape", "min", "max"}:
            raise CaeError("invalid_input", f"{path}.varsSchema.{name} must define only shape, min, and max")
        shape = _validate_vars_shape(entry["shape"], f"{path}.varsSchema.{name}.shape")
        minimum = entry["min"]
        maximum = entry["max"]
        if not _is_finite_number(minimum):
            raise CaeError("invalid_input", f"{path}.varsSchema.{name}.min must be a finite number")
        if not _is_finite_number(maximum):
            raise CaeError("invalid_input", f"{path}.varsSchema.{name}.max must be a finite number")
        if minimum > maximum:
            raise CaeError("invalid_input", f"{path}.varsSchema.{name} min exceeds max")
        _validate_numeric_shape(variables[name], shape, f"{path}.variables.{name}")
        _validate_numeric_range(
            variables[name],
            minimum,
            maximum,
            shape,
            f"{path}.variables.{name}",
        )


def _validate_vars_shape(value: Any, path: str) -> tuple[int, ...]:
    if not isinstance(value, list):
        raise CaeError("invalid_input", f"{path} must be an array of positive safe integers")
    elements = 1
    shape = []
    for index, size in enumerate(value):
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0 or size > MAX_SAFE_INTEGER:
            raise CaeError("invalid_input", f"{path}[{index}] must be a positive safe integer")
        elements *= size
        if elements > MAX_VARS_TENSOR_ELEMENTS:
            raise CaeError(
                "invalid_input",
                f"{path} must contain at most {MAX_VARS_TENSOR_ELEMENTS} elements",
            )
        shape.append(size)
    return tuple(shape)


def _numeric_tensor_shape(value: Any, path: str) -> tuple[int, ...]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not _is_finite_number(value):
            raise CaeError("invalid_input", f"{path} must contain only finite numbers")
        return ()
    if not isinstance(value, list) or not value:
        raise CaeError("invalid_input", f"{path} must be a non-empty rectangular numeric tensor")
    child_shape = _numeric_tensor_shape(value[0], f"{path}[0]")
    for index, item in enumerate(value[1:], 1):
        if _numeric_tensor_shape(item, f"{path}[{index}]") != child_shape:
            raise CaeError("invalid_input", f"{path} must be rectangular")
    return (len(value), *child_shape)


def _validate_numeric_shape(
    value: Any,
    shape: tuple[int, ...],
    path: str,
    *,
    allow_scalar: bool = False,
) -> None:
    if allow_scalar and isinstance(value, (int, float)) and not isinstance(value, bool):
        if not _is_finite_number(value):
            raise CaeError("invalid_input", f"{path} must be finite")
        return
    actual = _numeric_tensor_shape(value, path)
    if actual != shape:
        raise CaeError("invalid_input", f"{path} must have shape {list(shape)}")


def _validate_numeric_range(
    value: Any,
    minimum: float,
    maximum: float,
    shape: tuple[int, ...],
    path: str,
) -> None:
    if not shape:
        if value < minimum or value > maximum:
            raise CaeError("invalid_input", f"{path} is outside varsSchema range")
        return
    for index, item in enumerate(value):
        _validate_numeric_range(
            item,
            minimum,
            maximum,
            shape[1:],
            f"{path}[{index}]",
        )


def _validate_scene(value: Any, path: str) -> None:
    validate_canonical_geometry_scene(value, path)


def _validate_material_snapshot(value: Any, path: str) -> None:
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != 1
        or any(key not in {"schemaVersion", "materials", "materialColors"} for key in value)
        or not isinstance(value.get("materials"), dict)
    ):
        raise CaeError("invalid_input", f"{path} is invalid")
    colors = value.get("materialColors")
    if colors is not None and not isinstance(colors, dict):
        raise CaeError("invalid_input", f"{path}.materialColors is invalid")
    if isinstance(colors, dict):
        for material, entry in colors.items():
            if (
                not isinstance(material, str)
                or not material
                or not isinstance(entry, dict)
                or set(entry) != {"color", "materialId"}
                or not isinstance(entry.get("color"), str)
                or len(entry["color"]) != 7
                or entry["color"][0] != "#"
                or any(character not in "0123456789abcdef" for character in entry["color"][1:])
                or not _is_safe_integer(entry.get("materialId"))
            ):
                raise CaeError("invalid_input", f"{path}.materialColors is invalid")
    for material, parameters in value["materials"].items():
        if not isinstance(material, str) or not material or not isinstance(parameters, dict):
            raise CaeError("invalid_input", f"{path}.materials is invalid")
        for name, entry in parameters.items():
            if (
                not isinstance(name, str)
                or not name
                or not isinstance(entry, dict)
                or set(entry)
                != {"origin", "value", "source", "version", "materialId", "materialParameterId"}
                or entry.get("origin") not in {"database", "source"}
                or (entry.get("source") is not None and not isinstance(entry["source"], str))
                or (entry.get("version") is not None and not isinstance(entry["version"], str))
                or (
                    entry.get("materialId") is not None
                    and not _is_safe_integer(entry["materialId"])
                )
                or (
                    entry.get("materialParameterId") is not None
                    and not _is_safe_integer(entry["materialParameterId"])
                )
            ):
                raise CaeError("invalid_input", f"{path}.{material}.{name} is invalid")
            _validate_material_value(entry["value"], f"{path}.{material}.{name}.value")


def _validate_material_value(value: Any, path: str) -> None:
    if not isinstance(value, dict):
        raise CaeError("invalid_input", f"{path} is invalid")
    if set(value) == {"dtype", "value", "unit"}:
        dtype = value.get("dtype")
        if (
            dtype not in {"float16", "float32", "float64"}
            or not isinstance(value.get("unit"), str)
            or not value["unit"]
        ):
            raise CaeError("invalid_input", f"{path} property descriptor is invalid")
        _validate_float_tensor(value["value"], dtype, f"{path}.value")
        return
    if (
        set(value) != {"kind", "input", "output"}
        or value.get("kind") != "sampled_relation"
    ):
        raise CaeError("invalid_input", f"{path} is invalid")
    series = []
    for side in ("input", "output"):
        item = value.get(side)
        if (
            not isinstance(item, dict)
            or set(item) != {"unit", "values"}
            or not isinstance(item.get("unit"), str)
            or not item["unit"]
            or not isinstance(item.get("values"), list)
            or not item["values"]
        ):
            raise CaeError("invalid_input", f"{path}.{side} is invalid")
        sample_shape = _numeric_tensor_shape(item["values"][0], f"{path}.{side}.values[0]")
        for index, sample in enumerate(item["values"]):
            _validate_numeric_shape(
                sample,
                sample_shape,
                f"{path}.{side}.values[{index}]",
            )
        series.append(item["values"])
    if len(series[0]) != len(series[1]):
        raise CaeError("invalid_input", f"{path} sampled relation lengths differ")


def _validate_float_tensor(value: Any, dtype: str, path: str) -> None:
    _numeric_tensor_shape(value, path)
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(item)
            continue
        if dtype == "float16" and abs(item) > 65504:
            raise CaeError("invalid_input", f"{path} exceeds float16 range")
        if dtype == "float32":
            try:
                finite = math.isfinite(float(np.float32(item)))
            except (OverflowError, ValueError):
                finite = False
            if not finite:
                raise CaeError("invalid_input", f"{path} exceeds float32 range")


def _is_safe_integer(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER
    )


def _is_finite_number(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def started_payload(run: CaeRun) -> dict[str, Any]:
    return {
        "kind": "started",
        "runId": run.run_id,
        "maxRunSeconds": run.max_run_seconds,
    }


def _manifest(measurement: dict[str, Any]) -> dict[str, Any]:
    experiment = measurement.get("experiment")
    manifest = experiment.get("simulationProgram") if isinstance(experiment, dict) else None
    if (
        not isinstance(manifest, dict)
        or manifest.get("formatVersion") != 5
        or set(manifest) != {
            "formatVersion",
            "simulationApiVersion",
            "pythonSource",
            "tasks",
            "recordedData",
        }
    ):
        raise CaeError("invalid_program", "BuiltMeasurement simulationProgram formatVersion 5 is required")
    return manifest


def _simulation_source(measurement: dict[str, Any], manifest: dict[str, Any]) -> str:
    del measurement
    if isinstance(manifest.get("pythonSource"), str) and manifest["pythonSource"].strip():
        return manifest["pythonSource"]
    raise CaeError("invalid_program", "BuiltMeasurement has no Python simulation source")


def _variables(measurement: dict[str, Any]) -> dict[str, Any]:
    experiment = measurement.get("experiment")
    variables = experiment.get("variables") if isinstance(experiment, dict) else None
    return variables if isinstance(variables, dict) else {}


def _json_state(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return None
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError):
        return None
    if len(encoded) > 64 * 1024:
        return None
    return value
