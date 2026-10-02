from __future__ import annotations

import io
import pickle
from dataclasses import dataclass, replace
from typing import Any, Protocol

import numpy as np

from app.kernel.resources.buffers import BufferStore, MmapArrayDescriptor


@dataclass(frozen=True, slots=True)
class InlineArrayPayload:
    buffer_id: int
    dtype: np.dtype
    shape: tuple[int, ...]
    fortran_order: bool
    data: bytes
    readonly: bool
    array_type: type


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
        self._descriptors: dict[tuple[Any, ...], MmapArrayDescriptor] = {}
        self._inline: dict[tuple[Any, ...], InlineArrayPayload] = {}

    def persistent_id(self, value: Any) -> Any:
        if not isinstance(value, np.ndarray):
            return None
        if value.dtype.hasobject:
            return None
        storage = (value.__array_interface__["data"][0], value.shape, value.strides, value.dtype.str)
        if value.size == 0 or value.nbytes < self._array_threshold:
            if not np.issubdtype(value.dtype, np.number):
                return None
            inline = self._inline.get(storage)
            if inline is None:
                fortran = bool(value.flags.f_contiguous and not value.flags.c_contiguous)
                inline = InlineArrayPayload(len(self._inline), value.dtype, value.shape, fortran,
                                            value.tobytes(order="F" if fortran else "C"),
                                            not value.flags.writeable, type(value))
                self._inline[storage] = inline
            return "caemble-inline-array-v1", replace(inline, readonly=not value.flags.writeable)
        descriptor = self._descriptors.get(storage)
        if descriptor is None:
            descriptor = self._buffer_store.descriptor_for(value)
            if descriptor is None:
                descriptor = self._buffer_store.publish(value, self._transaction_id)
            else:
                self._buffer_store.retain(descriptor, self._transaction_id)
            self._descriptors[storage] = descriptor
        descriptor = replace(descriptor, readonly=not value.flags.writeable)
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
        self._arrays: dict[tuple[str, bool], np.memmap[Any, Any]] = {}
        self._inline_arrays: dict[int, np.ndarray[Any, Any]] = {}
        self._inline_views: dict[tuple[int, bool], np.ndarray[Any, Any]] = {}

    def persistent_load(self, persistent_id: Any) -> Any:
        if (isinstance(persistent_id, tuple) and len(persistent_id) == 2
                and persistent_id[0] == "caemble-inline-array-v1"
                and isinstance(persistent_id[1], InlineArrayPayload)):
            descriptor = persistent_id[1]
            key = descriptor.buffer_id, descriptor.readonly
            view = self._inline_views.get(key)
            if view is None:
                array = self._inline_arrays.get(descriptor.buffer_id)
                if array is None:
                    array = np.frombuffer(bytearray(descriptor.data), dtype=descriptor.dtype).reshape(
                        descriptor.shape, order="F" if descriptor.fortran_order else "C")
                    self._inline_arrays[descriptor.buffer_id] = array
                view = array.view(descriptor.array_type)
                view.flags.writeable = not descriptor.readonly
                self._inline_views[key] = view
            return view
        if (
            not isinstance(persistent_id, tuple)
            or len(persistent_id) != 2
            or persistent_id[0] != "caemble-mmap-array-v1"
            or not isinstance(persistent_id[1], MmapArrayDescriptor)
        ):
            raise pickle.UnpicklingError("unsupported mmap persistent ID")
        descriptor = persistent_id[1]
        key = (descriptor.buffer_id, descriptor.readonly)
        array = self._arrays.get(key)
        if array is None:
            array = self._buffer_store.open(
                descriptor,
                transaction_id=self._transaction_id,
            )
            self._arrays[key] = array
        return array
