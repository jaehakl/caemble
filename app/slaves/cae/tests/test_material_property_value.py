import numpy as np
import pytest

from app.runtime_kernel.api.world import material_property_value, material_scalar


@pytest.mark.parametrize("shape", [(9,), (3, 3)])
def test_material_value_preserves_tensor_and_legacy_diagonal_mean(shape: tuple[int, ...]) -> None:
    values = np.array([2, 7, 8, 9, 4, 10, 11, 12, 6], dtype=np.float64).reshape(shape)
    world = {"materials": {"experiment": {"parameters": {"materials": {
        "sample": {"conductivity": {"value": {"value": values, "unit": "S.cm-1"}}},
    }}}}}
    descriptor = {"materials": [{"properties": {"conductivity": {"data": {"unit": "S.m-1"}}}}]}
    part = {"material": {"name": "sample"}}

    converted = material_property_value(world, part, descriptor, "conductivity")

    assert converted.shape == shape
    np.testing.assert_array_equal(converted, values * 100)
    np.testing.assert_array_equal(world["materials"]["experiment"]["parameters"]["materials"]["sample"]["conductivity"]["value"]["value"], values)
    assert material_scalar(world, part, descriptor, "conductivity") == 400.0
