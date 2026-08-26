from __future__ import annotations

import io
import pickle
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np

from app.runtime_kernel.resources.buffers import BufferStore, MmapArrayDescriptor


class PayloadCodec(Protocol):
    """Serialization seam for process-bound invocation data.

    A future codec can replace large arrays with mmap descriptors while
    keeping the executor protocol unchanged.
    """

    def encode(self, value: Any) -> Any: ...

    def decode(self, payload: Any) -> Any: ...


@dataclass(frozen=True, slots=True)
class PicklePayloadCodec:
    """Trusted-payload codec used until buffer-backed transport is enabled."""

    protocol: int = pickle.HIGHEST_PROTOCOL

    def encode(self, value: Any) -> bytes:
        return pickle.dumps(value, protocol=self.protocol)

    def decode(self, payload: bytes) -> Any:
        return pickle.loads(payload)


class MmapPayloadCodec:
    """Pickles small values and externalizes large numeric arrays to a BufferStore."""

    def __init__(
        self,
        buffer_store: BufferStore,
        *,
        array_threshold: int = 1024 * 1024,
        transaction_id: str | None = None,
    ) -> None:
        if array_threshold < 0:
            raise ValueError("array_threshold cannot be negative")
        self.buffer_store = buffer_store
        self.array_threshold = array_threshold
        self.transaction_id = transaction_id
        self._finished = False

    def begin_invocation(self) -> MmapPayloadCodec:
        if self.transaction_id is not None:
            raise RuntimeError("an invocation codec cannot start a nested transaction")
        return MmapPayloadCodec(
            self.buffer_store,
            array_threshold=self.array_threshold,
            transaction_id=self.buffer_store.begin(),
        )

    def encode(self, value: Any) -> bytes:
        transaction_id = self._active_transaction()
        stream = io.BytesIO()
        pickler = _MmapPickler(
            stream,
            self.buffer_store,
            transaction_id,
            self.array_threshold,
        )
        pickler.dump(value)
        return stream.getvalue()

    def decode(self, payload: bytes) -> Any:
        transaction_id = self._active_transaction()
        return _MmapUnpickler(
            io.BytesIO(payload),
            self.buffer_store,
            transaction_id,
        ).load()

    def commit(self) -> None:
        transaction_id = self._active_transaction()
        self.buffer_store.commit(transaction_id)
        self._finished = True

    def rollback(self) -> None:
        if self.transaction_id is None or self._finished:
            return
        self.buffer_store.rollback(self.transaction_id)
        self._finished = True

    def close(self) -> None:
        if self.transaction_id is not None:
            self.rollback()
        else:
            self.buffer_store.close()

    def _active_transaction(self) -> str:
        if self.transaction_id is None:
            raise RuntimeError("call begin_invocation() before using an mmap codec")
        if self._finished:
            raise RuntimeError("mmap codec transaction is already finished")
        return self.transaction_id


class _MmapPickler(pickle.Pickler):
    def __init__(
        self,
        stream: io.BytesIO,
        buffer_store: BufferStore,
        transaction_id: str,
        array_threshold: int,
    ) -> None:
        super().__init__(stream, protocol=pickle.HIGHEST_PROTOCOL)
        self._buffer_store = buffer_store
        self._transaction_id = transaction_id
        self._array_threshold = array_threshold
        self._descriptors: dict[int, MmapArrayDescriptor] = {}

    def persistent_id(self, value: Any) -> Any:
        if not isinstance(value, np.ndarray):
            return None
        if value.dtype.hasobject or value.size == 0 or value.nbytes < self._array_threshold:
            return None
        descriptor = self._descriptors.get(id(value))
        if descriptor is None:
            descriptor = self._buffer_store.descriptor_for(value)
            if descriptor is None:
                descriptor = self._buffer_store.publish(value, self._transaction_id)
            else:
                self._buffer_store.retain(descriptor, self._transaction_id)
            self._descriptors[id(value)] = descriptor
        return "caemble-mmap-array-v1", descriptor


class _MmapUnpickler(pickle.Unpickler):
    def __init__(
        self,
        stream: io.BytesIO,
        buffer_store: BufferStore,
        transaction_id: str,
    ) -> None:
        super().__init__(stream)
        self._buffer_store = buffer_store
        self._transaction_id = transaction_id
        self._arrays: dict[str, np.memmap[Any, Any]] = {}

    def persistent_load(self, persistent_id: Any) -> Any:
        if (
            not isinstance(persistent_id, tuple)
            or len(persistent_id) != 2
            or persistent_id[0] != "caemble-mmap-array-v1"
            or not isinstance(persistent_id[1], MmapArrayDescriptor)
        ):
            raise pickle.UnpicklingError("unsupported mmap persistent ID")
        descriptor = persistent_id[1]
        array = self._arrays.get(descriptor.buffer_id)
        if array is None:
            array = self._buffer_store.open(
                descriptor,
                transaction_id=self._transaction_id,
            )
            self._arrays[descriptor.buffer_id] = array
        return array
