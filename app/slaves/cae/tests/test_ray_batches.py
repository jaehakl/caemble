from collections import deque
from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from app.solvers.ray_tracing import formulation
from app.solvers.ray_tracing.outputs import PathCollector


def test_batch_path_order_reproduces_original_queue_including_touch_and_multiple_finishes(monkeypatch):
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
    expected = PathCollector(13)
    queue = deque(deepcopy(rays))
    while queue:
        queue.extend(step(queue.popleft(), expected, {}))
    actual = PathCollector(13)
    # Completion order differs from queue order and from batch order.
    for offset in (12, 6, 18, 0):
        actual.merge(formulation.trace_batch(prepared, (offset, deepcopy(rays[offset:offset + 6]))))
    assert [r.identity for r in actual.paths] == [r.identity for r in expected.paths]
    assert actual.detected_power == expected.detected_power


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
