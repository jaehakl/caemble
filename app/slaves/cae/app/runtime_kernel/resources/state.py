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
    ResourceLeaseError,
    ResourceRef,
    ResourceScopeError,
)
from app.runtime_kernel.resources.store import ResourceStore


@dataclass(frozen=True, slots=True)
class StateRevision:
    """Small computation lineage retained after its state root is released."""

    revision: int
    parent_revision: int | None
    producer_task: str | None = None


@dataclass(frozen=True, slots=True)
class _LiveStateRoot:
    root: ResourceRef
    lease: ResourceLease


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
            self.root_ref,
            mutable=True,
            copy_arrays=copy_arrays,
        )
        if not isinstance(value, dict):
            raise TypeError("simulation state root must be a mapping")
        return value

    def _mapping(self) -> Mapping[Any, Any]:
        value = self._resources.resolve(self.root_ref)
        if not isinstance(value, Mapping):
            raise TypeError("simulation state root must be a mapping")
        return value


class StateHandle(StateView):
    __slots__ = ("_state_store", "_revision")

    def __init__(
        self,
        state_store: StateStore,
        revision: StateRevision,
        root: ResourceRef,
    ) -> None:
        super().__init__(state_store.resources, root)
        self._state_store = state_store
        self._revision = revision

    @property
    def state_store_id(self) -> str:
        return self._state_store.state_store_id

    @property
    def root_ref(self) -> ResourceRef:
        self._state_store._base_handle(self)
        return self._root_ref

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
    """Owns run-scoped state roots independently of their revision lineage."""

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
        empty_revision = StateRevision(0, None)
        self._revisions = {0: empty_revision}
        self._roots = {
            0: _LiveStateRoot(
                empty_root,
                self.resources.acquire(empty_root, owner=f"{self.state_store_id}:revision:0"),
            )
        }
        self._invocations: dict[str, tuple[int, ResourceLease]] = {}
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
        root = self._roots.get(revision)
        if root is None:
            raise ResourceScopeError("simulation state revision is not live")
        return StateHandle(self, info, root.root)

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

    def is_live(self, state: StateHandle) -> bool:
        if self._closed or not isinstance(state, StateHandle) or state._state_store is not self:
            return False
        root = self._roots.get(state.revision)
        return (
            root is not None
            and root.root == state._root_ref
            and self._revisions.get(state.revision) is state.revision_info
        )

    def check_releasable(self, state: StateHandle | int) -> StateHandle:
        """Validate a public release before a coordinator mutates any handle."""
        handle = self._base_handle(state)
        if handle.revision and any(
            revision == handle.revision for revision, _ in self._invocations.values()
        ):
            raise ResourceScopeError("simulation state is in use by an active invocation")
        return handle

    def release(self, state: StateHandle | int) -> None:
        """Release a live root; keep its lineage and the run's empty root."""
        handle = self.check_releasable(state)
        if handle.revision == 0:
            return
        root = self._roots.pop(handle.revision)
        self.resources.release(root.lease)

    def acquire_invocation(
        self,
        state: StateHandle | int,
        *,
        owner: str | None = None,
    ) -> ResourceLease:
        """Hold a base root and prevent its public release until commit or rollback."""
        handle = self._base_handle(state)
        lease = self.resources.acquire(
            handle.root_ref,
            owner=owner or f"{self.state_store_id}:invocation:{handle.revision}",
        )
        self._invocations[lease.lease_id] = (handle.revision, lease)
        return lease

    def release_invocation(self, lease: ResourceLease) -> None:
        self._ensure_open()
        registered = self._invocations.get(lease.lease_id)
        if registered is None or registered[1] != lease:
            raise ResourceLeaseError("state invocation lease is not live")
        self.resources.release(lease)
        del self._invocations[lease.lease_id]

    def commit(
        self,
        base: StateHandle | int | None,
        patch: StatePatch,
        *,
        copy_arrays: bool = True,
        producer_task: str | None = None,
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
            return self._commit_ref(base_handle, current, producer_task=producer_task)
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
        producer_task: str | None = None,
    ) -> StateHandle:
        return self.commit(
            base,
            StatePatch().replace(value),
            copy_arrays=copy_arrays,
            producer_task=producer_task,
        )

    def commit_ref(
        self,
        base: StateHandle | int | None,
        root: ResourceRef,
        *,
        producer_task: str | None = None,
    ) -> StateHandle:
        self._ensure_open()
        base_handle = self._base_handle(self.empty if base is None else base)
        return self._commit_ref(base_handle, root, producer_task=producer_task)

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

        self.check_releasable(handle)
        root = self._roots.pop(handle.revision)
        del self._revisions[handle.revision]
        self._sequence -= 1
        self.resources.release(root.lease)

    def close(self) -> None:
        if self._closed:
            return
        leases = [lease for _, lease in self._invocations.values()]
        leases.extend(self._roots[revision].lease for revision in sorted(self._roots, reverse=True))
        for lease in leases:
            try:
                self.resources.release(lease)
            except ResourceError:
                pass
        self._invocations.clear()
        self._roots.clear()
        self._revisions.clear()
        self._closed = True
        if self._owns_resources:
            self.resources.close()

    def _commit_ref(
        self,
        base: StateHandle,
        root: ResourceRef,
        *,
        producer_task: str | None,
    ) -> StateHandle:
        if self.resources.kind(root) is not ResourceKind.MAPPING:
            if root != base.root_ref and self.resources.contains(root):
                self.resources.discard(root)
            raise TypeError("simulation state root must be a mapping")
        if root == base.root_ref:
            return base
        revision = self._sequence + 1
        lease = self.resources.acquire(
            root,
            owner=f"{self.state_store_id}:revision:{revision}",
        )
        info = StateRevision(revision, base.revision, producer_task)
        self._revisions[revision] = info
        self._roots[revision] = _LiveStateRoot(root, lease)
        self._sequence = revision
        return StateHandle(self, info, root)

    def _base_handle(self, value: StateHandle | int) -> StateHandle:
        self._ensure_open()
        if isinstance(value, int):
            return self.handle(value)
        if not isinstance(value, StateHandle) or value._state_store is not self:
            raise ResourceScopeError("simulation state belongs to another run")
        if not self.is_live(value):
            raise ResourceScopeError("simulation state revision is not live")
        return value

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("state store is closed")
