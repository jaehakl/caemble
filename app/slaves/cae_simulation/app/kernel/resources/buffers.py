from __future__ import annotations

import os
import tempfile
import threading
import uuid
import weakref
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, ClassVar

import numpy as np


class BufferStoreError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class MmapArrayDescriptor:
    store_id: str
    transaction_id: str
    buffer_id: str
    dtype: Any
    shape: tuple[int, ...]
    readonly: bool
    fortran_order: bool


@dataclass(frozen=True, slots=True)
class BufferLease:
    store_id: str
    lease_id: str
    buffer_id: str
    owner: str | None = None


@dataclass(slots=True)
class _BufferRecord:
    descriptor: MmapArrayDescriptor
    transaction_ids: set[str] = field(default_factory=set)
    lease_ids: set[str] = field(default_factory=set)
    mapping_ids: set[str] = field(default_factory=set)


@dataclass(slots=True)
class _OpenMapping:
    buffer_id: str
    mmap: Any
    finalizer: weakref.finalize


class BufferStore:
    """Run-scoped owner of leased, file-backed NumPy transport buffers."""

    _registry: ClassVar[weakref.WeakValueDictionary[tuple[int, str], BufferStore]] = (
        weakref.WeakValueDictionary()
    )
    _registry_lock: ClassVar[threading.RLock] = threading.RLock()

    def __init__(self, root: Path | None = None, *, store_id: str | None = None) -> None:
        if root is None:
            root = Path(tempfile.mkdtemp(prefix="caemble-cae-buffers-"))
        else:
            root = Path(root).resolve()
            root.mkdir(parents=True, exist_ok=False)
        self.root = root.resolve()
        self.store_id = store_id or f"buffers-{uuid.uuid4()}"
        self._owner_pid = os.getpid()
        self._transactions: dict[str, set[str]] = {}
        self._buffers: dict[str, _BufferRecord] = {}
        self._leases: dict[str, BufferLease] = {}
        self._mappings: dict[str, _OpenMapping] = {}
        self._closed = False
        self._lock = threading.RLock()
        self._register()

    def begin(self) -> str:
        with self._lock:
            self._ensure_open()
            transaction_id = f"invocation-{uuid.uuid4()}"
            self._transactions[transaction_id] = set()
            return transaction_id

    def publish(
        self,
        array: np.ndarray[Any, Any],
        transaction_id: str,
    ) -> MmapArrayDescriptor:
        with self._lock:
            self._validate_transaction(transaction_id)
            if array.dtype.hasobject:
                raise BufferStoreError("object arrays cannot use mmap transport")
            if array.size == 0:
                raise BufferStoreError("empty arrays cannot use mmap transport")

            buffer_id = f"{transaction_id}-{uuid.uuid4()}"
            final_path = self._buffer_path(buffer_id)
            partial_path = final_path.with_suffix(".partial")
            fortran_order = bool(array.flags.f_contiguous and not array.flags.c_contiguous)
            writer: np.memmap[Any, Any] | None = None
            try:
                writer = np.lib.format.open_memmap(
                    partial_path,
                    mode="w+",
                    dtype=array.dtype,
                    shape=array.shape,
                    fortran_order=fortran_order,
                )
                writer[...] = array
                writer.flush()
            finally:
                if writer is not None:
                    writer._mmap.close()
            os.replace(partial_path, final_path)
            descriptor = MmapArrayDescriptor(
                self.store_id,
                transaction_id,
                buffer_id,
                np.lib.format.dtype_to_descr(array.dtype),
                tuple(array.shape),
                not array.flags.writeable,
                fortran_order,
            )
            self._buffers[buffer_id] = _BufferRecord(
                descriptor,
                transaction_ids={transaction_id},
            )
            self._transactions[transaction_id].add(buffer_id)
            return descriptor

    def retain(
        self,
        descriptor: MmapArrayDescriptor,
        transaction_id: str,
    ) -> None:
        """Temporarily retain an existing buffer for an invocation transaction."""
        with self._lock:
            self._validate_transaction(transaction_id)
            record = self._record(descriptor)
            record.transaction_ids.add(transaction_id)
            self._transactions[transaction_id].add(descriptor.buffer_id)

    def descriptor_for(self, array: Any) -> MmapArrayDescriptor | None:
        """Return this store's descriptor for an array opened by this store."""
        with self._lock:
            self._ensure_open()
            descriptor = self._array_descriptor(array)
            if descriptor is None or descriptor.store_id != self.store_id:
                return None
            # Writable mappings use copy-on-write mode. Reusing their descriptor
            # after a child mutation would silently point at the unmodified file.
            if array.flags.writeable:
                return None
            if not self._matches_descriptor_storage(array, descriptor):
                return None
            if not descriptor.readonly:
                descriptor = replace(descriptor, readonly=True)
            self._record(descriptor)
            return descriptor

    def open(
        self,
        descriptor: MmapArrayDescriptor,
        *,
        transaction_id: str | None = None,
    ) -> np.memmap[Any, Any]:
        with self._lock:
            self._ensure_open()
            if transaction_id is not None:
                self.retain(descriptor, transaction_id)
            else:
                self._record(descriptor)
            path = self._buffer_path(descriptor.buffer_id)
            mode = "r" if descriptor.readonly else "c"
            array = np.load(path, mmap_mode=mode, allow_pickle=False)
            expected_dtype = np.dtype(descriptor.dtype)
            if array.dtype != expected_dtype or tuple(array.shape) != descriptor.shape:
                array._mmap.close()
                raise BufferStoreError("mmap buffer metadata does not match its descriptor")
            if bool(array.flags.f_contiguous and not array.flags.c_contiguous) != (
                descriptor.fortran_order
            ):
                array._mmap.close()
                raise BufferStoreError("mmap buffer order does not match its descriptor")
            if descriptor.readonly:
                array.flags.writeable = False

            mapping_id = f"mapping-{uuid.uuid4()}"
            mmap = array._mmap
            finalizer = weakref.finalize(
                array,
                BufferStore._finalize_mapping,
                weakref.ref(self),
                mapping_id,
                mmap,
            )
            self._mappings[mapping_id] = _OpenMapping(
                descriptor.buffer_id,
                mmap,
                finalizer,
            )
            self._buffers[descriptor.buffer_id].mapping_ids.add(mapping_id)
            array._caemble_buffer_descriptor = descriptor
            return array

    @classmethod
    def acquire_array_lease(
        cls,
        array: Any,
        *,
        owner: str | None = None,
    ) -> BufferLease | None:
        """Acquire a resource lease when ``array`` belongs to a live BufferStore.

        Plain NumPy arrays return ``None`` so ResourceStore can use this hook for
        every TensorResource without special-casing its storage implementation.
        """
        descriptor = cls._array_descriptor(array)
        if descriptor is None:
            return None
        store = cls._registered_store(descriptor.store_id)
        if store is None:
            raise BufferStoreError("the mmap array's buffer store is not live")
        return store._acquire(descriptor, owner)

    @classmethod
    def release_array_lease(cls, lease: BufferLease) -> None:
        """Release a lease returned by :meth:`acquire_array_lease`."""
        if not isinstance(lease, BufferLease):
            raise TypeError("buffer lease must be a BufferLease")
        store = cls._registered_store(lease.store_id)
        if store is None:
            raise BufferStoreError("the buffer lease's store is not live")
        store._release(lease)

    def commit(self, transaction_id: str) -> None:
        with self._lock:
            self._validate_transaction(transaction_id)
            buffer_ids = self._transactions.pop(transaction_id)
            for buffer_id in buffer_ids:
                record = self._buffers.get(buffer_id)
                if record is not None:
                    record.transaction_ids.discard(transaction_id)
                    self._collect_if_unused(buffer_id)
            self._remove_unregistered_transaction_files(transaction_id)

    def rollback(self, transaction_id: str) -> None:
        with self._lock:
            self._ensure_open()
            buffer_ids = self._transactions.pop(transaction_id, None)
            if buffer_ids is None:
                return
            for buffer_id in buffer_ids:
                record = self._buffers.get(buffer_id)
                if record is None:
                    continue
                record.transaction_ids.discard(transaction_id)
                if record.descriptor.transaction_id == transaction_id:
                    self._force_remove(buffer_id)
                else:
                    self._collect_if_unused(buffer_id)
            self._remove_unregistered_transaction_files(transaction_id)

    def files(self) -> tuple[Path, ...]:
        with self._lock:
            self._ensure_open()
            return tuple(sorted(path for path in self.root.iterdir() if path.is_file()))

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            for buffer_id in tuple(self._buffers):
                self._force_remove(buffer_id)
            self._transactions.clear()
            self._leases.clear()
            self._close_unregistered_mappings()
            if os.getpid() == self._owner_pid:
                root = self.root.resolve()
                for path in root.iterdir():
                    resolved = path.resolve()
                    if resolved.parent != root or not resolved.is_file():
                        raise BufferStoreError("buffer store contains an unexpected path")
                    resolved.unlink()
                root.rmdir()
            self._closed = True
            self._unregister()

    def __enter__(self) -> BufferStore:
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        del exc_type, exc, traceback
        self.close()

    def __getstate__(self) -> dict[str, Any]:
        with self._lock:
            self._ensure_open()
            return {
                "root": self.root,
                "store_id": self.store_id,
                "owner_pid": self._owner_pid,
                "transactions": tuple(self._transactions),
            }

    def __setstate__(self, state: dict[str, Any]) -> None:
        self.root = state["root"]
        self.store_id = state["store_id"]
        self._owner_pid = state["owner_pid"]
        self._transactions = {
            transaction_id: set() for transaction_id in state["transactions"]
        }
        self._buffers = {}
        self._leases = {}
        self._mappings = {}
        self._closed = False
        self._lock = threading.RLock()
        self._register()

    def _acquire(
        self,
        descriptor: MmapArrayDescriptor,
        owner: str | None,
    ) -> BufferLease:
        with self._lock:
            self._ensure_open()
            record = self._record(descriptor)
            lease = BufferLease(
                self.store_id,
                f"buffer-lease-{uuid.uuid4()}",
                descriptor.buffer_id,
                owner,
            )
            self._leases[lease.lease_id] = lease
            record.lease_ids.add(lease.lease_id)
            return lease

    def _release(self, lease: BufferLease) -> None:
        with self._lock:
            self._ensure_open()
            registered = self._leases.get(lease.lease_id)
            if registered != lease:
                raise BufferStoreError("buffer lease is not live")
            del self._leases[lease.lease_id]
            record = self._buffers.get(lease.buffer_id)
            if record is not None:
                record.lease_ids.discard(lease.lease_id)
                self._collect_if_unused(lease.buffer_id)

    def _record(self, descriptor: MmapArrayDescriptor) -> _BufferRecord:
        if not isinstance(descriptor, MmapArrayDescriptor):
            raise TypeError("mmap descriptor must be an MmapArrayDescriptor")
        if descriptor.store_id != self.store_id:
            raise BufferStoreError("mmap descriptor belongs to another buffer store")
        path = self._buffer_path(descriptor.buffer_id)
        if not path.is_file():
            raise BufferStoreError(f"mmap buffer {descriptor.buffer_id!r} does not exist")
        record = self._buffers.get(descriptor.buffer_id)
        if record is None:
            record = _BufferRecord(descriptor)
            self._buffers[descriptor.buffer_id] = record
        elif not self._same_backing_buffer(record.descriptor, descriptor):
            raise BufferStoreError("mmap descriptor conflicts with the registered buffer")
        return record

    def _collect_if_unused(self, buffer_id: str) -> None:
        record = self._buffers.get(buffer_id)
        if record is None or (
            record.transaction_ids or record.lease_ids or record.mapping_ids
        ):
            return
        self._buffers.pop(buffer_id)
        self._unlink_buffer(buffer_id)

    def _force_remove(self, buffer_id: str) -> None:
        record = self._buffers.pop(buffer_id, None)
        if record is None:
            return
        for transaction_id in tuple(record.transaction_ids):
            transaction = self._transactions.get(transaction_id)
            if transaction is not None:
                transaction.discard(buffer_id)
        for lease_id in tuple(record.lease_ids):
            self._leases.pop(lease_id, None)
        for mapping_id in tuple(record.mapping_ids):
            mapping = self._mappings.pop(mapping_id, None)
            if mapping is not None:
                mapping.finalizer.detach()
                if not mapping.mmap.closed:
                    mapping.mmap.close()
        self._unlink_buffer(buffer_id)

    @staticmethod
    def _finalize_mapping(
        store_ref: weakref.ReferenceType[BufferStore],
        mapping_id: str,
        mmap: Any,
    ) -> None:
        store = store_ref()
        if store is None:
            if not mmap.closed:
                mmap.close()
            return
        store._release_mapping(mapping_id, mmap)

    def _release_mapping(self, mapping_id: str, mmap: Any) -> None:
        with self._lock:
            mapping = self._mappings.pop(mapping_id, None)
            if not mmap.closed:
                mmap.close()
            if mapping is None:
                return
            record = self._buffers.get(mapping.buffer_id)
            if record is not None:
                record.mapping_ids.discard(mapping_id)
                if not self._closed:
                    self._collect_if_unused(mapping.buffer_id)

    def _close_unregistered_mappings(self) -> None:
        for mapping in self._mappings.values():
            mapping.finalizer.detach()
            if not mapping.mmap.closed:
                mapping.mmap.close()
        self._mappings.clear()

    def _unlink_buffer(self, buffer_id: str) -> None:
        if os.getpid() != self._owner_pid:
            return
        path = self._buffer_path(buffer_id)
        if path.is_file():
            path.unlink()

    def _remove_unregistered_transaction_files(self, transaction_id: str) -> None:
        if os.getpid() != self._owner_pid:
            return
        prefix = f"{transaction_id}-"
        root = self.root.resolve()
        for path in root.iterdir():
            resolved = path.resolve()
            if resolved.parent != root or not path.name.startswith(prefix):
                continue
            buffer_id = path.name.removesuffix(".npy")
            if buffer_id not in self._buffers and resolved.is_file():
                resolved.unlink()

    def _buffer_path(self, buffer_id: str) -> Path:
        path = (self.root / f"{buffer_id}.npy").resolve()
        if path.parent != self.root:
            raise BufferStoreError("mmap buffer path escaped the store root")
        return path

    def _validate_transaction(self, transaction_id: str) -> None:
        self._ensure_open()
        if transaction_id not in self._transactions:
            raise BufferStoreError("mmap buffer transaction is not active")

    def _ensure_open(self) -> None:
        if self._closed:
            raise BufferStoreError("buffer store is closed")

    def _register(self) -> None:
        with self._registry_lock:
            self._registry[(os.getpid(), self.store_id)] = self

    def _unregister(self) -> None:
        with self._registry_lock:
            key = (os.getpid(), self.store_id)
            if self._registry.get(key) is self:
                del self._registry[key]

    @classmethod
    def _registered_store(cls, store_id: str) -> BufferStore | None:
        with cls._registry_lock:
            return cls._registry.get((os.getpid(), store_id))

    @staticmethod
    def _array_descriptor(array: Any) -> MmapArrayDescriptor | None:
        candidate = array
        seen: set[int] = set()
        while isinstance(candidate, np.ndarray) and id(candidate) not in seen:
            seen.add(id(candidate))
            descriptor = getattr(candidate, "_caemble_buffer_descriptor", None)
            if isinstance(descriptor, MmapArrayDescriptor):
                return descriptor
            candidate = getattr(candidate, "base", None)
        return None

    @staticmethod
    def _matches_descriptor_storage(
        array: Any,
        descriptor: MmapArrayDescriptor,
    ) -> bool:
        if not isinstance(array, np.ndarray):
            return False
        if array.dtype != np.dtype(descriptor.dtype) or tuple(array.shape) != descriptor.shape:
            return False
        if descriptor.fortran_order:
            if not array.flags.f_contiguous or array.flags.c_contiguous:
                return False
        elif not array.flags.c_contiguous:
            return False

        candidate = array
        seen: set[int] = set()
        while isinstance(candidate, np.ndarray) and id(candidate) not in seen:
            seen.add(id(candidate))
            if getattr(candidate, "_caemble_buffer_descriptor", None) == descriptor:
                return array.__array_interface__["data"][0] == (
                    candidate.__array_interface__["data"][0]
                )
            candidate = getattr(candidate, "base", None)
        return False

    @staticmethod
    def _same_backing_buffer(
        left: MmapArrayDescriptor,
        right: MmapArrayDescriptor,
    ) -> bool:
        return (
            left.store_id == right.store_id
            and left.transaction_id == right.transaction_id
            and left.buffer_id == right.buffer_id
            and np.dtype(left.dtype) == np.dtype(right.dtype)
            and left.shape == right.shape
            and left.fortran_order == right.fortran_order
        )
