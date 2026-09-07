from __future__ import annotations

import dataclasses
import hashlib
import struct
from collections.abc import Mapping, Sequence, Set
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

import numpy as np


@dataclass(frozen=True, slots=True)
class ContentKey:
    namespace: str
    digest: str

    def __post_init__(self) -> None:
        if not isinstance(self.namespace, str) or not self.namespace:
            raise ValueError("cache key namespace must be a non-empty string")
        if (
            not isinstance(self.digest, str)
            or len(self.digest) != 64
            or any(character not in "0123456789abcdef" for character in self.digest)
        ):
            raise ValueError("cache key digest must be a lowercase SHA-256 hex string")

    @classmethod
    def from_parts(cls, namespace: str, *parts: Any) -> ContentKey:
        digest = hashlib.sha256()
        digest.update(b"caemble-resource-cache-v1")
        for part in parts:
            encoded = _content_digest(part, set())
            digest.update(struct.pack("!Q", len(encoded)))
            digest.update(encoded)
        return cls(namespace, digest.hexdigest())

    def __str__(self) -> str:
        return f"{self.namespace}:{self.digest}"


class ValueCache(Protocol):
    """Immutable value cache used by child-local numerical services."""

    def lookup(self, key: ContentKey) -> Any | None: ...

    def publish(self, key: ContentKey, value: Any) -> Any: ...


def _content_digest(value: Any, active: set[int]) -> bytes:
    if value is None:
        return b"none"
    if isinstance(value, bool):
        return b"bool:" + (b"1" if value else b"0")
    if isinstance(value, int):
        return b"int:" + str(value).encode("ascii")
    if isinstance(value, float):
        return b"float:" + struct.pack("!d", value)
    if isinstance(value, str):
        return b"str:" + value.encode("utf-8")
    if isinstance(value, bytes):
        return b"bytes:" + value
    if isinstance(value, Enum):
        return b"enum:" + _content_digest(value.value, active)
    if isinstance(value, np.ndarray):
        if value.dtype.hasobject:
            raise TypeError("object arrays cannot be used in content cache keys")
        contiguous = np.ascontiguousarray(value)
        digest = hashlib.sha256(contiguous.tobytes(order="C")).digest()
        return (
            b"array:"
            + value.dtype.str.encode("ascii")
            + repr(tuple(value.shape)).encode("ascii")
            + digest
        )
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return _content_digest(
            {
                field.name: getattr(value, field.name)
                for field in dataclasses.fields(value)
            },
            active,
        )

    tracked = isinstance(value, (Mapping, Sequence, Set))
    value_id = id(value)
    if tracked and value_id in active:
        raise ValueError("cyclic values cannot be used in content cache keys")
    if tracked:
        active.add(value_id)
    try:
        if isinstance(value, Mapping):
            items = sorted(
                (
                    _content_digest(key, active),
                    _content_digest(item, active),
                )
                for key, item in value.items()
            )
            return b"mapping:" + b"".join(
                struct.pack("!Q", len(key))
                + key
                + struct.pack("!Q", len(item))
                + item
                for key, item in items
            )
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            prefix = b"tuple:" if isinstance(value, tuple) else b"sequence:"
            return prefix + b"".join(
                struct.pack("!Q", len(item)) + item
                for item in (_content_digest(item, active) for item in value)
            )
        if isinstance(value, Set):
            return b"set:" + b"".join(
                sorted(_content_digest(item, active) for item in value)
            )
    finally:
        if tracked:
            active.discard(value_id)
    raise TypeError(f"unsupported content cache key part {type(value).__name__}")
