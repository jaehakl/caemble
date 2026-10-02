"""Structural Material Model contracts shared by catalog tools and input consumers."""

from __future__ import annotations

import math
from typing import Any, Iterator


def schema_values(schema: dict[str, Any], path: str = "parameters") -> Iterator[tuple[str, dict[str, Any]]]:
    if schema["kind"] == "value":
        yield path, schema
    elif schema["kind"] == "object":
        for name, field in schema["fields"].items():
            yield from schema_values(field, f"{path}.{name}")
    else:
        yield from schema_values(schema["items"], f"{path}[]")


def validate_parameter_schema(schema: object, path: str = "parameterSchema") -> None:
    if not isinstance(schema, dict):
        raise ValueError(f"{path} must be an object")
    kind = schema.get("kind")
    common = {"kind", "description", "omission"}
    for key in ("description", "omission"):
        if key in schema and not isinstance(schema[key], str):
            raise ValueError(f"{path}.{key} must be a string")
    if kind == "object":
        allowed = common | {"fields", "required"}
        fields = schema.get("fields")
        if not isinstance(fields, dict) or any(not isinstance(key, str) or not key for key in fields):
            raise ValueError(f"{path}.fields must contain named schemas")
        required = schema.get("required", [])
        if not isinstance(required, list) or any(not isinstance(key, str) or key not in fields for key in required) or len(required) != len(set(required)):
            raise ValueError(f"{path}.required must contain unique declared field names")
        for name, field in fields.items():
            validate_parameter_schema(field, f"{path}.fields.{name}")
    elif kind == "list":
        allowed = common | {"items", "minimumLength", "maximumLength", "increasingBy"}
        validate_parameter_schema(schema.get("items"), f"{path}.items")
        for key in ("minimumLength", "maximumLength"):
            if key in schema and (type(schema[key]) is not int or schema[key] < 0):
                raise ValueError(f"{path}.{key} must be a nonnegative integer")
        if schema.get("maximumLength", math.inf) < schema.get("minimumLength", 0):
            raise ValueError(f"{path}.maximumLength is smaller than minimumLength")
        if "increasingBy" in schema:
            name = schema["increasingBy"]
            if not isinstance(name, str) or not name:
                raise ValueError(f"{path}.increasingBy must name a scalar item field")
            field = schema["items"].get("fields", {}).get(name)
            if not isinstance(field, dict) or field.get("kind") != "value" or field.get("shape", []) != [] or field.get("dtype") in {"string", "bool"} or name not in schema["items"].get("required", []):
                raise ValueError(f"{path}.increasingBy must name a required numeric scalar item field")
    elif kind == "value":
        allowed = common | {"dtype", "shape", "quantityKind", "unit", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "values"}
        dtype = schema.get("dtype", "float64")
        if not isinstance(dtype, str) or dtype not in {"float16", "float32", "float64", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "string", "bool"}:
            raise ValueError(f"{path}.dtype is unsupported")
        shape = schema.get("shape", [])
        if not isinstance(shape, list) or any(type(size) is not int or size < 1 for size in shape):
            raise ValueError(f"{path}.shape must contain positive dimensions")
        if ("quantityKind" in schema) != ("unit" in schema):
            raise ValueError(f"{path} requires both quantityKind and unit")
        for key in ("quantityKind", "unit"):
            if key in schema and (not isinstance(schema[key], str) or not schema[key].strip()):
                raise ValueError(f"{path}.{key} must be a nonempty string")
        if "quantityKind" in schema and not dtype.startswith("float"):
            raise ValueError(f"{path} quantities require a float dtype")
        if "values" in schema and (dtype != "string" or not isinstance(schema["values"], list) or not schema["values"] or any(not isinstance(value, str) for value in schema["values"])):
            raise ValueError(f"{path}.values requires a nonempty string enum")
        for key in ("minimum", "maximum"):
            if key in schema and (type(schema[key]) not in {int, float} or not -1.7976931348623157e308 <= schema[key] <= 1.7976931348623157e308):
                raise ValueError(f"{path}.{key} must be finite")
        for key, bound in (("exclusiveMinimum", "minimum"), ("exclusiveMaximum", "maximum")):
            if key in schema and (type(schema[key]) is not bool or bound not in schema):
                raise ValueError(f"{path}.{key} requires a boolean and {bound}")
        if dtype in {"string", "bool"} and any(key in schema for key in ("minimum", "maximum")):
            raise ValueError(f"{path} numeric bounds require numeric data")
        if schema.get("maximum", math.inf) < schema.get("minimum", -math.inf):
            raise ValueError(f"{path}.maximum is smaller than minimum")
    else:
        raise ValueError(f"{path}.kind must be value, object, or list")
    if unknown := set(schema) - allowed:
        raise ValueError(f"{path} contains unknown fields: {', '.join(sorted(unknown))}")


def validate_model_parameters(definition: dict[str, Any], parameters: object, path: str = "parameters") -> None:
    """Validate an already normalized input without evaluating any model equation."""
    def visit(schema: dict[str, Any], value: object, location: str) -> None:
        kind = schema["kind"]
        if kind == "object":
            if not isinstance(value, dict):
                raise ValueError(f"{location} must be an object")
            for name in schema.get("required", []):
                if name not in value:
                    raise ValueError(f"{location}.{name} is required")
            for name, member in value.items():
                if name not in schema["fields"]:
                    raise ValueError(f"{location}.{name} is not declared by the model")
                visit(schema["fields"][name], member, f"{location}.{name}")
            return
        if kind == "list":
            if not isinstance(value, list):
                raise ValueError(f"{location} must be a list")
            if not schema.get("minimumLength", 0) <= len(value) <= schema.get("maximumLength", math.inf):
                raise ValueError(f"{location} has an invalid number of items")
            previous = None
            for index, member in enumerate(value):
                visit(schema["items"], member, f"{location}[{index}]")
                if field := schema.get("increasingBy"):
                    current = member[field]
                    current = current["value"] if isinstance(current, dict) else current
                    if previous is not None and current <= previous:
                        raise ValueError(f"{location}[{index}].{field} must be strictly increasing")
                    previous = current
            return
        dtype = schema.get("dtype", "float64")
        if schema.get("quantityKind"):
            if not isinstance(value, dict) or "value" not in value or value.get("unit") != schema["unit"]:
                raise ValueError(f"{location} must have a value normalized to {schema['unit']}")
            if set(value) - {"value", "unit", "dtype", "basis"}:
                raise ValueError(f"{location} has unknown quantity fields")
            actual_dtype = value.get("dtype", "float64")
            if not isinstance(actual_dtype, str) or actual_dtype != dtype and not (dtype.startswith("float") and actual_dtype in {"float16", "float32", "float64"}):
                raise ValueError(f"{location}.dtype must be {dtype}")
            if "basis" in value and (not schema.get("shape") or value["basis"] != [[1, 0, 0], [0, 1, 0], [0, 0, 1]]):
                raise ValueError(f"{location}.basis must be the normalized global Cartesian identity")
            dtype = actual_dtype
            value = value["value"]

        def tensor(member: object, dimensions: list[int], member_path: str) -> None:
            if dimensions:
                if not isinstance(member, list) or len(member) != dimensions[0]:
                    raise ValueError(f"{member_path} must have shape {schema.get('shape', [])}")
                for index, item in enumerate(member):
                    tensor(item, dimensions[1:], f"{member_path}[{index}]")
                return
            if dtype == "string":
                if not isinstance(member, str) or ("values" in schema and member not in schema["values"]):
                    raise ValueError(f"{member_path} must be a permitted string")
                return
            if dtype == "bool":
                if type(member) is not bool:
                    raise ValueError(f"{member_path} must be boolean")
                return
            if type(member) not in {int, float} or not -1.7976931348623157e308 <= member <= 1.7976931348623157e308:
                raise ValueError(f"{member_path} must be finite numeric data")
            if dtype.startswith(("int", "uint")) and int(member) != member:
                raise ValueError(f"{member_path} must be an integer")
            if dtype.startswith("uint") and member < 0:
                raise ValueError(f"{member_path} must be unsigned")
            if dtype.startswith(("int", "uint")):
                bits = int(dtype.removeprefix("u").removeprefix("int"))
                lower, upper = (0, 2**bits - 1) if dtype.startswith("uint") else (-2**(bits - 1), 2**(bits - 1) - 1)
                if not max(lower, -(2**53 - 1)) <= member <= min(upper, 2**53 - 1):
                    raise ValueError(f"{member_path} is outside {dtype} range")
            if dtype == "float16" and abs(member) > 65504 or dtype == "float32" and abs(member) > 3.4028234663852886e38:
                raise ValueError(f"{member_path} is outside {dtype} range")
            if "minimum" in schema and (member < schema["minimum"] or (schema.get("exclusiveMinimum") and member == schema["minimum"])):
                raise ValueError(f"{member_path} is below the model minimum")
            if "maximum" in schema and (member > schema["maximum"] or (schema.get("exclusiveMaximum") and member == schema["maximum"])):
                raise ValueError(f"{member_path} is above the model maximum")
        tensor(value, schema.get("shape", []), location)

    visit(definition["parameterSchema"], parameters, path)
