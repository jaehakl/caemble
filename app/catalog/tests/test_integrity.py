from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from caemble_catalog import Catalog, CatalogIntegrityError
from caemble_catalog.admin import create_draft, validate_database, writable_connection
from caemble_catalog.validation import OPAQUE_QUANTITY_KINDS


@pytest.fixture
def draft(tmp_path: Path) -> Path:
    path = tmp_path / "draft.sqlite3"
    create_draft(path)
    return path


@pytest.mark.parametrize(
    ("statement", "parameters", "message"),
    [
        (
            "DELETE FROM quantity_kind_units WHERE quantity_kind = ?",
            ("Absorptance",),
            "must have at least one applicable unit",
        ),
        (
            "UPDATE quantity_kinds SET opaque = 1 WHERE name = ?",
            ("Absorptance",),
            "opaque QuantityKind policy mismatch",
        ),
        (
            "UPDATE quantity_kind_units SET unit = 's' WHERE quantity_kind = 'Length' AND ordinal = 0",
            (),
            "not bidirectionally UCUM-convertible",
        ),
        (
            "UPDATE quantity_kind_units SET unit = 'not-a-unit' WHERE quantity_kind = 'Length' AND ordinal = 0",
            (),
            "not bidirectionally UCUM-convertible",
        ),
        (
            "UPDATE quantity_kinds SET domain = 'general' WHERE name = 'mechanics.Force'",
            (),
            "must not have a domain prefix",
        ),
        (
            "UPDATE quantity_kinds SET tensor_order = 5 WHERE name = 'Length'",
            (),
            "tensorOrder must be a safe integer from 0 through 4",
        ),
        (
            "UPDATE quantity_kinds SET description = ' bad  text ' WHERE name = 'Length'",
            (),
            "description must be non-empty, trimmed",
        ),
        (
            "UPDATE material_parameters SET key = 'general.Bad-Key' WHERE key = 'general.mass_density'",
            (),
            "must match a reviewed domain.property name",
        ),
        (
            "UPDATE material_parameters SET domain = 'thermal' WHERE key = 'general.mass_density'",
            (),
            "domain column does not match",
        ),
        (
            "INSERT INTO material_parameter_qualifiers VALUES ('general.mass_density', 0, 'Bad qualifier')",
            (),
            "invalid qualifier",
        ),
        (
            "UPDATE material_models SET key = 'model.Bad.relation' WHERE key = 'model.sorption.isotherm'",
            (),
            "must match model.namespace.relation",
        ),
        (
            "UPDATE material_models SET output_name = input_name WHERE key = 'model.sorption.isotherm'",
            (),
            "input and output names must differ",
        ),
    ],
)
def test_validate_rejects_invalid_catalog_content(
    draft: Path, statement: str, parameters: tuple[object, ...], message: str
):
    with writable_connection(draft) as connection:
        connection.execute(statement, parameters)
    with pytest.raises(CatalogIntegrityError, match=message):
        validate_database(draft)


def test_validate_rejects_model_minimum_samples_even_if_sqlite_checks_are_bypassed(draft: Path):
    connection = sqlite3.connect(draft)
    connection.execute("PRAGMA ignore_check_constraints = ON")
    connection.execute("UPDATE material_models SET minimum_samples = 1 WHERE key = 'model.sorption.isotherm'")
    connection.commit()
    connection.close()
    with pytest.raises(CatalogIntegrityError, match="minimumSamples must be a safe integer of at least two"):
        validate_database(draft)


def test_reviewed_catalog_regression_contract_and_legacy_absence():
    expected_quantity_domains = {
        "general": 137,
        "geometry": 26,
        "kinematics": 14,
        "mechanics": 107,
        "fluidDynamics": 41,
        "thermodynamics": 122,
        "transport": 35,
        "electromagnetism": 160,
        "coupledPhenomena": 17,
        "optics": 68,
        "acoustics": 27,
        "chemistry": 94,
        "materials": 60,
        "atomicNuclear": 138,
        "lifeSciences": 40,
        "earthSpace": 73,
        "informationComputing": 41,
        "economicsOperations": 16,
    }
    expected_material_domains = {
        "general": 14,
        "mechanical": 35,
        "thermal": 20,
        "thermodynamic": 16,
        "fluid": 8,
        "transport": 18,
        "electrical": 15,
        "magnetic": 16,
        "optical": 13,
        "radiative": 2,
        "acoustic": 6,
        "chemical": 13,
        "combustion": 3,
        "electrochemical": 14,
        "semiconductor": 15,
        "radiation": 16,
        "microstructure": 11,
        "coupled": 8,
        "interface": 15,
    }
    added_base_names = {
        "CapacitancePerArea",
        "ElectricPotentialPerTemperature",
        "FlowResistivity",
        "PiezoelectricChargeCoefficient",
        "PiezoelectricVoltageCoefficient",
        "PiezoelectricStressCoefficient",
        "PyroelectricCoefficient",
        "PiezoresistiveCoefficient",
        "ElectrostrictionCoefficient",
        "MagnetoelectricCoefficient",
        "StiffnessPerArea",
        "ThermalResistancePerArea",
        "ElasticComplianceTensor",
        "ElasticStiffnessTensor",
        "StressTensor",
    }
    removed_names = {
        "Capacity",
        "LineicQuantity",
        "PressureBasedQuantity",
        "Unknown",
        "economicsOperations.Asset",
        "informationComputing.StochasticProcess",
        "mechanics.GeneralizedCoordinate",
        "mechanics.GeneralizedForce",
        "mechanics.GeneralizedMomentum",
        "mechanics.GeneralizedVelocity",
        "thermodynamics.TemperatureBasedQuantity",
        "lifeSciences.VisionThresholds",
        "lifeSciences.GustatoryThreshold",
        "lifeSciences.TouchThresholds",
        "informationComputing.SignalDetectionThreshold",
        "earthSpace.PressureBurningRateConstant",
        "electromagnetism.MotorConstant",
        "optics.PlanckFunction",
    }
    with Catalog.open_readonly() as catalog:
        quantity_rows = catalog._all("SELECT name, domain, description, opaque FROM quantity_kinds ORDER BY name")
        material_rows = catalog._all("SELECT domain FROM material_parameters")
        unit_count = catalog._one("SELECT count(*) AS value FROM quantity_kind_units")["value"]
        quantity_counts = {
            row["domain"]: row["count"]
            for row in catalog._all(
                "SELECT domain, count(*) AS count FROM quantity_kinds GROUP BY domain ORDER BY domain"
            )
        }
        material_counts = {
            row["domain"]: row["count"]
            for row in catalog._all(
                "SELECT domain, count(*) AS count FROM material_parameters GROUP BY domain ORDER BY domain"
            )
        }
    names = {row["name"] for row in quantity_rows}
    base_names = [
        row["name"] if row["domain"] == "general" else row["name"][len(row["domain"]) + 1 :]
        for row in quantity_rows
    ]
    preserved = sorted(name for name in base_names if name not in added_base_names)
    checksum = 2_166_136_261
    for character in "\n".join(preserved):
        checksum = ((checksum ^ ord(character)) * 16_777_619) & 0xFFFF_FFFF

    assert len(quantity_rows) == 1_216
    assert len(material_rows) == 258
    assert unit_count == 10_338
    assert quantity_counts == expected_quantity_domains
    assert material_counts == expected_material_domains
    assert {row["name"] for row in quantity_rows if row["opaque"]} == OPAQUE_QUANTITY_KINDS
    assert len({*base_names}) == 1_216
    assert len(preserved) == 1_201
    assert checksum == 3_464_130_834
    assert len([name for name in base_names if name in added_base_names]) == 15
    assert names.isdisjoint(removed_names)
    assert sum(row["description"] is not None for row in quantity_rows) == 1_009

    repository = Path(__file__).resolve().parents[3]
    assert not (repository / "app/ui/public/assets/quantity-kind-data-0.0.1.js").exists()
    assert not any((repository / "app/ui/src/lib/quantitykind/data").glob("*.ts"))
    assert not any((repository / "app/ui/src/lib/material/data").glob("*.ts"))
    assert not (repository / "app/ui/src/lib/material/modelData.ts").exists()
    assert not (repository / "app/slaves/cae/app/solver_framework/solver-manifest.schema.json").exists()
    assert not any((repository / "app/slaves/cae/app/solvers").glob("*/manifest.json"))
