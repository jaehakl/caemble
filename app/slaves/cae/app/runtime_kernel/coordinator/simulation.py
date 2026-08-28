from __future__ import annotations

import asyncio
import copy
import numbers
import tempfile
import time
from collections.abc import Mapping
from typing import Any

from app.errors import CaeError
from app.runtime_kernel.catalog import solver_catalog
from app.runtime_kernel.coordinator.contracts import validate_artifact_payload
from app.runtime_kernel.coordinator.kernels import run_kernel_transaction
from app.runtime_kernel.api import InputArtifact, SolverResourceServices, SolverResult
from app.runtime_kernel.execution import MmapPayloadCodec, SpawnSolverExecutor
from app.runtime_kernel.resources import (
    ArtifactHandle,
    ArtifactStore,
    BufferStore,
    Field,
    ResourceLease,
    ResourceRef,
    ResourceScopeError,
    ResourceStore,
    StateDelete,
    StateHandle,
    StatePatch,
    StatePut,
    StateStore,
    StructuredBundle,
    StructuredGrid,
)
from app.runtime_kernel.transport import RecordResourceHold


class SimulationApi:
    """Resident, run-scoped coordinator exposed to trusted ``simulate.py``."""

    def __init__(self, run: Any) -> None:
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
        normalized_task = copy.deepcopy(normalized_task)
        kernel = normalized_task["kernel"]
        base_state = self._base_state(options.get("state"))
        descriptor = self._run._task_descriptors[task_name]
        trace_inputs, invocation_inputs = self._validate_inputs(
            task_name,
            descriptor,
            raw_inputs,
        )
        world = {
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

        try:
            transaction = await run_kernel_transaction(
                normalized_task,
                base_state.to_mutable(),
                invocation_inputs,
                world,
                report,
                task_name=task_name,
                timeout=float(self._run.max_run_seconds),
                executor=self._executor,
                resources=SolverResourceServices(
                    geometry_cache_path=self._geometry_cache.name,
                ),
            )
            try:
                result = transaction.value
                output_state, artifacts = self._commit_result(task_name, kernel, base_state, result)
                try:
                    if not transaction.commit():
                        raise RuntimeError("solver execution transaction was already finalized")
                except BaseException:
                    for handle in artifacts.values():
                        if self._artifacts.is_live(handle):
                            self._artifacts.release(handle)
                    if output_state is not base_state:
                        self._states.rollback(output_state)
                    raise
            except BaseException:
                transaction.rollback()
                raise
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
        task_name: str,
        descriptor: Mapping[str, Any],
        inputs: Mapping[str, Any],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        ports = descriptor["inputPorts"]
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
                materialized = self._artifacts.materialize(candidate)
                if self._run._task_abi_versions[task_name] >= 2:
                    contract = port.get("data")
                    if isinstance(contract, Mapping):
                        payload_kind = port.get("payloadKind")
                        if payload_kind is None:
                            payload_kind = solver_catalog.artifact_type(
                                provenance.artifact_type
                            ).get("payloadKind")
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

    def _commit_result(
        self,
        task_name: str,
        kernel: Mapping[str, Any],
        base_state: StateHandle,
        result: SolverResult,
    ) -> tuple[StateHandle, dict[str, ArtifactHandle]]:
        if not isinstance(result, SolverResult):
            raise TypeError("solver result does not implement ABI-v2 SolverResult")
        if not isinstance(result.state_patch, StatePatch):
            raise TypeError("solver state_patch must be a StatePatch")
        if not isinstance(result.artifacts, Mapping) or not isinstance(result.observations, Mapping):
            raise TypeError("solver artifacts and observations must be mappings")
        observation_specs = self._run._task_descriptors[task_name].get("observations", {})
        unknown_observations = sorted(set(result.observations) - set(observation_specs))
        if unknown_observations:
            raise CaeError(
                "invalid_solver_result",
                f"task {task_name} returned unknown observations {unknown_observations!r}",
            )
        observation_types = {
            "number": lambda value: isinstance(value, numbers.Real) and not isinstance(value, bool),
            "string": lambda value: isinstance(value, str),
            "boolean": lambda value: isinstance(value, bool),
        }
        for name, value in result.observations.items():
            expected = observation_specs[name]["type"]
            if expected not in observation_types or not observation_types[expected](value):
                raise CaeError(
                    "invalid_solver_result",
                    f"task {task_name} observation {name!r} must be {expected}",
                )
        output_specs = self._run._output_specs[task_name]
        missing = sorted(set(output_specs) - set(result.artifacts))
        unknown = sorted(set(result.artifacts) - set(output_specs))
        if missing or unknown:
            details = []
            if missing:
                details.append(f"missing {missing!r}")
            if unknown:
                details.append(f"unknown {unknown!r}")
            raise CaeError(
                "invalid_solver_result",
                f"task {task_name} returned incorrect artifacts: {', '.join(details)}",
            )
        for output_name, spec in output_specs.items():
            if not isinstance(spec.get("artifactType"), str) or not spec["artifactType"]:
                raise CaeError(
                    "invalid_solver_result",
                    f"task {task_name} output {output_name!r} has no canonical artifact type",
                )
            data = spec.get("data")
            if not isinstance(data, Mapping):
                raise CaeError(
                    "invalid_solver_result",
                    f"task {task_name} output {output_name!r} has no artifact data contract",
                )
            try:
                payload_kind = None
                if self._run._task_abi_versions[task_name] >= 2:
                    payload_kind = spec.get("payloadKind")
                    if payload_kind is None:
                        payload_kind = solver_catalog.artifact_type(
                            spec["artifactType"]
                        ).get("payloadKind")
                validate_artifact_payload(
                    result.artifacts[output_name],
                    data,
                    f"task {task_name} output {output_name!r}",
                    require_spatial_field=payload_kind == "field",
                )
            except (TypeError, ValueError) as exc:
                raise CaeError("invalid_solver_result", str(exc)) from exc

        patch_values = [
            operation.value
            for operation in result.state_patch.operations
            if isinstance(operation, StatePut)
        ]
        artifact_names = list(result.artifacts)
        roots = self._resources.ingest_many(
            (*patch_values, *(result.artifacts[name] for name in artifact_names)),
            copy_arrays=False,
        )
        patch_refs = iter(roots[: len(patch_values)])
        operations = tuple(
            StatePut(operation.path, next(patch_refs))
            if isinstance(operation, StatePut)
            else StateDelete(operation.path)
            for operation in result.state_patch.operations
        )
        handles: dict[str, ArtifactHandle] = {}
        output_state = base_state
        try:
            output_state = self._states.commit(base_state, StatePatch(operations), copy_arrays=False)
            artifact_refs = roots[len(patch_values) :]
            for output_name, ref in zip(artifact_names, artifact_refs, strict=True):
                spec = output_specs[output_name]
                handles[output_name] = self._artifacts.publish(
                    ref,
                    producer_task=task_name,
                    solver_name=str(kernel["name"]),
                    solver_version=str(kernel["version"]),
                    output_name=output_name,
                    artifact_type=spec["artifactType"],
                    state_revision=output_state.revision,
                    data=spec.get("data"),
                    copy_arrays=False,
                )
            return output_state, handles
        except BaseException:
            for handle in handles.values():
                if self._artifacts.is_live(handle):
                    self._artifacts.release(handle)
            if output_state is not base_state:
                self._states.rollback(output_state)
            for ref in roots:
                if self._resources.contains(ref):
                    self._resources.discard(ref)
            raise

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
