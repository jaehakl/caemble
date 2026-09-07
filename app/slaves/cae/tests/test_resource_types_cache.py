from __future__ import annotations

import asyncio
import concurrent.futures
import multiprocessing
import pickle
from collections.abc import Mapping
from pathlib import Path

import numpy as np
import pytest

from app.methods.geometry import GeometryService
from app.kernel.api import (
    ContentKey,
    FieldValue,
    FieldLocation,
    ParticleSetValue,
    RaySetValue,
    BundleValue,
    StructuredGridValue,
    UnstructuredMeshValue,
)
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.kernel.resources import (
    ArtifactStore,
    FileResourceCache,
    ImmutableResourceCache,
    ResourceKind,
    ResourceStore,
    ResourceValidationError,
)


def _publish_file_cache(root: str, key: ContentKey, value: str) -> str:
    return FileResourceCache(root).publish(key, value)


def test_structured_grid_and_field_are_immutable_linked_resources() -> None:
    resources = ResourceStore()
    grid = StructuredGridValue(
        shape=(2, 3),
        axes=(np.array([0.0, 1.0]), np.array([2.0, 3.0, 4.0])),
        unit="m",
        identity="grid-a",
        metadata={"geometryHash": "abc"},
    )
    values = np.arange(12, dtype=np.float64).reshape(2, 3, 2)
    field_ref, bundle_ref = resources.ingest_many((
        FieldValue(
            domain=grid,
            location="cell",
            quantity_kind="ElectricCurrentDensity",
            unit="A/m2",
            values=values,
            basis={"kind": "cartesian"},
            components=("x", "y"),
            metadata={"solver": "dc"},
        ),
        BundleValue("test/vector-field", {"values": values, "domain": grid}),
    ))
    field_lease = resources.acquire(field_ref)
    bundle_lease = resources.acquire(bundle_ref)

    field = resources.resolve(field_ref)
    bundle = resources.resolve(bundle_ref)
    assert isinstance(field, FieldValue)
    assert field.location is FieldLocation.CELL
    assert field.domain.identity == "grid-a"
    assert field.domain.metadata["geometryHash"] == "abc"
    assert field.domain.axes[0] is bundle.members["domain"].axes[0]
    assert field.values is bundle.members["values"]
    assert not field.values.flags.writeable
    assert isinstance(field.metadata, Mapping)

    description = resources.describe(field_ref)
    grid_ref = description.metadata["domainRef"]
    assert description.kind is ResourceKind.FIELD
    assert description.shape == (2, 3, 2)
    assert resources.kind(grid_ref) is ResourceKind.STRUCTURED_GRID
    assert description.metadata["quantityKind"] == "ElectricCurrentDensity"
    assert description.metadata["components"] == ("x", "y")
    assert resources.reference_count(grid_ref) == 2

    detached = resources.materialize(field_ref)
    assert detached.values.flags.writeable
    detached.values[0, 0, 0] = -1
    assert field.values[0, 0, 0] == 0

    resources.release(field_lease)
    assert resources.contains(grid_ref)
    resources.release(bundle_lease)
    assert not resources.contains(grid_ref)
    resources.close()


def test_field_contract_rejects_tagged_mapping_payloads() -> None:
    values = np.arange(3, dtype=np.float64)
    contract = {
        "dtype": "float64", "quantityKind": "Temperature", "unit": "K",
        "axes": [{"name": "x"}],
    }
    tagged = {
        "kind": "caemble.structured-field/v1", "value": values,
        "domainRef": {"kind": "caemble.structured-grid/v1", "shape": [3]},
        "location": "cell", "quantityKind": "Temperature", "unit": "K",
    }
    with pytest.raises(ValueError, match="must be a FieldValue"):
        validate_artifact_payload(tagged, contract, "field", require_spatial_field=True)
    domain = StructuredGridValue((3,), (values,), "m")
    validate_artifact_payload(
        FieldValue(domain, "cell", "Temperature", "K", values),
        contract, "field", require_spatial_field=True,
    )


def test_bundle_resources_preserve_arrays_and_reject_tagged_contract_payloads() -> None:
    resources = ResourceStore()
    artifacts = ArtifactStore(resources)
    origins = np.zeros((2, 3), dtype=np.float64)
    bundle = BundleValue("test/rays", {"origins": origins, "rootIds": ["source-a", "source-b"]})
    handle = artifacts.publish(
        bundle, producer_task="ray", solver_name="test-ray", solver_version="1.0.0",
        output_name="rayPaths", artifact_type="test/rays@1", state_revision=1,
        copy_arrays=False,
    )
    bundle_ref = handle.resource_ref
    description = resources.describe(bundle_ref)
    assert resources.kind(bundle_ref) is ResourceKind.STRUCTURED_BUNDLE
    assert description.metadata["bundleType"] == "test/rays"
    assert set(description.metadata["members"]) == {"origins", "rootIds"}
    resolved = artifacts.resolve(handle)
    assert isinstance(resolved, BundleValue)
    assert resolved.members["origins"] is origins
    assert not resolved.members["origins"].flags.writeable
    with pytest.raises(TypeError):
        resolved.members["rootIds"] = ()

    transport_view = artifacts.materialize(handle)
    assert transport_view.members["origins"] is origins
    assert not transport_view.members["origins"].flags.writeable
    materialized = artifacts.materialize(handle, copy_arrays=True)
    assert materialized.bundle_type == "test/rays"
    assert isinstance(materialized.members, dict)
    assert materialized.members["origins"].flags.writeable
    with pytest.raises(ValueError, match="must be a BundleValue"):
        validate_artifact_payload(
            {"kind": "caemble.ray-path-bundle/v1", "members": bundle.members},
            {"resourceKind": "structuredBundle", "members": {}}, "paths",
        )
    artifacts.release(handle)
    assert not resources.contains(bundle_ref)
    artifacts.close()
    resources.close()


def test_unstructured_mesh_particle_and_ray_resources_validate_topology() -> None:
    resources = ResourceStore()
    mesh_ref = resources.ingest(
        UnstructuredMeshValue(
            points=np.array(
                [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
            ),
            cells={"triangle3": np.array([[0, 1, 2]], dtype=np.int32)},
            unit="m",
        )
    )
    particles_ref = resources.ingest(
        ParticleSetValue(
            positions=np.array([[0.0, 0.0], [1.0, 1.0]]),
            unit="m",
            attributes={"mass": np.array([1.0, 2.0])},
        )
    )
    rays_ref = resources.ingest(
        RaySetValue(
            origins=np.zeros((2, 3)),
            directions=np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]),
            unit="m",
            attributes={"power": np.array([3.0, 4.0])},
        )
    )

    assert resources.kind(mesh_ref) is ResourceKind.UNSTRUCTURED_MESH
    assert resources.kind(particles_ref) is ResourceKind.PARTICLE_SET
    assert resources.describe(rays_ref).metadata["count"] == 2

    with pytest.raises(ResourceValidationError, match="out-of-range"):
        resources.ingest(
            UnstructuredMeshValue(
                points=np.zeros((2, 3)),
                cells=np.array([[0, 2]], dtype=np.int64),
                unit="m",
            )
        )
    with pytest.raises(ResourceValidationError, match="first dimension 2"):
        resources.ingest(
            ParticleSetValue(
                positions=np.zeros((2, 3)),
                unit="m",
                attributes={"mass": np.ones(3)},
            )
        )
    with pytest.raises(ResourceValidationError, match="cannot be zero"):
        resources.ingest(RaySetValue(np.zeros((1, 3)), np.zeros((1, 3)), "m"))


def test_field_metadata_and_domain_are_validated() -> None:
    resources = ResourceStore()
    grid = StructuredGridValue((2,), (np.array([0.0, 1.0]),), "m")
    particles = ParticleSetValue(np.zeros((2, 3)), "m")

    with pytest.raises(ResourceValidationError, match="trailing dimension"):
        resources.ingest(
            FieldValue(
                grid,
                "cell",
                "Velocity",
                "m/s",
                np.ones((2, 2)),
                components=("x", "y", "z"),
            )
        )
    with pytest.raises(ResourceValidationError, match="cannot reference"):
        resources.ingest(
            FieldValue(
                particles,
                "cell",
                "Temperature",
                "K",
                np.ones(2),
            )
        )
    with pytest.raises(ValueError, match="quantity_kind"):
        FieldValue(grid, "cell", "", "K", np.ones(2))


def test_content_keys_are_canonical_and_include_array_content() -> None:
    first = ContentKey.from_parts(
        "geometry",
        {"rootId": "part", "profile": {"size": 0.1, "order": 2}},
        np.array([1, 2, 3], dtype=np.int32),
    )
    reordered = ContentKey.from_parts(
        "geometry",
        {"profile": {"order": 2, "size": 0.1}, "rootId": "part"},
        np.array([1, 2, 3], dtype=np.int32),
    )
    changed = ContentKey.from_parts(
        "geometry",
        {"rootId": "part", "profile": {"size": 0.1, "order": 2}},
        np.array([1, 2, 4], dtype=np.int32),
    )

    assert first == reordered
    assert first != changed
    assert str(first).startswith("geometry:")


def test_immutable_cache_is_idempotent_lru_and_lease_safe() -> None:
    resources = ResourceStore()
    cache = ImmutableResourceCache(resources, max_entries=2)
    first = ContentKey.from_parts("mesh", "first")
    second = ContentKey.from_parts("mesh", "second")
    third = ContentKey.from_parts("mesh", "third")

    first_ref = cache.publish(first, np.array([1]))
    second_ref = cache.publish(second, np.array([2]))
    external = cache.acquire(second, owner="invocation")
    assert external is not None
    assert cache.publish(first, np.array([999])) == first_ref
    np.testing.assert_array_equal(cache.resolve(first), [1])
    cache.publish(third, np.array([3]))

    assert cache.lookup(second) is None
    assert resources.contains(second_ref)
    resources.release(external)
    assert not resources.contains(second_ref)
    assert cache.keys() == (first, third)
    assert cache.evict(first)
    assert not resources.contains(first_ref)
    assert cache.stats().evictions == 2


def test_file_cache_publish_once_is_safe_across_spawn_children(tmp_path: Path) -> None:
    key = ContentKey.from_parts("geometry", "shared", {"meshSize": 0.1})
    context = multiprocessing.get_context("spawn")

    with concurrent.futures.ProcessPoolExecutor(
        max_workers=2,
        mp_context=context,
    ) as executor:
        futures = [
            executor.submit(_publish_file_cache, str(tmp_path), key, value)
            for value in ("first", "second")
        ]
        results = [future.result(timeout=10) for future in futures]

    assert results[0] == results[1]
    assert results[0] in {"first", "second"}
    cache = FileResourceCache(tmp_path)
    assert cache.lookup(key) == results[0]
    assert len(cache.entry_paths()) == 1


def test_file_cache_retries_transient_post_replace_reads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = FileResourceCache(tmp_path)
    key = ContentKey.from_parts("geometry", "transient-post-replace")
    entry_path = cache.entry_path(key)
    original_read_bytes = Path.read_bytes
    observed_reads = 0

    def transient_read_bytes(path: Path) -> bytes:
        nonlocal observed_reads
        if path == entry_path and path.exists():
            observed_reads += 1
            if observed_reads == 1:
                raise PermissionError("simulated Windows sharing violation")
            if observed_reads == 2:
                return original_read_bytes(path)[:8]
        return original_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", transient_read_bytes)

    assert cache.publish(key, {"mesh": [1, 2, 3]}) == {"mesh": [1, 2, 3]}
    assert observed_reads >= 3
    assert entry_path.exists()
    assert cache.stats().corruptions == 0
    assert cache.lookup(key) == {"mesh": [1, 2, 3]}


def test_file_cache_same_key_publish_is_stable_under_repeated_spawn_contention(
    tmp_path: Path,
) -> None:
    context = multiprocessing.get_context("spawn")
    winners: dict[ContentKey, str] = {}

    with concurrent.futures.ProcessPoolExecutor(
        max_workers=4,
        mp_context=context,
    ) as executor:
        for round_number in range(16):
            key = ContentKey.from_parts("geometry", "stress", round_number)
            contenders = tuple(
                f"round-{round_number}-contender-{contender}"
                for contender in range(6)
            )
            futures = [
                executor.submit(_publish_file_cache, str(tmp_path), key, value)
                for value in contenders
            ]
            results = [future.result(timeout=15) for future in futures]

            assert len(set(results)) == 1
            assert results[0] in contenders
            winners[key] = results[0]

    cache = FileResourceCache(tmp_path)
    assert len(cache.entry_paths()) == len(winners)
    for key, winner in winners.items():
        assert cache.lookup(key) == winner


def test_file_cache_treats_corruption_as_miss_and_can_republish(tmp_path: Path) -> None:
    cache = FileResourceCache(tmp_path)
    key = ContentKey.from_parts("mesh", "corruptible")
    cache.publish(key, {"cells": [1, 2, 3]})
    cache.entry_path(key).write_bytes(b"not-a-cache-entry")

    assert cache.lookup(key) is None
    assert not cache.entry_path(key).exists()
    assert cache.stats().corruptions == 1
    assert cache.publish(key, {"cells": [4, 5]}) == {"cells": [4, 5]}


def test_file_cache_paths_clear_evict_and_pickle_are_safe(tmp_path: Path) -> None:
    cache = FileResourceCache(tmp_path)
    escaping = ContentKey.from_parts("../../outside", "entry")
    other = ContentKey.from_parts("geometry", "other")
    source = np.array([1, 2])
    published = cache.publish(escaping, source)
    assert published is not source
    source[0] = 99
    np.testing.assert_array_equal(cache.lookup(escaping), [1, 2])
    cache.publish(other, "value")
    unrelated = tmp_path / "keep.txt"
    unrelated.write_text("not cache data", encoding="utf-8")

    assert cache.entry_path(escaping).parent == tmp_path.resolve()
    restored = pickle.loads(pickle.dumps(cache))
    np.testing.assert_array_equal(restored.lookup(escaping), [1, 2])
    assert cache.evict(other)
    assert cache.clear() == 1
    assert unrelated.read_text(encoding="utf-8") == "not cache data"
    assert cache.stats().entry_count == 0


def test_geometry_mesh_cache_hit_is_numerically_identical_to_miss(tmp_path: Path) -> None:
    scene = {
        "geometryHash": "cache-box-v1",
        "lengthUnit": "m",
        "roots": [
            {
                "id": "box-root",
                "node": {
                    "kind": "primitive",
                    "nodeId": "box-node",
                    "primitive": "box",
                    "parameters": {"size": [1.0, 2.0, 3.0]},
                },
            }
        ],
        "geometryGroups": [],
        "surfaceGroups": [],
    }
    first_cache = FileResourceCache(tmp_path)
    first = asyncio.run(
        GeometryService(cache=first_cache).triangular_mesh(scene, "box-root", "m")
    )
    assert first_cache.stats().misses == 1

    second_cache = FileResourceCache(tmp_path)
    second = asyncio.run(
        GeometryService(cache=second_cache).triangular_mesh(scene, "box-root", "m")
    )

    assert second_cache.stats().hits == 1
    assert len(second_cache.entry_paths()) == 1
    np.testing.assert_array_equal(second.vertices, first.vertices)
    np.testing.assert_array_equal(second.triangles, first.triangles)
    assert second.triangle_provenance == first.triangle_provenance
    assert not second.vertices.flags.writeable
    assert not second.triangles.flags.writeable
