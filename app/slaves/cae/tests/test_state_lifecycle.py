from __future__ import annotations

import gc

import numpy as np
import pytest

from app.runtime_kernel.execution import MmapPayloadCodec
from app.runtime_kernel.resources import (
    ArtifactStore,
    BufferStore,
    ResourceLeaseError,
    ResourceScopeError,
    ResourceStore,
    StatePatch,
    StateStore,
)


def test_released_state_keeps_lineage_and_independent_branches() -> None:
    states = StateStore()
    try:
        base = states.replace(None, {"step": 1}, producer_task="initialize")
        left = states.commit(base, StatePatch().put("step", 2), producer_task="left")
        right = states.commit(base, StatePatch().put("step", 3), producer_task="right")
        metadata = base.revision_info

        states.release(base)

        assert states.revision(base.revision) is metadata
        assert metadata.producer_task == "initialize"
        assert left.parent_revision == right.parent_revision == base.revision
        assert left["step"] == 2
        assert right["step"] == 3
        assert states.commit(left, StatePatch(), producer_task="unchanged") is left
        assert left.revision_info.producer_task == "left"
        assert not states.is_live(base)
        with pytest.raises(ResourceScopeError, match="not live"):
            states.commit(base, StatePatch().put("step", 4))
        with pytest.raises(ResourceScopeError, match="not live"):
            states.handle(base.revision)
        with pytest.raises(ResourceScopeError, match="not live"):
            states.release(base)
    finally:
        states.close()


def test_released_handle_reads_fail_even_when_artifact_retains_same_root() -> None:
    resources = ResourceStore()
    states = StateStore(resources)
    artifacts = ArtifactStore(resources)
    try:
        state = states.replace(None, {"values": np.arange(8, dtype=np.float64)})
        root = state.root_ref
        handle = artifacts.publish(
            root,
            producer_task="producer",
            solver_name="producer",
            solver_version="1.0.0",
            output_name="snapshot",
            artifact_type="test/snapshot@1",
            state_revision=state.revision,
        )
        record_lease = resources.acquire(root, owner="record:test")
        escaped = state["values"]

        states.release(state)

        assert resources.contains(root)
        for read in (
            lambda: state["values"],
            lambda: len(state),
            lambda: iter(state),
            lambda: state.to_mutable(),
            lambda: state.root_ref,
        ):
            with pytest.raises(ResourceScopeError, match="not live"):
                read()
        np.testing.assert_array_equal(artifacts.resolve(handle)["values"], escaped)
        artifacts.release(handle)
        assert resources.contains(root)
        resources.release(record_lease)
        assert not resources.contains(root)
        np.testing.assert_array_equal(escaped, np.arange(8, dtype=np.float64))
    finally:
        artifacts.close()
        states.close()
        resources.close()


def test_invocation_pins_reject_release_until_all_invocations_finish() -> None:
    states = StateStore()
    try:
        state = states.replace(None, {"step": 1})
        root = state.root_ref
        first = states.acquire_invocation(state, owner="first")
        second = states.acquire_invocation(state, owner="second")

        assert states.resources.lease_count(root) == 3
        with pytest.raises(ResourceScopeError, match="active invocation"):
            states.check_releasable(state)
        with pytest.raises(ResourceScopeError, match="active invocation"):
            states.release(state)
        assert states.commit(state, StatePatch()) is state
        states.release_invocation(first)
        with pytest.raises(ResourceScopeError, match="active invocation"):
            states.release(state)
        states.release_invocation(second)

        assert states.resources.lease_count(root) == 1
        with pytest.raises(ResourceLeaseError, match="not live"):
            states.release_invocation(first)
        states.release(state)
        assert not states.resources.contains(root)
    finally:
        states.close()


def test_empty_root_release_is_noop_and_foreign_states_are_rejected() -> None:
    first = StateStore(state_store_id="same-label")
    second = StateStore(state_store_id="same-label")
    try:
        empty = first.empty
        invocation = first.acquire_invocation(empty)
        first.release(empty)
        assert first.is_live(empty)
        assert first.commit(empty, StatePatch()) is empty
        first.release_invocation(invocation)
        assert not second.is_live(empty)
        with pytest.raises(ResourceScopeError, match="another run"):
            second.release(empty)
        with pytest.raises(ResourceScopeError, match="another run"):
            second.acquire_invocation(empty)
    finally:
        first.close()
        second.close()


def test_rolled_back_handle_cannot_become_live_when_revision_and_root_are_reused() -> None:
    states = StateStore()
    try:
        stale = states.replace(None, {"step": 1})
        root = stale.root_ref
        external = states.resources.acquire(root, owner="artifact")
        states.rollback(stale)
        replacement = states.commit_ref(None, root)

        assert replacement.revision == stale.revision
        assert replacement.revision_info == stale.revision_info
        assert states.is_live(replacement)
        assert not states.is_live(stale)
        with pytest.raises(ResourceScopeError, match="not live"):
            stale["step"]
        states.resources.release(external)
    finally:
        states.close()


def test_releasing_previous_states_bounds_mmap_files_with_checkpoint_and_old_handles() -> None:
    with BufferStore() as buffers:
        resources = ResourceStore()
        states = StateStore(resources)
        history = []
        current = states.empty
        checkpoint = None
        try:
            for step in range(12):
                invocation = MmapPayloadCodec(buffers, array_threshold=1).begin_invocation()
                values = invocation.decode(
                    invocation.encode(np.full(32768, step, dtype=np.float64))
                )
                previous = current
                current = states.commit(
                    previous,
                    StatePatch().put("values", values),
                    copy_arrays=False,
                    producer_task="step",
                )
                invocation.commit()
                del values
                history.append(previous)
                if checkpoint is None:
                    checkpoint = current
                if previous is not checkpoint:
                    states.release(previous)
                gc.collect()

                assert len(buffers.files()) == (1 if current is checkpoint else 2)

            assert checkpoint is not None
            assert checkpoint["values"][0] == 0.0
            assert current["values"][0] == 11.0
            assert len(states.revisions()) == 13
            assert states.resources.stats().resource_count == 5
            assert len(history) == 12
            assert all(
                not states.is_live(handle)
                for handle in history
                if handle.revision not in {0, checkpoint.revision}
            )

            states.release(checkpoint)
            states.release(current)
            gc.collect()
            assert buffers.files() == ()
            assert states.resources.stats().resource_count == 1
            assert len(states.revisions()) == 13
        finally:
            states.close()
            resources.close()
