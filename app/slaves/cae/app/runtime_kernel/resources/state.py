from __future__ import annotations

import uuid
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Any

from app.runtime_kernel.api.state import StateDelete, StateOperation, StatePatch, StatePath, StatePut
from app.runtime_kernel.resources.models import (
    ResourceError,
    ResourceKind,
    ResourceLease,
    ResourceRef,
    ResourceScopeError,
)
from app.runtime_kernel.resources.store import ResourceStore

@dataclass(frozen=True, slots=True)
class StateRevision:
    revision: int
    parent_revision: int | None
    root: ResourceRef


class StateView(Mapping[Any, Any]):
    __slots__ = ("_resources", "_root_ref")

    def __init__(self, resources: ResourceStore, root_ref: ResourceRef) -> None:
        if resources.kind(root_ref) is not ResourceKind.MAPPING:
            raise TypeError("simulation state root must be a mapping")
        self._resources = resources
        self._root_ref = root_ref

    @property
    def root_ref(self) -> ResourceRef:
        return self._root_ref

    def __getitem__(self, key: Any) -> Any:
        return self._mapping()[key]

    def __iter__(self) -> Iterator[Any]:
        return iter(self._mapping())

    def __len__(self) -> int:
        return len(self._mapping())

    def to_mutable(self, *, copy_arrays: bool = False) -> dict[Any, Any]:
        value = self._resources.materialize(
            self._root_ref,
            mutable=True,
            copy_arrays=copy_arrays,
        )
        if not isinstance(value, dict):
            raise TypeError("simulation state root must be a mapping")
        return value

    def _mapping(self) -> Mapping[Any, Any]:
        value = self._resources.resolve(self._root_ref)
        if not isinstance(value, Mapping):
            raise TypeError("simulation state root must be a mapping")
        return value


class StateHandle(StateView):
    __slots__ = ("_state_store_id", "_revision")

    def __init__(
        self,
        resources: ResourceStore,
        state_store_id: str,
        revision: StateRevision,
    ) -> None:
        super().__init__(resources, revision.root)
        self._state_store_id = state_store_id
        self._revision = revision

    @property
    def state_store_id(self) -> str:
        return self._state_store_id

    @property
    def revision(self) -> int:
        return self._revision.revision

    @property
    def parent_revision(self) -> int | None:
        return self._revision.parent_revision

    @property
    def revision_info(self) -> StateRevision:
        return self._revision


class StateStore:
    """Owns an immutable revision DAG for one Measurement run."""

    def __init__(
        self,
        resources: ResourceStore | None = None,
        *,
        state_store_id: str | None = None,
    ) -> None:
        self.resources = resources or ResourceStore()
        self.state_store_id = state_store_id or f"states-{uuid.uuid4()}"
        self._owns_resources = resources is None
        empty_root = self.resources.ingest({})
        empty_revision = StateRevision(0, None, empty_root)
        self._revisions = {0: empty_revision}
        self._leases: dict[int, ResourceLease] = {
            0: self.resources.acquire(empty_root, owner=f"{self.state_store_id}:revision:0")
        }
        self._sequence = 0
        self._closed = False

    @property
    def empty(self) -> StateHandle:
        return self.handle(0)

    def handle(self, revision: int) -> StateHandle:
        self._ensure_open()
        try:
            info = self._revisions[revision]
        except KeyError as error:
            raise KeyError(f"unknown state revision {revision}") from error
        return StateHandle(self.resources, self.state_store_id, info)

    def view(self, state: StateHandle | int) -> StateView:
        handle = self._base_handle(state)
        return StateView(self.resources, handle.root_ref)

    def revision(self, revision: int) -> StateRevision:
        self._ensure_open()
        try:
            return self._revisions[revision]
        except KeyError as error:
            raise KeyError(f"unknown state revision {revision}") from error

    def revisions(self) -> tuple[StateRevision, ...]:
        self._ensure_open()
        return tuple(self._revisions[index] for index in sorted(self._revisions))

    def commit(
        self,
        base: StateHandle | int | None,
        patch: StatePatch,
        *,
        copy_arrays: bool = True,
    ) -> StateHandle:
        self._ensure_open()
        base_handle = self._base_handle(self.empty if base is None else base)
        if patch.is_empty:
            return base_handle

        current = base_handle.root_ref
        provisional = False
        try:
            for operation in patch.operations:
                if isinstance(operation, StatePut):
                    rewritten = self.resources.put_path(
                        current,
                        operation.path,
                        operation.value,
                        copy_arrays=copy_arrays,
                    )
                else:
                    rewritten = self.resources.delete_path(current, operation.path)
                if provisional and current != rewritten and self.resources.contains(current):
                    self.resources.discard(current)
                current = rewritten
                provisional = current != base_handle.root_ref
            return self._commit_ref(base_handle, current)
        except BaseException:
            if provisional and self.resources.contains(current):
                self.resources.discard(current)
            raise

    def replace(
        self,
        base: StateHandle | int | None,
        value: Mapping[Any, Any],
        *,
        copy_arrays: bool = True,
    ) -> StateHandle:
        return self.commit(base, StatePatch().replace(value), copy_arrays=copy_arrays)

    def commit_ref(
        self,
        base: StateHandle | int | None,
        root: ResourceRef,
    ) -> StateHandle:
        self._ensure_open()
        base_handle = self._base_handle(self.empty if base is None else base)
        return self._commit_ref(base_handle, root)

    def rollback(self, state: StateHandle) -> None:
        """Discard the newest, unexposed revision of a failed run transaction."""
        self._ensure_open()
        handle = self._base_handle(state)
        if handle.revision == 0:
            raise ValueError("the empty state revision cannot be rolled back")
        if handle.revision != self._sequence:
            raise ResourceScopeError("only the newest state revision can be rolled back")
        if any(
            revision.parent_revision == handle.revision
            for revision in self._revisions.values()
        ):
            raise ResourceScopeError("a state revision with descendants cannot be rolled back")

        lease = self._leases.pop(handle.revision)
        del self._revisions[handle.revision]
        self._sequence -= 1
        self.resources.release(lease)

    def close(self) -> None:
        if self._closed:
            return
        for revision in sorted(self._leases, reverse=True):
            lease = self._leases[revision]
            try:
                self.resources.release(lease)
            except ResourceError:
                pass
        self._leases.clear()
        self._revisions.clear()
        self._closed = True
        if self._owns_resources:
            self.resources.close()

    def _commit_ref(self, base: StateHandle, root: ResourceRef) -> StateHandle:
        if self.resources.kind(root) is not ResourceKind.MAPPING:
            if root != base.root_ref and self.resources.contains(root):
                self.resources.discard(root)
            raise TypeError("simulation state root must be a mapping")
        if root == base.root_ref:
            return base
        self._sequence += 1
        info = StateRevision(self._sequence, base.revision, root)
        self._revisions[info.revision] = info
        self._leases[info.revision] = self.resources.acquire(
            root,
            owner=f"{self.state_store_id}:revision:{info.revision}",
        )
        return StateHandle(self.resources, self.state_store_id, info)

    def _base_handle(self, value: StateHandle | int) -> StateHandle:
        if isinstance(value, int):
            return self.handle(value)
        if not isinstance(value, StateHandle) or value.state_store_id != self.state_store_id:
            raise ResourceScopeError("simulation state belongs to another run")
        registered = self._revisions.get(value.revision)
        if registered != value.revision_info:
            raise ResourceScopeError("simulation state revision is not live")
        return value

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("state store is closed")
