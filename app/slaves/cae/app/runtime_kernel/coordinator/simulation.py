from __future__ import annotations

import asyncio
import tempfile
import time
from collections.abc import Mapping
from typing import Any, Protocol

from app.errors import CaeError
from app.runtime_kernel.coordinator.contracts import validate_artifact_payload
from app.runtime_kernel.coordinator.kernels import run_kernel_transaction
from app.runtime_kernel.coordinator.commit import commit_result
from app.runtime_kernel.coordinator.plan import RunPlan, TaskSpec, detached
from app.runtime_kernel.api import InputArtifact, SolverResourceServices
from app.runtime_kernel.execution import MmapPayloadCodec, SpawnSolverExecutor
from app.runtime_kernel.resources import (
    ArtifactHandle,
    ArtifactStore,
    BufferStore,
    Field,
    StructuredBundle,
    StructuredGrid,
    ResourceLease,
    ResourceScopeError,
    ResourceStore,
    StateHandle,
    StateStore,
)
from app.runtime_kernel.transport import RecordResourceHold


class SimulationHost(Protocol):
    plan: RunPlan
    run_id: str
    max_run_seconds: int
    trace: list[dict[str, Any]]

    async def progress(self, progress: Any) -> None: ...

    async def record(
        self, name: str, value: Any, *, resource_hold: RecordResourceHold | None = None
    ) -> None: ...


class SimulationApi:
    """Resident, run-scoped coordinator exposed to trusted ``simulate.py``."""

    def __init__(self, run: SimulationHost) -> None:
        self._run = run
        self._resources = ResourceStore(f"run-{run.run_id}")
        self._states = StateStore(self._resources, state_store_id=f"states-{run.run_id}")
        self._artifacts = ArtifactStore(
            self._resources,
            artifact_store_id=f"artifacts-{run.run_id}",
        )
        self._buffers = BufferStore()
        self._executor = SpawnSolverExecutor(codec=MmapPayloadCodec(self._buffers))
        self._geometry_cache = tempfile.TemporaryDirectory(
            prefix="caemble-cae-geometry-cache-"
        )
        self._closed = False

    async def run(
        self,
        task: Mapping[str, Any],
        options: dict[str, Any] | None = None,
        *,
        state: Any = None,
        inputs: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self._ensure_open()
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
        raw_inputs = options.get("inputs", {})
        if not isinstance(raw_inputs, dict):
            raise CaeError("invalid_input", "sim.run inputs must be an object")

        task_spec = self._run.plan.resolve(task)
        task_name = task_spec.name
        normalized_task = detached(task_spec.task)
        kernel = normalized_task["kernel"]
        base_state = self._base_state(options.get("state"))
        world = self._run.plan.world(task_spec)

        async def report(progress: Any) -> None:
            value = progress if isinstance(progress, dict) else {}
            await self._run.progress(
                {
                    "runId": self._run.run_id,
                    "task": task_name,
                    "kernel": {"name": kernel.get("name"), "version": kernel.get("version")},
                    **value,
                }
            )

        input_leases: list[ResourceLease] = []
        state_lease = self._states.acquire_invocation(base_state, owner=f"invocation:{task_name}")
        trace_inputs: dict[str, Any] = {}
        try:
            trace_inputs, invocation_inputs = self._validate_inputs(task_spec, raw_inputs, input_leases)
            transaction = await run_kernel_transaction(
                normalized_task,
                base_state.to_mutable(),
                invocation_inputs,
                world,
                report,
                task_name=task_name,
                task_spec=task_spec,
                timeout=float(self._run.max_run_seconds),
                executor=self._executor,
                resources=SolverResourceServices(
                    geometry_cache_path=self._geometry_cache.name,
                ),
            )
            result = transaction.value
            output_state, artifacts = commit_result(
                transaction, task_spec, base_state,
                resources=self._resources, states=self._states, artifacts=self._artifacts,
            )
        except asyncio.CancelledError:
            raise
        except CaeError:
            raise
        except Exception as exc:
            self._run.trace.append(
                {
                    "task": task_name,
                    "kernel": {"name": kernel.get("name"), "version": kernel.get("version")},
                    "inputStateRevision": base_state.revision,
                    "inputArtifacts": trace_inputs,
                    "status": "failed",
                    "startedAt": started_at,
                    "finishedAt": int(time.time() * 1000),
                    "durationMs": int((time.perf_counter() - started) * 1000),
                    "error": type(exc).__name__,
                }
            )
            raise

        finally:
            for lease in reversed(input_leases):
                self._resources.release(lease)
            self._states.release_invocation(state_lease)

        finished_at = int(time.time() * 1000)
        self._run.trace.append(
            {
                "task": task_name,
                "kernel": {"name": kernel.get("name"), "version": kernel.get("version")},
                "inputStateRevision": base_state.revision,
                "outputStateRevision": output_state.revision,
                "inputArtifacts": trace_inputs,
                "status": "succeeded",
                "startedAt": started_at,
                "finishedAt": finished_at,
                "durationMs": int((time.perf_counter() - started) * 1000),
                "observations": dict(result.observations),
            }
        )
        return {
            "state": output_state,
            "artifacts": artifacts,
            "observations": dict(result.observations),
        }

    async def record(self, name: str, value: Any) -> None:
        self._ensure_open()
        leases: list[ResourceLease] = []

        def release_leases() -> None:
            for lease in reversed(leases):
                try:
                    self._resources.release(lease)
                except Exception:
                    pass
            leases.clear()

        hold = RecordResourceHold(release_leases)
        try:
            materialized = self._materialize_for_record(value, leases)
            await self._run.record(name, materialized, resource_hold=hold)
        except BaseException:
            if not hold.handed_off:
                hold.release()
            raise

    def release(self, value: Any) -> None:
        self._ensure_open()
        handles: list[ArtifactHandle] = []

        def collect(item: Any) -> None:
            if isinstance(item, ArtifactHandle):
                if not self._artifacts.is_live(item):
                    raise CaeError("invalid_release", "sim.release received a released or foreign artifact")
                handles.append(item)
            elif isinstance(item, Mapping):
                for child in item.values():
                    collect(child)
            elif isinstance(item, (list, tuple)):
                for child in item:
                    collect(child)
            else:
                raise CaeError("invalid_release", "sim.release accepts artifact handles returned by sim.run")

        collect(value)
        if not handles:
            raise CaeError("invalid_release", "sim.release found no artifact handles")
        seen: set[str] = set()
        for handle in handles:
            if handle.artifact_id not in seen:
                self._artifacts.release(handle)
                seen.add(handle.artifact_id)

    def state_revision(self, value: Any) -> int:
        if value is None:
            return 0
        try:
            return self._base_state(value).revision
        except ResourceScopeError as exc:
            raise CaeError(
                "invalid_state",
                "simulation state must be None or a live state returned by this sim.run",
            ) from exc

    def close(self) -> None:
        if self._closed:
            return
        self._artifacts.close()
        self._states.close()
        self._resources.close()
        self._buffers.close()
        self._geometry_cache.cleanup()
        self._closed = True

    def _base_state(self, value: Any) -> StateHandle:
        if value is None:
            return self._states.empty
        if not isinstance(value, StateHandle):
            raise CaeError(
                "invalid_state",
                "sim.run state must be None or a state root returned by this sim.run",
            )
        try:
            self._states.view(value)
        except ResourceScopeError as exc:
            raise CaeError("invalid_state", "sim.run state belongs to another Measurement run") from exc
        return value

    def _validate_inputs(
        self,
        task_spec: TaskSpec,
        inputs: Mapping[str, Any],
        leases: list[ResourceLease],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        task_name = task_spec.name
        ports = task_spec.descriptor["inputPorts"]
        unknown = next((name for name in inputs if name not in ports), None)
        if unknown is not None:
            raise CaeError("invalid_input", f"task {task_name} input port {unknown!r} is not declared")
        trace: dict[str, Any] = {}
        invocation_inputs: dict[str, Any] = {}
        for port_name, port in ports.items():
            if port_name not in inputs:
                if port["minimumOccurrences"] > 0:
                    raise CaeError("invalid_input", f"task {task_name} input port {port_name!r} is required")
                continue
            raw = inputs[port_name]
            candidates = raw if isinstance(raw, list) else [raw]
            if not port["minimumOccurrences"] <= len(candidates) <= port["maximumOccurrences"]:
                raise CaeError(
                    "invalid_input",
                    f"task {task_name} input port {port_name!r} requires "
                    f"{port['minimumOccurrences']}..{port['maximumOccurrences']} artifacts",
                )
            typed: list[InputArtifact] = []
            for candidate in candidates:
                if not isinstance(candidate, ArtifactHandle) or not self._artifacts.is_live(candidate):
                    raise CaeError(
                        "invalid_input",
                        f"task {task_name} input port {port_name!r} accepts only a live artifact "
                        "returned by this sim.run",
                    )
                try:
                    self._artifacts.validate(candidate, port["artifactTypes"])
                except TypeError as exc:
                    raise CaeError(
                        "invalid_input",
                        f"task {task_name} input port {port_name!r} rejects artifact type "
                        f"{candidate.artifact_type!r}",
                    ) from exc
                provenance = candidate.provenance
                leases.append(self._resources.acquire(candidate.resource_ref, owner=f"invocation:{task_name}"))
                materialized = self._artifacts.materialize(candidate, copy_arrays=False)
                if task_spec.abi_version >= 2:
                    contract = port.get("data")
                    if isinstance(contract, Mapping):
                        payload_kind = port.get("payloadKind") or task_spec.artifact_payload_kinds.get(provenance.artifact_type)
                        try:
                            validate_artifact_payload(
                                materialized,
                                contract,
                                f"task {task_name} input port {port_name!r}",
                                require_spatial_field=payload_kind == "field",
                            )
                        except (TypeError, ValueError) as exc:
                            raise CaeError("invalid_input", str(exc)) from exc
                typed.append(
                    InputArtifact(
                        artifact_id=candidate.artifact_id,
                        artifact_type=provenance.artifact_type,
                        producer_task=provenance.producer_task,
                        solver_name=provenance.solver_name,
                        solver_version=provenance.solver_version,
                        output_name=provenance.output_name,
                        state_revision=provenance.state_revision,
                        data=provenance.data,
                        value=materialized,
                    )
                )
            trace_values = [
                {"id": item.artifact_id, "artifactType": item.artifact_type}
                for item in typed
            ]
            trace[port_name] = trace_values if isinstance(raw, list) else trace_values[0]
            invocation_inputs[port_name] = tuple(typed) if isinstance(raw, list) else typed[0]
        return trace, invocation_inputs

    def _materialize_for_record(self, value: Any, leases: list[ResourceLease]) -> Any:
        if isinstance(value, ArtifactHandle):
            if not self._artifacts.is_live(value):
                raise CaeError("invalid_record", "RecordedData references a released or foreign artifact")
            leases.append(self._resources.acquire(value.resource_ref, owner=f"record:{self._run.run_id}"))
            materialized = self._artifacts.materialize(value, copy_arrays=False)
            if isinstance(materialized, Field):
                domain = self._resources.resolve(materialized.domain_ref)
                if isinstance(domain, StructuredGrid):
                    return {
                        "value": materialized.values,
                        "axes": [{"ticks": axis} for axis in domain.axes],
                    }
                if isinstance(domain, Mapping) and domain.get("axes") is not None:
                    return {"value": materialized.values, "axes": domain["axes"]}
                return materialized.values
            if isinstance(materialized, StructuredBundle):
                return materialized.members
            if isinstance(materialized, Mapping) and "value" in materialized:
                axes = materialized.get("axes")
                domain = materialized.get("domainRef")
                if axes is None and isinstance(domain, Mapping):
                    axes = domain.get("axes")
                if axes is not None:
                    return {"value": materialized["value"], "axes": axes}
                return materialized["value"]
            return materialized
        if isinstance(value, Mapping):
            return {name: self._materialize_for_record(item, leases) for name, item in value.items()}
        if isinstance(value, tuple):
            return tuple(self._materialize_for_record(item, leases) for item in value)
        if isinstance(value, list):
            return [self._materialize_for_record(item, leases) for item in value]
        return value

    def _ensure_open(self) -> None:
        if self._closed:
            raise CaeError("run_closed", "simulation run is closed")
