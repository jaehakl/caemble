from __future__ import annotations

import hashlib
import os
import pickle
import re
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from pathlib import Path

from app.runtime_kernel.api.cache import ContentKey
from app.runtime_kernel.resources.models import ResourceLease, ResourceRef
from app.runtime_kernel.resources.store import ResourceStore


@dataclass(frozen=True, slots=True)
class CacheEntry:
    key: ContentKey
    resource_ref: ResourceRef
    inserted_sequence: int
    accessed_sequence: int


@dataclass(frozen=True, slots=True)
class CacheStats:
    entry_count: int
    max_entries: int | None
    hits: int
    misses: int
    evictions: int


@dataclass(frozen=True, slots=True)
class FileCacheStats:
    entry_count: int
    hits: int
    misses: int
    evictions: int
    corruptions: int


class FileResourceCacheError(RuntimeError):
    pass


class FileResourceCacheBusy(FileResourceCacheError):
    pass


@dataclass(frozen=True, slots=True)
class _CacheRecord:
    entry: CacheEntry
    lease: ResourceLease


class ImmutableResourceCache:
    """Content-addressed, immutable, LRU-evictable ResourceStore roots."""

    def __init__(
        self,
        resources: ResourceStore | None = None,
        *,
        max_entries: int | None = None,
    ) -> None:
        if max_entries is not None and max_entries <= 0:
            raise ValueError("cache max_entries must be positive")
        self.resources = resources or ResourceStore()
        self.max_entries = max_entries
        self._owns_resources = resources is None
        self._records: OrderedDict[ContentKey, _CacheRecord] = OrderedDict()
        self._sequence = 0
        self._hits = 0
        self._misses = 0
        self._evictions = 0
        self._closed = False
        self._lock = threading.RLock()

    def publish(
        self,
        key: ContentKey,
        value: Any,
        *,
        copy_arrays: bool = True,
    ) -> ResourceRef:
        """Publish once. Reusing a key always returns its original immutable value."""
        with self._lock:
            self._ensure_open()
            self._validate_key(key)
            existing = self._records.get(key)
            if existing is not None:
                self._touch(key, existing)
                return existing.entry.resource_ref

            owns_ref = not isinstance(value, ResourceRef)
            ref = value if not owns_ref else self.resources.ingest(value, copy_arrays=copy_arrays)
            try:
                self._sequence += 1
                entry = CacheEntry(key, ref, self._sequence, self._sequence)
                lease = self.resources.acquire(ref, owner=f"cache:{key}")
                self._records[key] = _CacheRecord(entry, lease)
                self._trim()
                return ref
            except BaseException:
                if owns_ref and self.resources.contains(ref):
                    self.resources.discard(ref)
                raise

    def lookup(self, key: ContentKey) -> ResourceRef | None:
        with self._lock:
            self._ensure_open()
            self._validate_key(key)
            record = self._records.get(key)
            if record is None:
                self._misses += 1
                return None
            self._hits += 1
            return self._touch(key, record).entry.resource_ref

    def resolve(self, key: ContentKey) -> Any | None:
        ref = self.lookup(key)
        return None if ref is None else self.resources.resolve(ref)

    def acquire(
        self,
        key: ContentKey,
        *,
        owner: str | None = None,
    ) -> ResourceLease | None:
        with self._lock:
            ref = self.lookup(key)
            return None if ref is None else self.resources.acquire(ref, owner=owner)

    def entry(self, key: ContentKey) -> CacheEntry | None:
        with self._lock:
            self._ensure_open()
            self._validate_key(key)
            record = self._records.get(key)
            return None if record is None else record.entry

    def evict(self, key: ContentKey) -> bool:
        with self._lock:
            self._ensure_open()
            self._validate_key(key)
            record = self._records.pop(key, None)
            if record is None:
                return False
            self.resources.release(record.lease)
            self._evictions += 1
            return True

    def evict_lru(self, count: int = 1) -> tuple[ContentKey, ...]:
        if count < 0:
            raise ValueError("eviction count cannot be negative")
        with self._lock:
            self._ensure_open()
            evicted: list[ContentKey] = []
            for _ in range(min(count, len(self._records))):
                key, record = self._records.popitem(last=False)
                self.resources.release(record.lease)
                self._evictions += 1
                evicted.append(key)
            return tuple(evicted)

    def clear(self) -> None:
        with self._lock:
            self._ensure_open()
            self.evict_lru(len(self._records))

    def keys(self) -> tuple[ContentKey, ...]:
        with self._lock:
            self._ensure_open()
            return tuple(self._records)

    def stats(self) -> CacheStats:
        with self._lock:
            return CacheStats(
                len(self._records),
                self.max_entries,
                self._hits,
                self._misses,
                self._evictions,
            )

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            for record in tuple(self._records.values()):
                self.resources.release(record.lease)
            self._records.clear()
            self._closed = True
            if self._owns_resources:
                self.resources.close()

    def __enter__(self) -> ImmutableResourceCache:
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        del exc_type, exc, traceback
        self.close()

    def _touch(self, key: ContentKey, record: _CacheRecord) -> _CacheRecord:
        self._sequence += 1
        touched = _CacheRecord(
            CacheEntry(
                key,
                record.entry.resource_ref,
                record.entry.inserted_sequence,
                self._sequence,
            ),
            record.lease,
        )
        self._records[key] = touched
        self._records.move_to_end(key)
        return touched

    def _trim(self) -> None:
        if self.max_entries is not None and len(self._records) > self.max_entries:
            self.evict_lru(len(self._records) - self.max_entries)

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("resource cache is closed")

    @staticmethod
    def _validate_key(key: ContentKey) -> None:
        if not isinstance(key, ContentKey):
            raise TypeError("resource cache keys must be ContentKey values")


ResourceCache = ImmutableResourceCache


class FileResourceCache:
    """Cross-process immutable cache for trusted, picklable method resources."""

    _MAGIC = b"caemble-file-resource-cache-v1\0"
    _ENTRY_NAME = re.compile(r"^[0-9a-f]{64}-[0-9a-f]{64}\.pkl$")
    _READ_RETRY_SECONDS = 0.05
    _READ_RETRY_DELAY_SECONDS = 0.005

    def __init__(
        self,
        root: Path | str,
        *,
        publish_wait_seconds: float = 5.0,
    ) -> None:
        if publish_wait_seconds <= 0:
            raise ValueError("cache publish_wait_seconds must be positive")
        cache_root = Path(root).resolve()
        cache_root.mkdir(parents=True, exist_ok=True)
        if not cache_root.is_dir():
            raise FileResourceCacheError("file resource cache root is not a directory")
        self.root = cache_root
        self.publish_wait_seconds = publish_wait_seconds
        self._hits = 0
        self._misses = 0
        self._evictions = 0
        self._corruptions = 0
        self._lock = threading.RLock()

    def publish(self, key: ContentKey, value: Any) -> Any:
        """Atomically publish a key once and return the winning immutable value."""
        self._validate_key(key)
        existing = self._read(key, count=False)
        if existing is not _CACHE_MISS:
            return existing

        try:
            payload = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
        except Exception as error:
            raise FileResourceCacheError("cache value is not picklable") from error
        encoded = self._MAGIC + hashlib.sha256(payload).digest() + payload
        temporary = self._write_temporary(key, encoded)
        entry_path = self.entry_path(key)
        lock_path = self._lock_path(key)
        deadline = time.monotonic() + self.publish_wait_seconds
        cleared_stale_lock = False

        try:
            while True:
                existing = self._read(key, count=False)
                if existing is not _CACHE_MISS:
                    return existing
                try:
                    descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                except FileExistsError:
                    if time.monotonic() < deadline:
                        time.sleep(0.005)
                        continue
                    if not cleared_stale_lock and self._remove_stale_lock(lock_path):
                        cleared_stale_lock = True
                        deadline = time.monotonic() + self.publish_wait_seconds
                        continue
                    raise FileResourceCacheBusy(f"cache key {key} is being published")

                try:
                    os.write(descriptor, f"{os.getpid()}\n".encode("ascii"))
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
                try:
                    existing = self._read(key, count=False)
                    if existing is _CACHE_MISS:
                        os.replace(temporary, entry_path)
                        temporary = None
                        published = self._read(
                            key,
                            count=False,
                            wait_for_stable=True,
                        )
                        if published is _CACHE_MISS:
                            raise FileResourceCacheError(
                                f"cache key {key} could not be read after publication"
                            )
                        return published
                    return existing
                finally:
                    lock_path.unlink(missing_ok=True)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def lookup(self, key: ContentKey) -> Any | None:
        self._validate_key(key)
        value = self._read(key, count=True)
        return None if value is _CACHE_MISS else value

    def contains(self, key: ContentKey) -> bool:
        self._validate_key(key)
        return self._read(key, count=False) is not _CACHE_MISS

    def evict(self, key: ContentKey) -> bool:
        self._validate_key(key)
        with self._lock:
            path = self.entry_path(key)
            try:
                path.unlink()
            except FileNotFoundError:
                return False
            self._evictions += 1
            return True

    def clear(self) -> int:
        """Remove only files created by this cache implementation."""
        with self._lock:
            removed = 0
            for path in tuple(self.root.iterdir()):
                if not path.is_file() or not self._managed_name(path.name):
                    continue
                resolved = path.resolve()
                if resolved.parent != self.root:
                    raise FileResourceCacheError("cache entry escaped its root")
                try:
                    resolved.unlink()
                except FileNotFoundError:
                    continue
                if self._ENTRY_NAME.fullmatch(path.name):
                    removed += 1
            self._evictions += removed
            return removed

    def entry_paths(self) -> tuple[Path, ...]:
        with self._lock:
            return tuple(
                sorted(
                    path
                    for path in self.root.iterdir()
                    if path.is_file() and self._ENTRY_NAME.fullmatch(path.name)
                )
            )

    def entry_path(self, key: ContentKey) -> Path:
        self._validate_key(key)
        namespace = hashlib.sha256(key.namespace.encode("utf-8")).hexdigest()
        return self._safe_path(f"{namespace}-{key.digest}.pkl")

    def stats(self) -> FileCacheStats:
        with self._lock:
            return FileCacheStats(
                len(self.entry_paths()),
                self._hits,
                self._misses,
                self._evictions,
                self._corruptions,
            )

    def __getstate__(self) -> dict[str, Any]:
        return {
            "root": self.root,
            "publish_wait_seconds": self.publish_wait_seconds,
        }

    def __setstate__(self, state: Mapping[str, Any]) -> None:
        self.__init__(state["root"], publish_wait_seconds=state["publish_wait_seconds"])

    def _read(
        self,
        key: ContentKey,
        *,
        count: bool,
        wait_for_stable: bool = False,
    ) -> Any:
        path = self.entry_path(key)
        retry_seconds = (
            self.publish_wait_seconds
            if wait_for_stable
            else min(self._READ_RETRY_SECONDS, self.publish_wait_seconds)
        )
        deadline = time.monotonic() + retry_seconds
        failure: Exception | None = None

        while True:
            try:
                encoded = path.read_bytes()
                if len(encoded) != path.stat().st_size:
                    raise BlockingIOError("cache entry read was incomplete")
                header_length = len(self._MAGIC) + hashlib.sha256().digest_size
                if len(encoded) < header_length or not encoded.startswith(self._MAGIC):
                    raise ValueError("cache entry header is invalid")
                expected = encoded[len(self._MAGIC) : header_length]
                payload = encoded[header_length:]
                if hashlib.sha256(payload).digest() != expected:
                    raise ValueError("cache entry checksum is invalid")
                value = pickle.loads(payload)
                failure = None
                break
            except FileNotFoundError as error:
                failure = error
                if not wait_for_stable:
                    break
            except Exception as error:
                failure = error

            if time.monotonic() >= deadline:
                break
            time.sleep(self._READ_RETRY_DELAY_SECONDS)

        if failure is not None:
            # A sharing violation or an inconsistent read is an availability
            # failure, not evidence that the atomically published file is corrupt.
            if isinstance(failure, OSError):
                if count:
                    with self._lock:
                        self._misses += 1
                return _CACHE_MISS

            try:
                publication_in_progress = self._lock_path(key).exists()
            except OSError:
                publication_in_progress = True
            if publication_in_progress:
                if count:
                    with self._lock:
                        self._misses += 1
                return _CACHE_MISS

            with self._lock:
                self._corruptions += 1
                if count:
                    self._misses += 1
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            return _CACHE_MISS
        if count:
            with self._lock:
                self._hits += 1
        return value

    def _write_temporary(self, key: ContentKey, encoded: bytes) -> Path:
        namespace = hashlib.sha256(key.namespace.encode("utf-8")).hexdigest()
        descriptor, raw_path = tempfile.mkstemp(
            dir=self.root,
            prefix=f".{namespace}-{key.digest}-",
            suffix=".tmp",
        )
        path = Path(raw_path).resolve()
        if path.parent != self.root:
            os.close(descriptor)
            path.unlink(missing_ok=True)
            raise FileResourceCacheError("temporary cache entry escaped its root")
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return path

    def _lock_path(self, key: ContentKey) -> Path:
        return self.entry_path(key).with_suffix(".lock")

    def _remove_stale_lock(self, path: Path) -> bool:
        try:
            age = time.time() - path.stat().st_mtime
            if age < self.publish_wait_seconds:
                return False
            path.unlink()
            return True
        except FileNotFoundError:
            return True

    def _safe_path(self, name: str) -> Path:
        path = (self.root / name).resolve()
        if path.parent != self.root:
            raise FileResourceCacheError("cache path escaped its root")
        return path

    @classmethod
    def _managed_name(cls, name: str) -> bool:
        return bool(cls._ENTRY_NAME.fullmatch(name))

    @staticmethod
    def _validate_key(key: ContentKey) -> None:
        if not isinstance(key, ContentKey):
            raise TypeError("file resource cache keys must be ContentKey values")


_CACHE_MISS = object()
