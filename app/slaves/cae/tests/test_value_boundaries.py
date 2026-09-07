from __future__ import annotations

import dataclasses
import gc
import importlib
import pickle
from collections.abc import Mapping
from typing import Any

import numpy as np
import pytest

from app.kernel.api import (
    BundleValue,
    ContentKey,
    FieldValue,
    ParticleSetValue,
    RaySetValue,
    StatePatch,
    StructuredGridValue,
    UnstructuredMeshValue,
)
from app.kernel.execution import MmapPayloadCodec
from app.kernel.resources import BufferStore, ResourceRef, ResourceStore


def _assert_detached(value: Any) -> None:
    assert not isinstance(value, ResourceRef)
    if dataclasses.is_dataclass(value):
        for member in dataclasses.fields(value):
            _assert_detached(getattr(value, member.name))
    elif isinstance(value, Mapping):
        for item in value.values():
            _assert_detached(item)
    elif isinstance(value, (tuple, list)):
        for item in value:
            _assert_detached(item)


@pytest.fixture
def mesh() -> UnstructuredMeshValue:
    return UnstructuredMeshValue(
        np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0],
                  [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
        {"tetra4": np.array([[0, 1, 2, 3]], dtype=np.int32)},
        "m",
        identity="mesh-deformed",
        metadata={"sourceIdentity": "mesh-original"},
    )


@pytest.mark.parametrize("mutable", (True, False))
def test_field_materialize_detaches_domain_for_another_store(
    mesh: UnstructuredMeshValue, mutable: bool,
) -> None:
    source = ResourceStore()
    consumer = ResourceStore()
    try:
        values = np.array([300.0, 310.0, 320.0, 330.0])
        field = FieldValue(mesh, "node", "Temperature", "K", values)
        root = source.ingest(field)
        lease = source.acquire(root)
        local = source.resolve(root)
        assert isinstance(local, FieldValue)
        _assert_detached(local)
        assert local.domain.identity == "mesh-deformed"
        assert not local.values.flags.writeable

        exported = source.materialize(root, mutable=mutable)
        _assert_detached(exported)
        assert isinstance(exported, FieldValue)
        assert isinstance(exported.domain, UnstructuredMeshValue)
        assert exported.domain.identity == "mesh-deformed"
        assert exported.domain.metadata["sourceIdentity"] == "mesh-original"
        assert exported.location == "node"
        assert exported.quantity_kind == "Temperature"
        assert exported.unit == "K"
        np.testing.assert_array_equal(exported.domain.cells["tetra4"], [[0, 1, 2, 3]])
        assert exported.values.flags.writeable is mutable
        assert exported.domain.points.flags.writeable is mutable

        source.release(lease)
        source.close()
        received = consumer.materialize(consumer.ingest(exported))
        np.testing.assert_array_equal(received.domain.points, mesh.points)
        np.testing.assert_array_equal(received.values, values)
        if mutable:
            exported.domain.points[0, 0] = 5.0
            exported.values[0] = 400.0
            assert received.domain.points[0, 0] == 0.0
            assert received.values[0] == 300.0
        else:
            with pytest.raises(TypeError):
                exported.domain.metadata["sourceIdentity"] = "changed"
    finally:
        source.close()
        consumer.close()


def test_solver_api_has_no_runtime_or_legacy_exports() -> None:
    from app.kernel import api, resources

    for name in (
        "StructuredGrid", "UnstructuredMesh", "ParticleSet", "RaySet", "StructuredBundle",
        "Field", "ResourceStore", "LegacySolverAdapter", "adapt_legacy_result",
    ):
        assert not hasattr(api, name)
    for name in ("Field", "StructuredGrid", "UnstructuredMesh", "StructuredBundle", "ResourceTreeRef"):
        assert not hasattr(resources, name)
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("app.kernel.resources.models")
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("app.kernel.compat.legacy")


def test_canonical_value_pickle_round_trip_preserves_content_keys(
    mesh: UnstructuredMeshValue,
) -> None:
    values = [
        mesh,
        StructuredGridValue((2,), (np.array([0.0, 1.0]),), "m"),
        ParticleSetValue(np.zeros((2, 3)), "m"),
        RaySetValue(np.zeros((1, 3)), np.array([[1.0, 0.0, 0.0]]), "m"),
        BundleValue("test/domain", {"mesh": mesh}),
        ContentKey.from_parts("geometry", "sample"),
        StatePatch().put("step", 1),
    ]
    for value in values:
        restored = pickle.loads(pickle.dumps(value))
        assert type(restored) is type(value)
        assert type(restored).__module__.startswith("app.kernel.api.")
        assert ContentKey.from_parts("round-trip", restored) == ContentKey.from_parts("round-trip", value)
        _assert_detached(restored)
    assert ContentKey.from_parts("domain", mesh) == ContentKey.from_parts("domain", dataclasses.asdict(mesh))
    with pytest.raises(ModuleNotFoundError):
        pickle.loads(b"capp.kernel.resources.models\nUnstructuredMesh\n.")


@pytest.mark.parametrize("mutable", (True, False))
def test_particle_and_ray_fields_keep_domain_attributes_in_nested_bundles(mutable: bool) -> None:
    resources = ResourceStore()
    positions = np.array([[0.0, 0.0, 0.0], [1.0, 2.0, 3.0]])
    particles = ParticleSetValue(
        positions, "m", {"mass": np.array([1.0, 2.0])}, identity="particles-a",
    )
    rays = RaySetValue(
        positions, np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]), "m",
        {"wavelength": np.array([400.0, 600.0])}, identity="rays-a",
    )
    bundle = BundleValue("test/sampling", {
        "particles": FieldValue(particles, "particle", "Temperature", "K", np.array([300.0, 301.0])),
        "rays": FieldValue(rays, "ray", "RadiantFlux", "W", np.array([2.0, 3.0])),
        "positions": positions,
    })
    try:
        detached = resources.materialize(resources.ingest(bundle), mutable=mutable)
        _assert_detached(detached)
        particle_field = detached.members["particles"]
        ray_field = detached.members["rays"]
        assert particle_field.domain.positions is ray_field.domain.origins
        assert particle_field.domain.positions is detached.members["positions"]
        np.testing.assert_array_equal(particle_field.domain.attributes["mass"], [1.0, 2.0])
        np.testing.assert_array_equal(ray_field.domain.attributes["wavelength"], [400.0, 600.0])
        assert particle_field.location == "particle"
        assert ray_field.location == "ray"
        if mutable:
            restored = pickle.loads(pickle.dumps(detached))
            assert restored.members["particles"].domain.positions is restored.members["positions"]
    finally:
        resources.close()


def test_field_domain_and_values_reuse_mmap_backing_across_resource_roots(
    mesh: UnstructuredMeshValue,
) -> None:
    buffers = BufferStore()
    resources = ResourceStore()
    try:
        field = FieldValue(mesh, "node", "Temperature", "K", np.arange(4.0))
        codec = MmapPayloadCodec(buffers, array_threshold=1)
        first = codec.begin_invocation()
        decoded = first.decode(first.encode({
            "state": {"field": field},
            "artifact": field,
            "bundle": BundleValue("test/field", {"field": field, "domain": mesh}),
        }))
        roots = resources.ingest_many(tuple(decoded.values()), copy_arrays=False)
        state_lease, artifact_lease, bundle_lease = (
            resources.acquire(root) for root in roots
        )
        first.commit()
        exported = resources.materialize(roots[2], copy_arrays=False)
        _assert_detached(exported)
        assert exported.members["field"].domain is exported.members["domain"]
        original_values = buffers.descriptor_for(exported.members["field"].values)
        original_points = buffers.descriptor_for(exported.members["domain"].points)
        assert original_values is not None and original_points is not None
        original_files = buffers.files()
        assert len(original_files) == 3  # points, connectivity and field values

        second = codec.begin_invocation()
        reopened = second.decode(second.encode(exported))
        assert buffers.files() == original_files
        assert buffers.descriptor_for(reopened.members["field"].values).buffer_id == original_values.buffer_id
        assert buffers.descriptor_for(reopened.members["domain"].points).buffer_id == original_points.buffer_id
        second.commit()

        resources.release(state_lease)
        resources.release(artifact_lease)
        assert buffers.files() == original_files
        np.testing.assert_array_equal(resources.materialize(roots[2]).members["field"].values, np.arange(4.0))
        resources.release(bundle_lease)
        assert resources.stats().resource_count == 0
        del decoded, exported, reopened
        gc.collect()
        assert buffers.files() == ()
    finally:
        resources.close()
        buffers.close()
