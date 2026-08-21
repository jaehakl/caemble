from __future__ import annotations

import hashlib
import json
import math
import re
from functools import lru_cache
from typing import Any

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
_catalog_key = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_export_name = re.compile(r"^[A-Z][A-Za-z0-9]*$")
_source_path = re.compile(r"^(?:experiment|geometry|material)\.tsx$|^simulate\.py$|^tasks/[A-Za-z][A-Za-z0-9_-]*\.tsx$")


@lru_cache(maxsize=1)
def _unit_registry() -> Any:
    from ucumvert import PintUcumRegistry

    return PintUcumRegistry()


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
        return 1.0, _unit_registry().dimensionless
    parsed = _unit_registry().from_ucum(unit)
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
    converted = _unit_registry().Quantity(value * source_scale, source).to(target).magnitude / target_scale
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


def _validate_geometries(catalog: Catalog) -> None:
    for row in catalog._all("SELECT * FROM geometries ORDER BY key"):
        key = row["key"]
        if _catalog_key.fullmatch(key) is None:
            raise CatalogIntegrityError(f"Geometry key {key!r} must be a lowercase kebab-case key")
        _validate_text(row["title"], f"Geometry {key} title")
        _validate_text(row["description"], f"Geometry {key} description")
        if _export_name.fullmatch(row["export_name"]) is None:
            raise CatalogIntegrityError(f"Geometry {key} exportName must be a PascalCase identifier")
        if not row["length_unit"] or row["length_unit"] != row["length_unit"].strip():
            raise CatalogIntegrityError(f"Geometry {key} lengthUnit must be non-empty and trimmed")
        source = row["source"]
        if not source.strip() or len(source.encode("utf-8")) > 1_048_576:
            raise CatalogIntegrityError(f"Geometry {key} source must be between 1 byte and 1 MiB")
        expected_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
        if row["source_hash"] != expected_hash:
            raise CatalogIntegrityError(f"Geometry {key} source hash mismatch")
        if re.search(rf"\bexport\s+const\s+{re.escape(row['export_name'])}\b", source) is None:
            raise CatalogIntegrityError(
                f"Geometry {key} source must provide named export {row['export_name']}"
            )
        concepts = catalog._all(
            "SELECT ordinal, concept FROM geometry_concepts WHERE geometry_key = ? ORDER BY ordinal", (key,)
        )
        _validate_ordinals(concepts, f"Geometry {key} concepts")
        for concept in concepts:
            _validate_text(concept["concept"], f"Geometry {key} concept")
        roles = catalog._all(
            "SELECT ordinal, role, description FROM geometry_material_roles WHERE geometry_key = ? ORDER BY ordinal",
            (key,),
        )
        _validate_ordinals(roles, f"Geometry {key} material roles")
        for role in roles:
            if _identifier.fullmatch(role["role"]) is None:
                raise CatalogIntegrityError(f"Geometry {key} has invalid Material role {role['role']!r}")
            _validate_text(role["description"], f"Geometry {key} Material role {role['role']}")
        elements = catalog._all(
            "SELECT ordinal, element FROM geometry_elements WHERE geometry_key = ? ORDER BY ordinal", (key,)
        )
        _validate_ordinals(elements, f"Geometry {key} related elements")
        for element in elements:
            if not element["element"] or element["element"] != element["element"].strip():
                raise CatalogIntegrityError(f"Geometry {key} contains an invalid related CAD element")


def _validate_verification(key: str, verification: Any) -> None:
    if not isinstance(verification, dict):
        raise CatalogIntegrityError(f"Experiment {key} verification must be an object")
    allowed = {"kernelTasks", "recordedData", "expectations", "fixture"}
    if set(verification) - allowed:
        raise CatalogIntegrityError(f"Experiment {key} verification contains unknown fields")
    for field in ("kernelTasks", "recordedData", "expectations"):
        values = verification.get(field)
        if not isinstance(values, list) or not all(isinstance(value, str) and value for value in values):
            raise CatalogIntegrityError(f"Experiment {key} verification.{field} must be a string array")
    fixture = verification.get("fixture")
    if fixture is None:
        return
    if not isinstance(fixture, dict) or set(fixture) != {"records", "terminal"}:
        raise CatalogIntegrityError(f"Experiment {key} verification.fixture is invalid")
    if not isinstance(fixture["records"], list) or not isinstance(fixture["terminal"], dict):
        raise CatalogIntegrityError(f"Experiment {key} verification.fixture is invalid")


def _validate_experiments(catalog: Catalog) -> None:
    for row in catalog._all("SELECT * FROM experiments ORDER BY key"):
        key = row["key"]
        if _catalog_key.fullmatch(key) is None:
            raise CatalogIntegrityError(f"Experiment key {key!r} must be a lowercase kebab-case key")
        _validate_text(row["title"], f"Experiment {key} title")
        _validate_text(row["description"], f"Experiment {key} description")
        try:
            geometry = json.loads(row["geometry_snapshot_json"])
            verification = json.loads(row["verification_json"])
        except json.JSONDecodeError as error:
            raise CatalogIntegrityError(f"Experiment {key} contains invalid JSON") from error
        if not isinstance(geometry, dict) or not geometry:
            raise CatalogIntegrityError(f"Experiment {key} Geometry snapshot must be a non-empty object")
        _validate_verification(key, verification)
        files = catalog._all(
            "SELECT ordinal, path, source FROM experiment_files WHERE experiment_key = ? ORDER BY ordinal", (key,)
        )
        if not files:
            raise CatalogIntegrityError(f"Experiment {key} must contain source files")
        _validate_ordinals(files, f"Experiment {key} files")
        paths = {file["path"] for file in files}
        required_paths = {"experiment.tsx", "geometry.tsx", "material.tsx", "simulate.py"}
        if not required_paths <= paths or not any(path.startswith("tasks/") for path in paths):
            raise CatalogIntegrityError(f"Experiment {key} source bundle is missing required files")
        total_size = 0
        for file in files:
            if _source_path.fullmatch(file["path"]) is None or ".." in file["path"].split("/"):
                raise CatalogIntegrityError(f"Experiment {key} contains invalid source path {file['path']!r}")
            source_size = len(file["source"].encode("utf-8"))
            if source_size == 0 or source_size > 1_048_576:
                raise CatalogIntegrityError(f"Experiment {key} file {file['path']} exceeds source limits")
            total_size += source_size
        if total_size > 1_048_576:
            raise CatalogIntegrityError(f"Experiment {key} source bundle exceeds 1 MiB")
        concepts = catalog._all(
            "SELECT ordinal, concept FROM experiment_concepts WHERE experiment_key = ? ORDER BY ordinal", (key,)
        )
        _validate_ordinals(concepts, f"Experiment {key} concepts")
        for concept in concepts:
            _validate_text(concept["concept"], f"Experiment {key} concept")
        solvers = catalog._all(
            "SELECT ordinal FROM experiment_solvers WHERE experiment_key = ? ORDER BY ordinal", (key,)
        )
        if not solvers:
            raise CatalogIntegrityError(f"Experiment {key} must reference at least one Solver")
        _validate_ordinals(solvers, f"Experiment {key} related Solvers")
        bundle = {
            "formatVersion": row["bundle_format_version"],
            "files": {file["path"]: file["source"] for file in files},
            "geometrySnapshot": geometry,
        }
        bundle_json = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if row["bundle_hash"] != hashlib.sha256(bundle_json.encode("utf-8")).hexdigest():
            raise CatalogIntegrityError(f"Experiment {key} bundle hash mismatch")


def validate_catalog_content(catalog: Catalog) -> None:
    """Validate semantic invariants that SQLite constraints cannot express."""

    _validate_quantity_kinds(catalog)
    quantity_kinds = {row["name"] for row in catalog._all("SELECT name FROM quantity_kinds")}
    _validate_material_parameters(catalog, quantity_kinds)
    _validate_material_models(catalog, quantity_kinds)
    _validate_geometries(catalog)
    _validate_experiments(catalog)
