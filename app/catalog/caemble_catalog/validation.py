from __future__ import annotations

import math
import re
from functools import lru_cache
from typing import Any

from ucumvert import PintUcumRegistry

from .database import Catalog
from .errors import CatalogIntegrityError

QUANTITY_KIND_DOMAINS = (
    "general",
    "geometry",
    "kinematics",
    "mechanics",
    "fluidDynamics",
    "thermodynamics",
    "transport",
    "electromagnetism",
    "coupledPhenomena",
    "optics",
    "acoustics",
    "chemistry",
    "materials",
    "atomicNuclear",
    "lifeSciences",
    "earthSpace",
    "informationComputing",
    "economicsOperations",
)

OPAQUE_QUANTITY_KINDS = frozenset(
    {
        "LinearLogarithmicRatio",
        "thermodynamics.AreaTimeTemperature",
        "thermodynamics.LengthTemperatureTime",
        "thermodynamics.TemperatureVariance",
        "chemistry.Acidity",
        "chemistry.Basicity",
    }
)

MATERIAL_PARAMETER_DOMAINS = (
    "general",
    "mechanical",
    "thermal",
    "thermodynamic",
    "fluid",
    "transport",
    "electrical",
    "magnetic",
    "optical",
    "radiative",
    "acoustic",
    "chemical",
    "combustion",
    "electrochemical",
    "semiconductor",
    "radiation",
    "microstructure",
    "coupled",
    "interface",
)

_identifier = re.compile(r"^[a-z][a-z0-9_]*$")
_material_key = re.compile(r"^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$")
_model_key = re.compile(r"^model\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$")
_annotation = re.compile(r"^\{[^{}]+\}$")
_repeated_whitespace = re.compile(r"\s{2,}")
_registry = PintUcumRegistry()


def _validate_text(value: str, path: str) -> None:
    if not value or value != value.strip() or _repeated_whitespace.search(value):
        raise CatalogIntegrityError(f"{path} must be non-empty, trimmed, and contain no repeated whitespace")


def _validate_ordinals(rows: list[Any], path: str) -> None:
    ordinals = [row["ordinal"] for row in rows]
    if ordinals != list(range(len(rows))):
        raise CatalogIntegrityError(f"{path} ordinals must be contiguous from zero")


@lru_cache(maxsize=None)
def _parsed_unit(unit: str) -> tuple[float, Any]:
    if _annotation.fullmatch(unit):
        return 1.0, _registry.dimensionless
    parsed = _registry.from_ucum(unit)
    parsed_unit = getattr(parsed, "units", None)
    magnitude = getattr(parsed, "magnitude", None)
    if parsed_unit is None or not isinstance(magnitude, (int, float)):
        raise ValueError(f"unsupported UCUM unit {unit!r}")
    scale = float(magnitude)
    if not math.isfinite(scale) or scale == 0:
        raise ValueError(f"invalid UCUM unit scale for {unit!r}")
    return scale, parsed_unit


@lru_cache(maxsize=None)
def _converted_value(value: int, source_unit: str, target_unit: str) -> float:
    source_scale, source = _parsed_unit(source_unit)
    target_scale, target = _parsed_unit(target_unit)
    converted = _registry.Quantity(value * source_scale, source).to(target).magnitude / target_scale
    result = float(converted)
    if not math.isfinite(result):
        raise ValueError("conversion result is not finite")
    return result


def _validate_quantity_kinds(catalog: Catalog) -> None:
    rows = catalog._all("SELECT name, domain, tensor_order, description, opaque FROM quantity_kinds ORDER BY name")
    known_domains = set(QUANTITY_KIND_DOMAINS)
    base_names: set[str] = set()
    opaque_names = {row["name"] for row in rows if row["opaque"]}
    if opaque_names != OPAQUE_QUANTITY_KINDS:
        missing = sorted(OPAQUE_QUANTITY_KINDS - opaque_names)
        extra = sorted(opaque_names - OPAQUE_QUANTITY_KINDS)
        raise CatalogIntegrityError(f"Reviewed opaque QuantityKind policy mismatch: missing={missing}, extra={extra}")
    for row in rows:
        name = row["name"]
        domain = row["domain"]
        if domain not in known_domains:
            raise CatalogIntegrityError(f"QuantityKind {name} has unknown domain {domain!r}")
        if name != name.strip():
            raise CatalogIntegrityError(f"QuantityKind name {name!r} must be trimmed")
        if domain == "general":
            if "." in name:
                raise CatalogIntegrityError(f"General QuantityKind {name} must not have a domain prefix")
            base_name = name
        else:
            prefix = f"{domain}."
            if not name.startswith(prefix) or "." in name[len(prefix) :] or len(name) == len(prefix):
                raise CatalogIntegrityError(f"QuantityKind {name} does not match domain {domain}")
            base_name = name[len(prefix) :]
        if not base_name:
            raise CatalogIntegrityError(f"QuantityKind {name!r} must have a non-empty base name")
        if base_name in base_names:
            raise CatalogIntegrityError(f"QuantityKind base name {base_name} is defined more than once")
        base_names.add(base_name)
        tensor_order = row["tensor_order"]
        if not isinstance(tensor_order, int) or isinstance(tensor_order, bool) or not 0 <= tensor_order <= 4:
            raise CatalogIntegrityError(f"QuantityKind {name} tensorOrder must be a safe integer from 0 through 4")
        if row["description"] is not None:
            _validate_text(row["description"], f"QuantityKind {name} description")
        units = catalog._all(
            "SELECT ordinal, unit FROM quantity_kind_units WHERE quantity_kind = ? ORDER BY ordinal", (name,)
        )
        if not units:
            raise CatalogIntegrityError(f"QuantityKind {name} must have at least one applicable unit")
        _validate_ordinals(units, f"QuantityKind {name} applicable units")
        unit_names = [unit["unit"] for unit in units]
        if len(unit_names) != len(set(unit_names)):
            raise CatalogIntegrityError(f"QuantityKind {name} applicable units must be unique")
        for unit in unit_names:
            if not unit or unit != unit.strip() or any(character.isspace() for character in unit):
                raise CatalogIntegrityError(f"QuantityKind {name} contains invalid unit {unit!r}")
        if name in OPAQUE_QUANTITY_KINDS:
            continue
        reference = unit_names[0]
        for unit in unit_names:
            try:
                _parsed_unit(unit)
                for value in (0, 1):
                    _converted_value(value, reference, unit)
                    _converted_value(value, unit, reference)
            except Exception as error:
                raise CatalogIntegrityError(
                    f"QuantityKind {name} unit {unit!r} is not bidirectionally UCUM-convertible with {reference!r}"
                ) from error


def _validate_material_parameters(catalog: Catalog, quantity_kinds: set[str]) -> None:
    known_domains = set(MATERIAL_PARAMETER_DOMAINS)
    rows = catalog._all("SELECT key, domain, label_ko, quantity_kind FROM material_parameters ORDER BY key")
    for row in rows:
        key = row["key"]
        match = _material_key.fullmatch(key)
        if match is None or match.group(1) not in known_domains:
            raise CatalogIntegrityError(f"Material parameter key {key!r} must match a reviewed domain.property name")
        if row["domain"] != match.group(1):
            raise CatalogIntegrityError(f"Material parameter {key} domain column does not match its key")
        if row["quantity_kind"] not in quantity_kinds or row["quantity_kind"].startswith(("mdb:", "qudt:")):
            raise CatalogIntegrityError(f"Material parameter {key} references a non-canonical QuantityKind")
        _validate_text(row["label_ko"], f"Material parameter {key} labelKo")
        qualifiers = catalog._all(
            """
            SELECT ordinal, qualifier FROM material_parameter_qualifiers
            WHERE material_parameter = ? ORDER BY ordinal
            """,
            (key,),
        )
        _validate_ordinals(qualifiers, f"Material parameter {key} qualifiers")
        for qualifier in qualifiers:
            if _identifier.fullmatch(qualifier["qualifier"]) is None:
                raise CatalogIntegrityError(
                    f"Material parameter {key} has invalid qualifier {qualifier['qualifier']!r}"
                )

    global_qualifiers = catalog._all("SELECT ordinal, qualifier FROM material_global_qualifiers ORDER BY ordinal")
    if not global_qualifiers:
        raise CatalogIntegrityError("Material global qualifiers must not be empty")
    _validate_ordinals(global_qualifiers, "Material global qualifiers")
    for qualifier in global_qualifiers:
        if _identifier.fullmatch(qualifier["qualifier"]) is None:
            raise CatalogIntegrityError(f"Invalid Material global qualifier {qualifier['qualifier']!r}")

    design_rules = catalog._all("SELECT key, description FROM material_design_rules ORDER BY key")
    if not design_rules:
        raise CatalogIntegrityError("Material design rules must not be empty")
    for rule in design_rules:
        if _identifier.fullmatch(rule["key"]) is None:
            raise CatalogIntegrityError(f"Invalid Material design rule key {rule['key']!r}")
        _validate_text(rule["description"], f"Material design rule {rule['key']}")


def _validate_material_models(catalog: Catalog, quantity_kinds: set[str]) -> None:
    for row in catalog._all("SELECT * FROM material_models ORDER BY key"):
        key = row["key"]
        if _model_key.fullmatch(key) is None:
            raise CatalogIntegrityError(f"Material model key {key!r} must match model.namespace.relation")
        _validate_text(row["label_ko"], f"Material model {key} labelKo")
        if row["kind"] != "sampled_relation":
            raise CatalogIntegrityError(f"Material model {key} kind must be sampled_relation")
        for endpoint in ("input", "output"):
            endpoint_name = row[f"{endpoint}_name"]
            quantity_kind = row[f"{endpoint}_quantity_kind"]
            if _identifier.fullmatch(endpoint_name) is None:
                raise CatalogIntegrityError(f"Material model {key} has invalid {endpoint} name {endpoint_name!r}")
            if quantity_kind not in quantity_kinds:
                raise CatalogIntegrityError(f"Material model {key} {endpoint} references an unknown QuantityKind")
        if row["input_name"] == row["output_name"]:
            raise CatalogIntegrityError(f"Material model {key} input and output names must differ")
        minimum_samples = row["minimum_samples"]
        if not isinstance(minimum_samples, int) or not 2 <= minimum_samples <= 9_007_199_254_740_991:
            raise CatalogIntegrityError(f"Material model {key} minimumSamples must be a safe integer of at least two")
        if row["shared_basis"] not in (0, 1):
            raise CatalogIntegrityError(f"Material model {key} sharedBasis must be boolean")


def validate_catalog_content(catalog: Catalog) -> None:
    """Validate semantic invariants that SQLite constraints cannot express."""

    _validate_quantity_kinds(catalog)
    quantity_kinds = {row["name"] for row in catalog._all("SELECT name FROM quantity_kinds")}
    _validate_material_parameters(catalog, quantity_kinds)
    _validate_material_models(catalog, quantity_kinds)
