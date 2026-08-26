import pytest

from app.errors import CaeError
from app.runtime import _validate_material_snapshot, _validate_scene, _validate_variables
from app.solver_framework.geometry import canonical_geometry_hash
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


def test_variable_schema_validation_rejects_range_shape_keys_and_boolean_values():
    cases = [
        ({"width": 11}, {"width": {"min": 1, "max": 10}}),
        ({"width": [4]}, {"width": {"min": 1, "max": 10}}),
        ({"width": 4, "extra": 1}, {"width": {"min": 1, "max": 10}}),
        ({"width": True}, {"width": {"min": 1, "max": 10}}),
    ]

    for variables, schema in cases:
        with pytest.raises(CaeError) as error:
            _validate_variables(variables, schema, "Built Experiment")
        assert error.value.code == "invalid_input"


def test_material_snapshot_validation_rejects_provenance_and_tensor_errors():
    cases = [
        ("source", 7),
        ("materialId", True),
        (
            "value",
            {
                "dtype": "float16",
                "value": [[70000, 0, 0], [0, 70000, 0], [0, 0, 70000]],
                "unit": "S.m-1",
            },
        ),
    ]

    for field, value in cases:
        entry = {
            "origin": "source",
            "value": {
                "dtype": "float64",
                "value": [[5.96e7, 0, 0], [0, 5.96e7, 0], [0, 0, 5.96e7]],
                "unit": "S.m-1",
            },
            "source": "reference",
            "version": "1",
            "materialId": None,
            "materialParameterId": None,
        }
        entry[field] = value
        with pytest.raises(CaeError) as error:
            _validate_material_snapshot(
                {"schemaVersion": 1, "materials": {"Copper": {"electrical.conductivity": entry}}},
                "start.measurement.materialParameters",
            )
        assert error.value.code == "invalid_input"


def test_canonical_scene_accepts_a_named_material_role_and_rejects_legacy_meshes():
    root = {
        "id": "wheel.tire",
        "materialRole": "tire",
        "node": {
            "kind": "primitive",
            "nodeId": "wheel.tire",
            "primitive": "box",
            "parameters": {"size": [1, 1, 1]},
        },
    }
    draft = {
        "geometryFormatVersion": 2,
        "lengthUnit": "m",
        "roots": [root],
        "geometryGroups": [],
        "surfaceGroups": [],
    }
    scene = {**draft, "geometryHash": canonical_geometry_hash(draft)}
    _validate_scene(scene, "Built Experiment.scene")

    for invalid in ("", 7):
        with pytest.raises(CaeError) as error:
            _validate_scene(
                {**scene, "roots": [{**root, "materialRole": invalid}]},
                "Built Experiment.scene",
            )
        assert error.value.code == "invalid_input"

    with pytest.raises(CaeError, match="CanonicalGeometrySceneV2"):
        _validate_scene(
            {
                "sceneHash": "c" * 64,
                "lengthUnit": "m",
                "parts": [],
                "tree": {},
                "geometryGroups": [],
                "surfaceGroups": [],
            },
            "Built Experiment.scene",
        )
