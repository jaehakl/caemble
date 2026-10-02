"""Small accepted-history and mmap contracts without product execution."""

import numpy as np
import pytest


@pytest.mark.parametrize("axis", [0, 3])
def test_accepted_history_coalescing_preserves_values_and_uses_mmap(axis):
    from app.kernel.execution import MmapPayloadCodec
    from app.kernel.resources.buffers import BufferStore
    from app.methods.fields.history import append_history_chunk

    shape = (1, 8192, 3) if axis == 0 else (1, 1, 1, 1, 8192, 1, 3)
    previous = tuple(np.full(shape, index, dtype=float) for index in range(32))
    for chunk in previous:
        chunk.flags.writeable = False
    sample = np.full(shape, 32.)
    chunks = append_history_chunk(previous, sample, axis=axis)
    expected = np.concatenate((*previous, sample), axis=axis)
    sample.fill(-1)
    np.testing.assert_array_equal(np.concatenate(chunks, axis=axis), expected)
    for index, chunk in enumerate(previous):
        assert not chunk.flags.writeable and np.all(chunk == index)
    resumed = append_history_chunk(chunks, np.full(shape, 33.), axis=axis)
    assert resumed[0] is chunks[0]
    store = BufferStore()
    codec = MmapPayloadCodec(store).begin_invocation()
    try:
        unpacked_size = len(codec.encode(previous))
        payload = codec.encode(chunks)
        assert len(payload) < 1024 * 1024 and len(payload) < unpacked_size / 4
        decoded = codec.decode(payload)
        assert any(isinstance(chunk, np.memmap) for chunk in decoded)
        np.testing.assert_array_equal(np.concatenate(decoded, axis=axis), expected)
    finally:
        codec.rollback()
        store.close()
    assert not store.root.exists()

