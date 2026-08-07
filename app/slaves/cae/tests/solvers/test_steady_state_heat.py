import numpy as np
import pytest

from app.errors import CaeError
from app.solver_framework.models import VoxelDomain
from app.solver_framework.numerics.voxel import axis_ticks
from app.solvers.steady_state_heat.solver import _volume_source


def domain():
    shape = (3, 3, 3)
    return VoxelDomain(
        shape,
        np.array([1.0, 0.0, 0.0]),
        3.0,
        -1.5,
        -1.5,
        1.0,
        1.0,
        1.0,
        np.ones(np.prod(shape), dtype=np.uint8),
        np.prod(shape),
    )


def test_heat_source_conversion_and_axis_contract_are_solver_owned():
    voxel_domain = domain()
    ticks = axis_ticks(voxel_domain)
    artifact = {
        "value": np.ones((3, 3, 3)),
        "axes": [{"ticks": ticks[0]}, {"ticks": ticks[1]}, {"ticks": ticks[2]}],
    }

    assert _volume_source(artifact, voxel_domain, 2.0) == pytest.approx(np.full(27, 0.5))

    artifact["axes"][0]["ticks"] = [0.0, 1.0, 2.0]
    with pytest.raises(CaeError) as error:
        _volume_source(artifact, voxel_domain, 2.0)
    assert error.value.code == "invalid_input"
