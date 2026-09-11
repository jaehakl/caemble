from types import SimpleNamespace
from unittest.mock import AsyncMock

import numpy as np
import pytest

from app.solvers.fdtd.detectors import TimeDetector, prepare_detectors
from app.solvers.fdtd.setup import detector_indices


@pytest.mark.parametrize("scale", [1., 1e-6])
@pytest.mark.asyncio
async def test_nearest_detector_records_selected_cell_coordinates_and_boundaries(monkeypatch, scale):
    bounds = tuple((lo * scale, hi * scale) for lo, hi in ((0, 4), (0, 4), (1.9, 2.1)))
    core = ((0., 4 * scale),) * 3
    ticks = (tuple(value * scale for value in (-1, 1, 3, 5)),) * 3
    edges = (tuple(value * scale for value in (-2, 0, 2, 4, 6)),) * 3
    domain = SimpleNamespace(core_bounds=core, cell_ticks=ticks, boundary_ticks=edges)
    invocation = SimpleNamespace(world={}, config={"outputs": [{
        "methodId": "fdtd.time-electric-field", "key": "field", "parameters": {
            "strideX": 2, "strideY": 1, "strideZ": 3, "timeStride": 1,
        },
    }]})
    monkeypatch.setattr("app.solvers.fdtd.detectors.task_scene", lambda _: {})
    monkeypatch.setattr("app.solvers.fdtd.detectors._target_part", lambda *args: {})
    monkeypatch.setattr("app.solvers.fdtd.detectors.axis_aligned_box_bounds", AsyncMock(return_value=bounds))
    plan, = await prepare_detectors(invocation, SimpleNamespace(domain=domain))
    # Z is halfway between core centers: select the lower coordinate, index 1.
    assert plan.region.z.tolist() == [1]
    assert plan.region.x.tolist() == [1]  # Existing stride stays in effect.
    assert plan.region.y.tolist() == [1, 2]
    assert plan.region.bounds == ((0., 2 * scale), bounds[1], bounds[0])
    detector = TimeDetector(plan.key, plan.artifact_type, plan.field_kind, plan.region, 1)
    detector.times = [0.]
    detector.samples = [np.zeros((1, 2, 1, 3), dtype=np.float32)]
    field = detector.artifact()
    assert field.domain.shape == (1, 2, 1)
    assert field.values.shape == (1, 1, 2, 1, 3)
    assert field.domain.axes[0].tolist() == [scale]
    assert field.domain.metadata["bounds"] == plan.region.bounds
    assert field.metadata["sampleAxes"][0]["ticks"].tolist() == [0.]



def test_nearest_selection_excludes_pml_and_rejects_detectors_outside_core():
    core = ((0., 4.),) * 3
    ticks = ((-0.01, 1., 3., 5.),) * 3
    bounds = ((0., 4.), (0., 4.), (0.01, 0.02))
    selected = detector_indices(bounds, core, ticks, (1, 1, 1), "detector", nearest_core_cell=True)
    assert selected[2].tolist() == [1]  # PML center -0.01 is closer, but ineligible.
    with pytest.raises(ValueError, match="outside PML"):
        detector_indices((bounds[0], bounds[1], (-0.01, 0.02)), core, ticks, (1, 1, 1), "detector", nearest_core_cell=True)
    with pytest.raises(ValueError, match="does not contain"):
        detector_indices(bounds, core, ticks, (1, 1, 1), "source")


def test_existing_samples_and_stride_are_unchanged():
    core = ((0., 8.),) * 3
    ticks = ((-1., 1., 3., 5., 7., 9.),) * 3
    bounds = ((0.5, 7.5),) * 3
    strict = detector_indices(bounds, core, ticks, (2, 1, 3), "detector")
    nearest = detector_indices(bounds, core, ticks, (2, 1, 3), "detector", nearest_core_cell=True)
    assert [axis.tolist() for axis in nearest] == [[1, 3], [1, 2, 3, 4], [1, 4]]
    for expected, actual in zip(strict, nearest, strict=True):
        np.testing.assert_array_equal(expected, actual)
