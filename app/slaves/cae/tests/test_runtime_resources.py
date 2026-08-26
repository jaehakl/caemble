from __future__ import annotations

import gc
from collections.abc import Mapping

import numpy as np
import pytest

from app.runtime_kernel.api import (
    LegacySolverAdapter,
    SolverImplementation,
    SolverInvocation,
    SolverResult,
)
from app.runtime_kernel.execution import MmapPayloadCodec
from app.runtime_kernel.resources import (
    ArtifactStore,
    BufferStore,
    ResourceLeaseError,
    ResourceNotFoundError,
    ResourceStore,
    StatePatch,
    StateStore,
)
from app.runtime_kernel.transport import RecordResourceHold


def test_resource_store_preserves_aliases_and_exposes_immutable_views() -> None:
    source = np.arange(6, dtype=np.float64).reshape(2, 3)
    shared = {"values": source}
    resources = ResourceStore("test-resources")

    root = resources.ingest({"first": shared, "second": shared, "array": source})
    lease = resources.acquire(root, owner="test")
    resolved = resources.resolve(root)

    assert isinstance(resolved, Mapping)
    assert resolved["first"] is resolved["second"]
    assert resolved["first"]["values"] is resolved["array"]
    assert not resolved["array"].flags.writeable
    with pytest.raises(ValueError):
        resolved["array"][0, 0] = 10.0

    source[0, 0] = 99.0
    assert resolved["array"][0, 0] == 0.0
    resources.release(lease)
    assert not resources.contains(root)
    with pytest.raises(ResourceNotFoundError):
        resources.resolve(root)


def test_releasing_one_lease_does_not_destroy_shared_resource() -> None:
    resources = ResourceStore()
    root = resources.ingest({"value": np.array([1.0, 2.0])})
    first = resources.acquire(root, owner="first")
    second = resources.acquire(root, owner="second")

    resources.release(first)
    np.testing.assert_array_equal(resources.resolve(root)["value"], [1.0, 2.0])
    assert resources.lease_count(root) == 1

    resources.release(second)
    assert not resources.contains(root)
    with pytest.raises(ResourceLeaseError):
        resources.release(second)


def test_ingest_many_preserves_array_alias_across_roots() -> None:
    resources = ResourceStore()
    values = np.array([4, 5, 6])
    mapping_ref, tensor_ref = resources.ingest_many(({"values": values}, values))
    mapping_lease = resources.acquire(mapping_ref)
    tensor_lease = resources.acquire(tensor_ref)

    assert resources.resolve(mapping_ref)["values"] is resources.resolve(tensor_ref)
    resources.release(mapping_lease)
    assert resources.contains(tensor_ref)
    resources.release(tensor_lease)
    assert not resources.contains(tensor_ref)


def test_state_revision_keeps_mmap_and_later_invocation_reuses_it() -> None:
    with BufferStore() as buffers:
        resources = ResourceStore()
        states = StateStore(resources)
        try:
            first = MmapPayloadCodec(buffers, array_threshold=1).begin_invocation()
            opened = first.decode(first.encode(np.arange(64, dtype=np.float64)))
            state = states.commit(
                states.empty,
                StatePatch().put("values", opened),
                copy_arrays=False,
            )
            first.commit()
            del opened
            gc.collect()

            original_files = buffers.files()
            assert len(original_files) == 1
            second = MmapPayloadCodec(buffers, array_threshold=1).begin_invocation()
            transport = state.to_mutable()
            second.encode(transport)
            del transport
            gc.collect()

            assert buffers.files() == original_files
            states.close()
            assert buffers.files() == original_files
            second.commit()
            gc.collect()
            assert buffers.files() == ()
        finally:
            states.close()
            resources.close()


def test_state_store_creates_immutable_revision_branches() -> None:
    states = StateStore()
    base = states.commit(
        states.empty,
        StatePatch().put("model", {"steps": [1, 2], "name": "base"}),
    )
    left = states.commit(base, StatePatch().put(("model", "name"), "left"))
    right = states.commit(base, StatePatch().delete(("model", "steps", 0)))

    assert left.parent_revision == base.revision
    assert right.parent_revision == base.revision
    assert base["model"]["name"] == "base"
    assert base["model"]["steps"] == (1, 2)
    assert left["model"]["name"] == "left"
    assert right["model"]["steps"] == (2,)
    assert states.commit(left, StatePatch()).revision == left.revision
    assert [item.revision for item in states.revisions()] == [0, 1, 2, 3]


def test_state_store_can_rollback_only_the_latest_provisional_revision() -> None:
    states = StateStore()
    base = states.commit(states.empty, StatePatch().put("base", np.ones(2)))
    provisional = states.commit(base, StatePatch().put("provisional", np.ones(4)))
    nodes_with_provisional = states.resources.stats().resource_count

    with pytest.raises(Exception, match="newest"):
        states.rollback(base)

    states.rollback(provisional)

    assert [item.revision for item in states.revisions()] == [0, 1]
    assert states.resources.stats().resource_count < nodes_with_provisional
    with pytest.raises(ValueError, match="empty"):
        states.rollback(states.empty)


def test_state_store_rejects_state_from_another_run() -> None:
    first = StateStore()
    second = StateStore()

    with pytest.raises(Exception, match="another run"):
        second.commit(first.empty, StatePatch().put("value", 1))


def test_artifacts_have_unique_provenance_and_independent_leases() -> None:
    resources = ResourceStore()
    artifacts = ArtifactStore(resources)
    root = resources.ingest(np.array([3.0, 4.0]))
    first = artifacts.publish(
        root,
        producer_task="electric",
        solver_name="dc-current-density",
        solver_version="0.2.0",
        output_name="jouleHeating",
        artifact_type="scalar-field",
        state_revision=2,
    )
    second = artifacts.publish(
        root,
        producer_task="electric",
        solver_name="dc-current-density",
        solver_version="0.2.0",
        output_name="jouleHeatingCopy",
        artifact_type="scalar-field",
        state_revision=2,
    )

    assert first.artifact_id != second.artifact_id
    assert first.provenance.producer_task == "electric"
    assert first.produced_state_revision == 2
    artifacts.validate(first, {"scalar-field"})

    artifacts.release(first)
    np.testing.assert_array_equal(artifacts.resolve(second), [3.0, 4.0])
    artifacts.release(second)
    assert not resources.contains(root)


def test_record_ack_hold_keeps_artifact_mmap_until_release() -> None:
    with BufferStore() as buffers:
        resources = ResourceStore()
        artifacts = ArtifactStore(resources)
        try:
            transaction = MmapPayloadCodec(
                buffers,
                array_threshold=1,
            ).begin_invocation()
            opened = transaction.decode(
                transaction.encode(np.arange(64, dtype=np.float64))
            )
            handle = artifacts.publish(
                {"value": opened},
                producer_task="electric",
                solver_name="dc-current-density",
                solver_version="0.2.0",
                output_name="jouleHeating",
                artifact_type="scalar-field",
                state_revision=1,
                copy_arrays=False,
            )
            transaction.commit()
            del opened
            gc.collect()

            record_lease = resources.acquire(handle.resource_ref, owner="record:packet:1")
            hold = RecordResourceHold(lambda: resources.release(record_lease))
            hold.hand_off()
            artifacts.release(handle)

            assert len(buffers.files()) == 1
            assert resources.contains(handle.resource_ref)
            hold.release()
            gc.collect()
            assert buffers.files() == ()
            assert not resources.contains(handle.resource_ref)
        finally:
            artifacts.close()
            resources.close()


@pytest.mark.asyncio
async def test_legacy_adapter_converts_full_state_to_patch() -> None:
    async def progress(_: object) -> None:
        return None

    async def legacy(invocation: SolverInvocation) -> dict[str, object]:
        return {
            "state": {"continued": invocation.state["seed"] + 1},
            "artifacts": {"field": np.array([1.0])},
            "observations": {"iterations": 4},
        }

    invocation = SolverInvocation(
        config={},
        state={"seed": 2},
        inputs={},
        world={},
        geometry=None,
        progress=progress,
        descriptor={},
    )
    adapter = LegacySolverAdapter(legacy)
    result = await adapter.run(invocation)

    assert isinstance(result, SolverResult)
    assert result.state_patch.operations[0].value == {"continued": 3}
    assert result.observations["iterations"] == 4
    implementation = SolverImplementation(abi_version=2, run=adapter.run)
    assert (await implementation(invocation)).artifacts.keys() == {"field"}


@pytest.mark.asyncio
async def test_legacy_adapter_preserves_unchanged_state_revision() -> None:
    async def progress(_: object) -> None:
        return None

    async def legacy(invocation: SolverInvocation) -> dict[str, object]:
        return {"state": invocation.state, "artifacts": {}}

    invocation = SolverInvocation({}, {"seed": 2}, {}, {}, None, progress, {})
    result = await LegacySolverAdapter(legacy)(invocation)

    assert result.state_patch.is_empty
