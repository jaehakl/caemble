import math

import pytest
from pydantic import ValidationError

from models import MaterialParameterBase


def material_parameter(**overrides):
    return MaterialParameterBase.model_validate(
        {
            "material_id": 7,
            "name": "optical.refractive_index",
            "value": {"dtype": "float64", "value": 1.5, "unit": "{fraction}"},
            **overrides,
        }
    )


def test_material_parameter_frequency_is_positive_finite_hz_value():
    assert material_parameter(frequency=None).frequency is None
    assert material_parameter(frequency=5e14).frequency == 5e14

    for invalid in (0, -1, math.inf, math.nan):
        with pytest.raises(ValidationError):
            material_parameter(frequency=invalid)
