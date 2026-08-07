import pytest

from app.errors import CaeError
from app.solver_framework.validation import normalize_parameter_value


def float_spec(unit, quantity_kind, **extra):
    return {
        "dtype": "float64",
        "unit": unit,
        "quantityKind": quantity_kind,
        "tensorOrder": 0,
        **extra,
    }


def float_value(value, unit, quantity_kind, **extra):
    return {
        "dtype": "float64",
        "value": value,
        "unit": unit,
        "quantityKind": quantity_kind,
        **extra,
    }


@pytest.mark.parametrize(
    ("value", "source_unit", "target_unit", "quantity_kind", "expected"),
    [
        (1, "mm", "m", "Length", 0.001),
        (1, "mV", "V", "electromagnetism.Voltage", 0.001),
        (1, "%", "{fraction}", "DimensionlessRatio", 0.01),
        (0, "Cel", "K", "thermodynamics.Temperature", 273.15),
    ],
)
def test_normalizes_compatible_ucum_units(
    value,
    source_unit,
    target_unit,
    quantity_kind,
    expected,
):
    normalized = normalize_parameter_value(
        float_value(value, source_unit, quantity_kind),
        float_spec(target_unit, quantity_kind),
        "task solve.parameters.value",
    )

    assert normalized == {
        "dtype": "float64",
        "value": pytest.approx(expected),
        "unit": target_unit,
        "quantityKind": quantity_kind,
    }


def test_normalizes_parameter_value_and_axis_ticks_before_range_validation():
    normalized = normalize_parameter_value(
        float_value(
            [1000, 500],
            "mV",
            "electromagnetism.Voltage",
            axes=[
                {
                    "name": "position",
                    "length": 2,
                    "unit": "cm",
                    "quantityKind": "Length",
                    "ticks": [0, 10],
                }
            ],
        ),
        {
            **float_spec(
                "V",
                "electromagnetism.Voltage",
                minimum=0,
                maximum=1,
            ),
            "axes": [
                {
                    "name": "position",
                    "length": 2,
                    "unit": "m",
                    "quantityKind": "Length",
                }
            ],
        },
        "task solve.parameters.voltageProfile",
    )

    assert normalized["value"] == pytest.approx([1, 0.5])
    assert normalized["axes"] == [
        {
            "name": "position",
            "length": 2,
            "unit": "m",
            "quantityKind": "Length",
            "ticks": pytest.approx([0, 0.1]),
        }
    ]


def test_normalizes_tensor_value_in_the_global_identity_basis():
    basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    normalized = normalize_parameter_value(
        float_value(
            [[2, 0, 0], [0, 2, 0], [0, 0, 2]],
            "S.cm-1",
            "electromagnetism.ElectricConductivity",
            basis=basis,
        ),
        {
            **float_spec(
                "S.m-1",
                "electromagnetism.ElectricConductivity",
                basis=basis,
            ),
            "tensorOrder": 2,
        },
        "task solve.parameters.conductivity",
    )

    assert normalized["value"] == [[200, 0, 0], [0, 200, 0], [0, 0, 200]]
    assert normalized["basis"] == basis


@pytest.mark.parametrize(
    ("value", "spec", "message"),
    [
        (
            {**float_value(1, "V", "electromagnetism.Voltage"), "dtype": "float32"},
            float_spec("V", "electromagnetism.Voltage"),
            "does not match manifest dtype",
        ),
        (
            float_value(
                [1],
                "V",
                "electromagnetism.Voltage",
                axes=[{"length": 1}],
            ),
            {
                **float_spec("V", "electromagnetism.Voltage"),
                "axes": [{"length": 2}],
            },
            "axes\\[0\\]\\.length must be 2",
        ),
        (
            float_value(1001, "mV", "electromagnetism.Voltage"),
            float_spec("V", "electromagnetism.Voltage", maximum=1),
            "must be at most 1",
        ),
    ],
)
def test_validates_dtype_shape_and_range_after_unit_conversion(value, spec, message):
    with pytest.raises(CaeError, match=message):
        normalize_parameter_value(value, spec, "task solve.parameters.value")


@pytest.mark.parametrize(
    ("value", "message"),
    [
        (
            float_value(1, "s", "electromagnetism.Voltage"),
            r"task solve\.parameters\.voltage\.value\.unit 's' is not convertible to manifest unit 'V'",
        ),
        (
            float_value(1, "not-a-unit", "electromagnetism.Voltage"),
            r"task solve\.parameters\.voltage\.value\.unit 'not-a-unit' is not convertible",
        ),
        (
            float_value(1, "V", "Power"),
            r"task solve\.parameters\.voltage\.quantityKind 'Power' does not match manifest quantityKind",
        ),
    ],
)
def test_reports_path_rich_unit_and_quantity_errors(value, message):
    with pytest.raises(CaeError, match=message) as error:
        normalize_parameter_value(
            value,
            float_spec("V", "electromagnetism.Voltage"),
            "task solve.parameters.voltage",
        )

    assert error.value.code in {"invalid_task", "invalid_unit"}
