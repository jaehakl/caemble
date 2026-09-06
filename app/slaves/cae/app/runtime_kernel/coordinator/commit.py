from __future__ import annotations

import numbers
from collections.abc import Mapping

from app.errors import CaeError
from app.runtime_kernel.api import SolverResult, StateDelete, StatePatch, StatePut
from app.runtime_kernel.coordinator.contracts import validate_artifact_payload
from app.runtime_kernel.coordinator.plan import TaskSpec, detached
from app.runtime_kernel.execution import SolverExecutionTransaction
from app.runtime_kernel.resources import ArtifactHandle, ArtifactStore, ResourceStore, StateHandle, StateStore


def commit_result(
    transaction: SolverExecutionTransaction[SolverResult],
    task_spec: TaskSpec,
    base_state: StateHandle,
    *,
    resources: ResourceStore,
    states: StateStore,
    artifacts: ArtifactStore,
) -> tuple[StateHandle, dict[str, ArtifactHandle]]:
    """Validate and publish one child result, or undo every provisional owner."""
    result = transaction.value
    task_name = task_spec.name
    kernel = task_spec.task["kernel"]
    roots = ()
    handles: dict[str, ArtifactHandle] = {}
    output_state = base_state
    try:
        if not isinstance(result, SolverResult):
            raise TypeError("solver result does not implement ABI-v2 SolverResult")
        if not isinstance(result.state_patch, StatePatch):
            raise TypeError("solver state_patch must be a StatePatch")
        if not isinstance(result.artifacts, Mapping) or not isinstance(result.observations, Mapping):
            raise TypeError("solver artifacts and observations must be mappings")
        observation_specs = task_spec.descriptor.get("observations", {})
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
        output_specs = task_spec.output_specs
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
                if task_spec.abi_version >= 2:
                    payload_kind = spec.get("payloadKind") or task_spec.artifact_payload_kinds.get(spec["artifactType"])
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
        roots = resources.ingest_many(
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
        output_state = states.commit(base_state, StatePatch(operations), copy_arrays=False, producer_task=task_name)
        artifact_refs = roots[len(patch_values) :]
        for output_name, ref in zip(artifact_names, artifact_refs, strict=True):
            spec = output_specs[output_name]
            handles[output_name] = artifacts.publish(
                ref,
                producer_task=task_name,
                solver_name=str(kernel["name"]),
                solver_version=str(kernel["version"]),
                output_name=output_name,
                artifact_type=spec["artifactType"],
                state_revision=output_state.revision,
                data=detached(spec.get("data")),
                copy_arrays=False,
            )
        if not transaction.commit():
            raise RuntimeError("solver execution transaction was already finalized")
        return output_state, handles
    except BaseException as error:
        # Continue recovery even if one cleanup operation itself fails.
        for handle in reversed(tuple(handles.values())):
            try:
                if artifacts.is_live(handle):
                    artifacts.release(handle)
            except Exception as cleanup_error:
                error.add_note(f"artifact rollback also failed: {cleanup_error}")
        try:
            if output_state is not base_state:
                states.rollback(output_state)
        except Exception as cleanup_error:
            error.add_note(f"state rollback also failed: {cleanup_error}")
        for ref in roots:
            try:
                if resources.contains(ref):
                    resources.discard(ref)
            except Exception as cleanup_error:
                error.add_note(f"resource rollback also failed: {cleanup_error}")
        try:
            transaction.rollback()
        except Exception as cleanup_error:
            error.add_note(f"solver mmap rollback also failed: {cleanup_error}")
        raise
