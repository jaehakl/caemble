from types import SimpleNamespace
from unittest.mock import AsyncMock

import numpy as np
import pytest

from app.solvers.fdtd.detectors import TimeDetector, prepare_detectors
from app.solvers.fdtd.setup import detector_indices


@pytest.mark.parametrize("scale", [1., 1e-6])
@pytest.mark.asyncio
async def test_box_without_cell_centers_interpolates_requested_coordinates(scale):
    import torch
    from tests.test_box_grid_outputs import data, grid
    core = ((0., 4 * scale),) * 3
    ticks = (np.array([-1., 1., 3., 5.]) * scale,) * 3
    domain = SimpleNamespace(core_bounds=core, cell_ticks=ticks)
    probe = grid(shape=(2, 2, 1), origin=(0, 0, 1.9 * scale), size=(4 * scale, 4 * scale, .2 * scale))
    profile = data(("x", "y", "z"))
    profile["dtype"] = "float32"
    definition = {"methodId": "fdtd.time-electric-field", "artifactType": "test-field", "data": profile}
    invocation = SimpleNamespace(descriptor={"methods": {"outputs": [definition]}}, config={"outputs": [{
        "methodId": definition["methodId"], "key": "field", "parameters": {"timeStride": 1}, "boxGrid": probe.geometry,
    }]})
    plan, = await prepare_detectors(invocation, SimpleNamespace(domain=domain))
    z, y, x = np.meshgrid(*ticks, indexing="ij")
    vector = np.stack((x, y, z)) / scale
    detector = TimeDetector(plan.key, plan.artifact_type, plan.field_kind, plan.region, 1)
    detector.capture(0, 0., torch.from_numpy(vector.astype(np.float32)), final=True)
    field = detector.artifact()
    assert field["value"].shape == (2, 2, 1, 1, 1, 1, 3)
    np.testing.assert_allclose(field["value"][..., 0, 0, 0, :], probe.points() / scale, rtol=1e-6)
    assert field["axes"][2]["ticks"].tolist() == pytest.approx([.1 * scale])
    assert field["boxGrid"]["origin"] == list(probe.geometry["origin"])


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
