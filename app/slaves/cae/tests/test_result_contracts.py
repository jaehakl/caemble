from types import SimpleNamespace
from unittest.mock import AsyncMock

import numpy as np
import pytest

from app.kernel.api.errors import CaeError
from app.kernel.coordinator import SimulationApi
from app.kernel.coordinator.plan import RunPlan


@pytest.mark.asyncio
async def test_record_binding_rejects_same_shape_wrong_producer_and_released_artifacts():
    contract = {"task": "solid", "output": "force", "solver": {"name": "fixture", "version": "1.0.0"}, "artifactType": "fixture/force@1"}
    host = SimpleNamespace(plan=RunPlan({}, {}, {}, {"arbitraryName": {"dtype": "float64"}}, {"arbitraryName": contract}),
                           run_id="record-binding", record=AsyncMock())
    sim = SimulationApi(host)
    try:
        handles = []
        for task, output in [("solid", "force"), ("optics", "force"), ("solid", "different")]:
            handles.append(sim._artifacts.publish(np.asarray(3.0), producer_task=task, solver_name="fixture",
                solver_version="1.0.0", output_name=output, artifact_type="fixture/force@1", state_revision=0))
        for wrong in [handles[1], handles[2], np.asarray(3.0)]:
            with pytest.raises(CaeError, match="artifact"):
                await sim.record("arbitraryName", wrong)
        host.record.assert_not_awaited()
        await sim.record("arbitraryName", handles[0])
        host.record.assert_awaited_once()
        hold = host.record.await_args.kwargs["resource_hold"]
        sim.release(handles[0])
        with pytest.raises(CaeError, match="live output artifact"):
            await sim.record("arbitraryName", handles[0])
        hold.release()
    finally:
        sim.close()
