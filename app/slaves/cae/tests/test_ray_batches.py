from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from app.solvers.ray_tracing import formulation
from app.solvers.ray_tracing.outputs import PathCollector


def test_path_sample_is_independent_of_batch_partition_and_completion_order(monkeypatch):
    def step(ray, *args):
        collector = args[-2]
        ray.turn += 1
        if ray.turn < ray.stop:
            if ray.turn == 1 and ray.identity % 3 == 0:
                branch = deepcopy(ray)
                branch.identity += 1000
                return [ray, branch]
            return [ray]
        collector.finish(ray)
        if ray.identity % 2 == 0:
            branch = deepcopy(ray)
            branch.identity += 2000
            collector.finish(branch)
        collector.detected_power += ray.identity
        return []

    monkeypatch.setattr(formulation, "_trace_one", step)
    rays = [SimpleNamespace(identity=i, turn=0, stop=1 + i % 5, source_power=1,
                            vertices=[np.zeros(3), np.ones(3)]) for i in range(19)]
    prepared = formulation.PreparedTrace(None, {}, {}, {}, {}, {}, {}, 10, 13, 0, 1, {}, [])
    expected = formulation.trace_batch(prepared, (0, deepcopy(rays)))
    for width, offsets in [(6, (12, 6, 18, 0)), (4, (16, 0, 12, 4, 8))]:
        actual = PathCollector(13, seed=1)
        for offset in offsets:
            batch = formulation.trace_batch(prepared, (offset, deepcopy(rays[offset:offset + width])))
            actual.merge(batch)
            # Transferred batch values must not remain borrowed by the collector.
            for path in batch.paths:
                path.vertices[0][:] = 999
        assert [r.identity for r in actual.paths] == [r.identity for r in expected.paths]
        assert actual.detected_power == expected.detected_power
        assert all(np.all(path.vertices[0] == 0) for path in actual.paths)


def test_completed_paths_are_sampled_without_early_finish_or_power_preference():
    samples = []
    for limit, order in [(8, range(100)), (8, reversed(range(100))), (16, range(100))]:
        collector = PathCollector(limit, seed=17)
        for identity in order:
            collector.current_order = (identity % 7, identity, (0,) * (identity % 7))
            collector.finish_index = 0
            collector.finish(SimpleNamespace(identity=identity, vertices=[np.zeros(3), np.ones(3)]))
            assert len(collector.retained) <= limit
        samples.append([path.identity for path in collector.paths])
    assert samples[0] == samples[1]
    assert samples[0] == samples[2][:8]
    assert any(identity >= 50 for identity in samples[0])
    assert len(set(samples[0])) == 8


def test_zero_path_limit_does_not_hash_or_retain_paths(monkeypatch):
    from app.solvers.ray_tracing import outputs

    def forbidden(*args, **kwargs):
        raise AssertionError('maxPaths=0 must skip sampling')
    monkeypatch.setattr(outputs.hashlib, 'blake2b', forbidden)
    collector = PathCollector(0)
    collector.finish(SimpleNamespace(vertices=[np.zeros(3), np.ones(3)]))
    assert collector.paths == []
    assert collector.bundle().members['pathOffsets']['value'].tolist() == [0]


def test_path_limit_does_not_stop_physical_accumulation(monkeypatch):
    def step(ray, *args):
        collector = args[-2]
        collector.detected_power += 1
        collector.finish(ray)
        return []
    monkeypatch.setattr(formulation, "_trace_one", step)
    rays = [SimpleNamespace(source_power=1, vertices=[np.zeros(3), np.ones(3)]) for _ in range(9)]
    prepared = formulation.PreparedTrace(None, {}, {}, {}, {}, {}, {}, 10, 0, 0, 1, {}, [])
    collector = formulation.trace_batch(prepared, (0, rays))
    assert collector.paths == []
    assert collector.detected_power == 9


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [0, 127, 511])
async def test_small_trace_never_requests_a_pool(monkeypatch, count):
    def forbidden(*args, **kwargs):
        raise AssertionError("small trace requested a pool")
    execution = SimpleNamespace(batch_workers=forbidden, map_batches=forbidden)
    context = SimpleNamespace(execution=execution, progress=None, cancellation=None)
    monkeypatch.setattr(formulation, "prepare_trace", lambda *args: SimpleNamespace(maximum_paths=0))
    monkeypatch.setattr(formulation, "trace_batch", lambda plan, batch, token: PathCollector(0, detected_power=len(batch[1])))
    result = await formulation.trace_rays(context, {}, None, {}, [None] * count, [], 42)
    assert result.detected_power == count
