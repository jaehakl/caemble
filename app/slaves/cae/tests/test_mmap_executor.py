from __future__ import annotations

import asyncio
import gc
import os
import unittest

import numpy as np

from app.runtime_kernel.execution import (
    MmapPayloadCodec,
    SolverExecutionCancelled,
    SolverExecutionStartupTimeout,
    SolverPayloadError,
    SolverProcessExitedError,
    SolverExecutionTimeout,
    SpawnSolverExecutor,
)
from app.runtime_kernel.resources import BufferStore
from tests.executor_transport_fixtures import closes_request_after_bootstrap, never_starts

_FIXTURES = "tests.spawn_executor_fixtures"


class MmapPayloadCodecTests(unittest.TestCase):
    def test_small_arrays_stay_in_pickle_and_keep_aliases(self) -> None:
        store = BufferStore()
        root = store.root
        self.addCleanup(store.close)
        transaction = MmapPayloadCodec(store, array_threshold=1024).begin_invocation()
        values = np.arange(8, dtype=np.float64)

        payload = transaction.encode({"left": values, "right": values})
        decoded = transaction.decode(payload)

        self.assertEqual(store.files(), ())
        self.assertIs(decoded["left"], decoded["right"])
        self.assertNotIsInstance(decoded["left"], np.memmap)
        transaction.commit()
        store.close()
        self.assertFalse(root.exists())

    def test_large_array_descriptor_preserves_metadata_and_readonly(self) -> None:
        store = BufferStore()
        root = store.root
        self.addCleanup(store.close)
        transaction = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        values = np.arange(12, dtype=np.complex128).reshape(3, 4)
        values.flags.writeable = False

        decoded = transaction.decode(
            transaction.encode({"values": values, "alias": values})
        )

        self.assertIsInstance(decoded["values"], np.memmap)
        self.assertIs(decoded["values"], decoded["alias"])
        self.assertEqual(decoded["values"].dtype, np.dtype(np.complex128))
        self.assertEqual(decoded["values"].shape, (3, 4))
        self.assertFalse(decoded["values"].flags.writeable)
        np.testing.assert_array_equal(decoded["values"], values)
        transaction.commit()
        store.close()
        self.assertFalse(root.exists())

    def test_commit_collects_an_input_only_transaction_buffer(self) -> None:
        store = BufferStore()
        self.addCleanup(store.close)
        transaction = MmapPayloadCodec(store, array_threshold=1).begin_invocation()

        transaction.encode(np.arange(32, dtype=np.float64))

        self.assertEqual(len(store.files()), 1)
        transaction.commit()
        self.assertEqual(store.files(), ())

    def test_opened_array_reuses_descriptor_in_a_later_transaction(self) -> None:
        store = BufferStore()
        self.addCleanup(store.close)
        first = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        opened = first.decode(first.encode(np.arange(32, dtype=np.float64)))
        first.commit()
        opened.flags.writeable = False
        original_files = store.files()

        second = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        reopened = second.decode(second.encode(opened))

        self.assertEqual(store.files(), original_files)
        np.testing.assert_array_equal(reopened, opened)
        second.commit()

    def test_mutated_copy_on_write_mapping_is_published_as_a_new_buffer(self) -> None:
        store = BufferStore()
        self.addCleanup(store.close)
        first = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        opened = first.decode(first.encode(np.arange(32, dtype=np.float64)))
        first.commit()
        opened[0] = -100

        second = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        returned = second.decode(second.encode(opened))

        self.assertEqual(len(store.files()), 2)
        self.assertEqual(returned[0], -100)
        second.commit()

    def test_descriptor_reuse_preserves_resource_store_readonly_freeze(self) -> None:
        store = BufferStore()
        self.addCleanup(store.close)
        first = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        opened = first.decode(first.encode(np.arange(32, dtype=np.float64)))
        first.commit()
        opened.flags.writeable = False
        original_files = store.files()

        second = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        reopened = second.decode(second.encode(opened))

        self.assertEqual(store.files(), original_files)
        self.assertFalse(reopened.flags.writeable)
        second.commit()

    def test_sliced_mapping_is_published_with_its_own_descriptor(self) -> None:
        store = BufferStore()
        self.addCleanup(store.close)
        first = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        opened = first.decode(first.encode(np.arange(32, dtype=np.float64)))
        first.commit()

        second = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        sliced = second.decode(second.encode(opened[4:20]))

        self.assertEqual(len(store.files()), 2)
        self.assertEqual(sliced.shape, (16,))
        np.testing.assert_array_equal(sliced, np.arange(4, 20, dtype=np.float64))
        second.commit()

    def test_invocation_retain_outlives_external_and_resource_leases(self) -> None:
        store = BufferStore()
        self.addCleanup(store.close)
        first = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        opened = first.decode(first.encode(np.arange(32, dtype=np.float64)))
        lease = BufferStore.acquire_array_lease(opened, owner="tensor:test")
        self.assertIsNotNone(lease)
        first.commit()
        opened.flags.writeable = False

        second = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        second.encode(opened)
        del opened
        gc.collect()
        assert lease is not None
        BufferStore.release_array_lease(lease)

        self.assertEqual(len(store.files()), 1)
        second.commit()
        self.assertEqual(store.files(), ())

    def test_resource_lease_keeps_buffer_after_open_mapping_is_collected(self) -> None:
        store = BufferStore()
        self.addCleanup(store.close)
        transaction = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        opened = transaction.decode(transaction.encode(np.arange(32, dtype=np.float64)))
        lease = BufferStore.acquire_array_lease(opened, owner="tensor:test")
        self.assertIsNotNone(lease)
        transaction.commit()
        mmap = opened._mmap

        del opened
        gc.collect()

        self.assertTrue(mmap.closed)
        self.assertEqual(len(store.files()), 1)
        assert lease is not None
        BufferStore.release_array_lease(lease)
        self.assertEqual(store.files(), ())

    def test_last_open_mapping_collection_unlinks_committed_buffer(self) -> None:
        store = BufferStore()
        self.addCleanup(store.close)
        transaction = MmapPayloadCodec(store, array_threshold=1).begin_invocation()
        opened = transaction.decode(transaction.encode(np.arange(32, dtype=np.float64)))
        transaction.commit()
        mmap = opened._mmap

        del opened
        gc.collect()

        self.assertTrue(mmap.closed)
        self.assertEqual(store.files(), ())

    def test_plain_array_has_no_buffer_lease(self) -> None:
        self.assertIsNone(
            BufferStore.acquire_array_lease(np.arange(4, dtype=np.float64))
        )


class MmapSpawnExecutorTests(unittest.IsolatedAsyncioTestCase):
    def _executor(self) -> tuple[BufferStore, SpawnSolverExecutor]:
        store = BufferStore()
        self.addCleanup(store.close)
        codec = MmapPayloadCodec(store, array_threshold=1)
        return store, SpawnSolverExecutor(codec=codec, cancellation_grace=0.05)

    async def test_child_result_is_adopted_and_parent_close_removes_files(self) -> None:
        store, executor = self._executor()
        root = store.root
        source = np.arange(128, dtype=np.float64)

        result = await executor.execute(
            f"{_FIXTURES}:mmap_roundtrip",
            {"left": source, "right": source},
        )

        self.assertTrue(result["inputAlias"])
        self.assertEqual(result["inputFirst"], -100)
        self.assertEqual(source[0], 0)
        self.assertIsInstance(result["readonly"], np.memmap)
        self.assertIs(result["readonly"], result["readonlyAlias"])
        self.assertFalse(result["readonly"].flags.writeable)
        self.assertEqual(result["readonly"].dtype, np.dtype(np.float32))
        self.assertEqual(result["readonly"].shape, (4, 6))
        self.assertTrue(result["writable"].flags.writeable)
        self.assertTrue(result["writable"].flags.f_contiguous)
        self.assertNotEqual(result["pid"], os.getpid())
        self.assertGreater(len(store.files()), 0)

        store.close()
        self.assertFalse(root.exists())

    async def test_validator_exception_rolls_back_provisional_result(self) -> None:
        store, executor = self._executor()
        source = np.arange(128, dtype=np.float64)

        with self.assertRaisesRegex(ValueError, "schema rejected"):
            async with await executor.execute_transaction(
                f"{_FIXTURES}:mmap_roundtrip",
                {"left": source, "right": source},
            ) as transaction:
                self.assertEqual(transaction.status, "provisional")
                self.assertGreater(len(store.files()), 0)
                self.assertIsInstance(transaction.value["readonly"], np.memmap)
                raise ValueError("schema rejected the solver result")

        self.assertEqual(transaction.status, "rolled_back")
        self.assertEqual(store.files(), ())
        self.assertFalse(transaction.rollback())

    async def test_explicit_commit_keeps_result_until_run_store_close(self) -> None:
        store, executor = self._executor()
        root = store.root
        source = np.arange(128, dtype=np.float64)
        transaction = await executor.execute_transaction(
            f"{_FIXTURES}:mmap_roundtrip",
            {"left": source, "right": source},
        )

        self.assertEqual(transaction.status, "provisional")
        self.assertTrue(transaction.commit())
        self.assertEqual(transaction.status, "committed")
        self.assertFalse(transaction.commit())
        self.assertFalse(transaction.rollback())
        self.assertGreater(len(store.files()), 0)

        store.close()
        self.assertFalse(root.exists())

    async def test_child_crash_rolls_back_all_invocation_files(self) -> None:
        store, executor = self._executor()

        with self.assertRaises(SolverProcessExitedError) as raised:
            await executor.execute(
                f"{_FIXTURES}:crashes_process",
                {"values": np.arange(1024, dtype=np.float64)},
            )

        self.assertEqual(raised.exception.exit_code, 23)
        self.assertEqual(store.files(), ())

    async def test_timeout_rolls_back_all_invocation_files(self) -> None:
        store, executor = self._executor()

        with self.assertRaises(SolverExecutionTimeout):
            await executor.execute(
                f"{_FIXTURES}:blocks_forever",
                {"values": np.arange(1024, dtype=np.float64)},
                timeout=0.1,
            )

        self.assertEqual(store.files(), ())

    async def test_request_send_failure_rolls_back_all_invocation_files(self) -> None:
        store, executor = self._executor()
        executor._child_target = closes_request_after_bootstrap

        with self.assertRaises((SolverPayloadError, SolverProcessExitedError)):
            await executor.execute(
                "unused:solver",
                {"values": np.arange(1024, dtype=np.float64)},
            )

        self.assertEqual(store.files(), ())

    async def test_startup_timeout_rolls_back_all_invocation_files(self) -> None:
        store, executor = self._executor()
        executor.CHILD_STARTUP_TIMEOUT_SECONDS = 0.1
        executor._child_target = never_starts

        with self.assertRaises(SolverExecutionStartupTimeout):
            await executor.execute(
                "unused:solver",
                {"values": np.arange(1024, dtype=np.float64)},
            )

        self.assertEqual(store.files(), ())

    async def test_startup_cancel_rolls_back_all_invocation_files(self) -> None:
        store, executor = self._executor()
        executor._child_target = never_starts
        cancellation = asyncio.Event()
        task = asyncio.create_task(
            executor.execute(
                "unused:solver",
                {"values": np.arange(1024, dtype=np.float64)},
                cancellation=cancellation,
            )
        )
        await asyncio.sleep(0.1)
        cancellation.set()

        with self.assertRaises(SolverExecutionCancelled):
            await task

        self.assertEqual(store.files(), ())

    async def test_repeated_children_leave_only_run_scoped_files(self) -> None:
        store, executor = self._executor()
        root = store.root
        child_pids: set[int] = set()
        for offset in range(3):
            source = np.arange(128, dtype=np.float64) + offset
            result = await executor.execute(
                f"{_FIXTURES}:mmap_roundtrip",
                {"left": source, "right": source},
            )
            child_pids.add(result["pid"])

        self.assertEqual(len(child_pids), 3)
        self.assertGreater(len(store.files()), 0)
        store.close()
        self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
