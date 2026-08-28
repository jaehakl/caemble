import math
from typing import Any


def validate_calculation_data_axis(value: Any) -> Any:
    if any(isinstance(tick, bool) or not math.isfinite(tick) for tick in value.ticks):
        raise ValueError("CalculationData axis ticks must be finite numbers.")
    return value


def validate_calculation_data_output(value: Any) -> Any:
    if len(value.shape) > 2:
        raise ValueError("CalculationData output rank must be between 0 and 2.")
    if any(isinstance(length, bool) or length < 0 for length in value.shape):
        raise ValueError("CalculationData shape lengths must be non-negative integers.")
    if len(value.axes) != len(value.shape):
        raise ValueError("CalculationData axes must match output rank.")
    for index, axis in enumerate(value.axes):
        if len(axis.ticks) != value.shape[index]:
            raise ValueError("CalculationData axis ticks must match output shape.")

    values = value.data if isinstance(value.data, list) else [value.data]
    expected = math.prod(value.shape) if value.shape else 1
    if expected > 5_000_000:
        raise ValueError("CalculationData output exceeds the element limit.")
    if (
        len(values) != expected
        or (value.shape and not isinstance(value.data, list))
        or (not value.shape and isinstance(value.data, list))
    ):
        raise ValueError("CalculationData data must match output shape.")
    if any(
        isinstance(item, bool)
        or not isinstance(item, (int, float))
        or not math.isfinite(item)
        for item in values
    ):
        raise ValueError("CalculationData values must be finite numbers.")

    integer_ranges = {
        "int8": (-128, 127),
        "int16": (-32768, 32767),
        "int32": (-2147483648, 2147483647),
        "uint8": (0, 255),
        "uint16": (0, 65535),
        "uint32": (0, 4294967295),
    }
    bounds = integer_ranges.get(value.dtype)
    if bounds and any(
        not isinstance(item, int) or not bounds[0] <= item <= bounds[1]
        for item in values
    ):
        raise ValueError(f"CalculationData values must fit {value.dtype}.")
    if value.dtype == "float32" and any(
        abs(item) > 3.4028234663852886e38 for item in values
    ):
        raise ValueError("CalculationData values must fit float32.")
    return value


def validate_calculation_data_selectors(
    calculation_id: int | None,
    measurement_id: int | None,
) -> None:
    if calculation_id is not None and measurement_id is not None:
        raise ValueError("calculation_id and measurement_id cannot be combined.")
