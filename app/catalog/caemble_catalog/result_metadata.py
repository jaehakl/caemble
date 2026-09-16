"""Typed, candidate-specific metadata shared by result producers and persistence."""

import math
from collections.abc import Mapping


_INTEGER_BITS = {f"{sign}int{bits}": (sign == "u", bits)
                 for sign in ("", "u") for bits in (8, 16, 32, 64)}
_DTYPES = {"string", "bool", "float16", "float32", "float64", *_INTEGER_BITS}


def validate_metadata_schema(schema, path="metadata"):
    if not isinstance(schema, Mapping):
        raise ValueError(f"{path} must declare named metadata fields")
    for name, field in schema.items():
        where = f"{path}.{name}"
        if not isinstance(name, str) or not name or name in {"__proto__", "constructor", "prototype"}:
            raise ValueError(f"{path} has an invalid field name")
        if not isinstance(field, Mapping) or set(field) - {"dtype", "shape", "quantityKind", "unit", "values"}:
            raise ValueError(f"{where} has an invalid metadata descriptor")
        dtype = field.get("dtype")
        if not isinstance(dtype, str) or dtype not in _DTYPES:
            raise ValueError(f"{where} requires a real numeric, bool or string dtype")
        shape = field.get("shape", ())
        if not isinstance(shape, (list, tuple)) or any(size is not None and (type(size) is not int or size < 0) for size in shape):
            raise ValueError(f"{where}.shape requires nonnegative lengths or null")
        physical = dtype.startswith("float")
        if physical:
            if any(not isinstance(field.get(key), str) or not field[key] for key in ("quantityKind", "unit")):
                raise ValueError(f"{where} requires quantityKind and unit")
        elif "quantityKind" in field or "unit" in field:
            raise ValueError(f"{where} non-floating metadata cannot declare physical units")
        if "values" in field and (dtype != "string" or not isinstance(field["values"], (list, tuple))
                                  or not field["values"] or any(not isinstance(value, str) for value in field["values"])
                                  or len(set(field["values"])) != len(field["values"])):
            raise ValueError(f"{where}.values requires distinct string choices")


def validate_result_metadata(schema, values, path="metadata", *, allow_extra=False):
    validate_metadata_schema(schema, path)
    if not isinstance(values, Mapping) or set(schema) - set(values) or (not allow_extra and set(values) - set(schema)):
        raise ValueError(f"{path} fields differ from their declared metadata schema")
    for name, field in schema.items():
        raw = values[name]
        if hasattr(raw, "tolist"):
            raw = raw.tolist()
        shape, dtype = field.get("shape", ()), field["dtype"]
        dimensions = {}

        def validate(item, depth, where):
            if depth < len(shape):
                if not isinstance(item, (list, tuple)) or (shape[depth] is not None and len(item) != shape[depth]):
                    raise ValueError(f"{where} shape differs from its metadata declaration")
                if depth in dimensions and dimensions[depth] != len(item):
                    raise ValueError(f"{where} metadata arrays must be rectangular")
                dimensions[depth] = len(item)
                for index, child in enumerate(item):
                    validate(child, depth + 1, f"{where}[{index}]")
                return
            if dtype == "string":
                valid = isinstance(item, str) and ("values" not in field or item in field["values"])
            elif dtype == "bool":
                valid = type(item) is bool
            elif dtype in _INTEGER_BITS:
                unsigned, bits = _INTEGER_BITS[dtype]
                lower, upper = (0, 2**bits - 1) if unsigned else (-2**(bits - 1), 2**(bits - 1) - 1)
                valid = type(item) is int and lower <= item <= upper and abs(item) <= 2**53 - 1
            else:
                limit = {"float16": 65504., "float32": 3.4028234663852886e38, "float64": float("inf")}[dtype]
                valid = type(item) in (int, float) and math.isfinite(item) and abs(item) <= limit
            if not valid:
                raise ValueError(f"{where} must match its {dtype} metadata declaration")

        validate(raw, 0, f"{path}.{name}")
