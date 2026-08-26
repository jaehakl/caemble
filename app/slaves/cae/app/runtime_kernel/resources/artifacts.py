from __future__ import annotations

import copy
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from app.runtime_kernel.resources.models import (
    ResourceLease,
    ResourceLeaseError,
    ResourceRef,
    ResourceScopeError,
)
from app.runtime_kernel.resources.store import ResourceStore


@dataclass(frozen=True, slots=True)
class ArtifactProvenance:
    producer_task: str
    solver_name: str
    solver_version: str
    output_name: str
    artifact_type: str
    state_revision: int
    data: Mapping[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class ArtifactHandle:
    artifact_store_id: str
    artifact_id: str
    resource_ref: ResourceRef
    provenance: ArtifactProvenance

    @property
    def artifact_type(self) -> str:
        return self.provenance.artifact_type

    @property
    def produced_state_revision(self) -> int:
        return self.provenance.state_revision


@dataclass(frozen=True, slots=True)
class _ArtifactRecord:
    handle: ArtifactHandle
    lease: ResourceLease


class ArtifactStore:
    """Run-scoped typed exports backed by ResourceStore leases."""

    def __init__(
        self,
        resources: ResourceStore | None = None,
        *,
        artifact_store_id: str | None = None,
    ) -> None:
        self.resources = resources or ResourceStore()
        self.artifact_store_id = artifact_store_id or f"artifacts-{uuid.uuid4()}"
        self._owns_resources = resources is None
        self._records: dict[str, _ArtifactRecord] = {}
        self._closed = False

    def publish(
        self,
        value: Any,
        *,
        producer_task: str,
        solver_name: str,
        solver_version: str,
        output_name: str,
        artifact_type: str,
        state_revision: int,
        data: Mapping[str, Any] | None = None,
        copy_arrays: bool = True,
    ) -> ArtifactHandle:
        self._ensure_open()
        owns_ref = not isinstance(value, ResourceRef)
        ref = value if not owns_ref else self.resources.ingest(value, copy_arrays=copy_arrays)
        try:
            artifact_id = f"artifact-{uuid.uuid4()}"
            provenance = ArtifactProvenance(
                producer_task=producer_task,
                solver_name=solver_name,
                solver_version=solver_version,
                output_name=output_name,
                artifact_type=artifact_type,
                state_revision=state_revision,
                data=copy.deepcopy(data),
            )
            handle = ArtifactHandle(self.artifact_store_id, artifact_id, ref, provenance)
            lease = self.resources.acquire(
                ref,
                owner=f"{self.artifact_store_id}:{artifact_id}",
            )
            self._records[artifact_id] = _ArtifactRecord(handle, lease)
            return handle
        except BaseException:
            if owns_ref and self.resources.contains(ref):
                self.resources.discard(ref)
            raise

    def resolve(self, handle: ArtifactHandle) -> Any:
        return self.resources.resolve(self._record(handle).handle.resource_ref)

    def materialize(
        self,
        handle: ArtifactHandle,
        *,
        copy_arrays: bool = False,
    ) -> Any:
        record = self._record(handle)
        return self.resources.materialize(
            record.handle.resource_ref,
            mutable=True,
            copy_arrays=copy_arrays,
        )

    def validate(
        self,
        handle: ArtifactHandle,
        accepted_types: Iterable[str],
    ) -> ArtifactHandle:
        record = self._record(handle)
        if record.handle.artifact_type not in frozenset(accepted_types):
            raise TypeError(
                f"artifact type {record.handle.artifact_type!r} is not accepted"
            )
        return record.handle

    def release(self, handle: ArtifactHandle) -> None:
        record = self._record(handle)
        del self._records[handle.artifact_id]
        self.resources.release(record.lease)

    def is_live(self, handle: ArtifactHandle) -> bool:
        if self._closed or handle.artifact_store_id != self.artifact_store_id:
            return False
        record = self._records.get(handle.artifact_id)
        return record is not None and record.handle == handle

    def handles(self) -> tuple[ArtifactHandle, ...]:
        self._ensure_open()
        return tuple(record.handle for record in self._records.values())

    def close(self) -> None:
        if self._closed:
            return
        for record in tuple(self._records.values()):
            try:
                self.resources.release(record.lease)
            except ResourceLeaseError:
                pass
        self._records.clear()
        self._closed = True
        if self._owns_resources:
            self.resources.close()

    def _record(self, handle: ArtifactHandle) -> _ArtifactRecord:
        self._ensure_open()
        if (
            not isinstance(handle, ArtifactHandle)
            or handle.artifact_store_id != self.artifact_store_id
        ):
            raise ResourceScopeError("artifact belongs to another run")
        record = self._records.get(handle.artifact_id)
        if record is None or record.handle != handle:
            raise ResourceLeaseError("artifact is not live")
        return record

    def _ensure_open(self) -> None:
        if self._closed:
            raise ResourceLeaseError("artifact store is closed")
