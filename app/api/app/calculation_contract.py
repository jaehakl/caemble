"""Portable, non-executable Calculation declarations. Never evaluate source."""
import hashlib
import json
import math
import re
from typing import Any

DTYPES = {"float32", "float64", "int8", "int16", "int32", "uint8", "uint16", "uint32"}
MARKER = "@caemble-contract"


def extract_contract(source: str) -> dict | None:
    if MARKER not in source:
        return None
    match = re.match(r"\A\s*/\* @caemble-contract\s+(.*?)\*/", source, re.S)
    if match is None or source.count(MARKER) != 1:
        raise ValueError("Use one leading /* @caemble-contract { JSON } */ declaration.")
    contract = json.loads(match[1])
    if not isinstance(contract, dict) or set(contract) != {"version", "inputs", "output"} or isinstance(contract["version"], bool) or contract["version"] != 1:
        raise ValueError("Calculation contract requires version: 1, inputs and output.")
    if not isinstance(contract["inputs"], dict):
        raise ValueError("Calculation contract inputs must map Record names to contracts.")
    for name, tensor in contract["inputs"].items():
        if not isinstance(name, str) or not name or name in {"__proto__", "constructor", "prototype"}:
            raise ValueError("Invalid contract Record name.")
        validate_tensor_contract(tensor, is_input=True)
    validate_tensor_contract(contract["output"], is_input=False)
    return contract


def validate_tensor_contract(value: Any, *, is_input: bool) -> None:
    allowed = {"dtype", "shape", "axes", "min", "max"}
    if is_input:
        allowed |= {"unit", "quantityKind", "tensorOrder"}
    if not isinstance(value, dict) or set(value) - allowed or not {"dtype", "shape"} <= set(value):
        raise ValueError("Tensor contract requires dtype and shape; unknown fields are not allowed.")
    dtype = value["dtype"]
    if not isinstance(dtype, str) or dtype not in ({"float32", "float64"} if is_input else DTYPES):
        raise ValueError("Unsupported contract dtype.")
    shape = value["shape"]
    if not isinstance(shape, list) or (len(shape) != 7 if is_input else len(shape) > 3):
        raise ValueError("Input contracts have seven axes; output rank must be 0 to 3.")
    if any(d is not None and (type(d) not in (int, float) or not math.isfinite(d) or int(d) != d or d < 0 or d > 9007199254740991) for d in shape):
        raise ValueError("Shape dimensions must be nonnegative safe integers or null.")
    for key in ("unit", "quantityKind"):
        if key in value and (not isinstance(value[key], str) or not value[key]):
            raise ValueError(f"{key} must be a nonempty string.")
    if "tensorOrder" in value and (isinstance(value["tensorOrder"], bool) or value["tensorOrder"] not in (0, 1, 2)):
        raise ValueError("tensorOrder must be 0, 1 or 2.")
    if "axes" in value:
        axes = value["axes"]
        if not isinstance(axes, list) or len(axes) != len(shape):
            raise ValueError("Contract axes must match rank.")
        for axis in axes:
            if not isinstance(axis, dict) or set(axis) - {"name", "unit"} or any(not isinstance(v, str) or not v for v in axis.values()):
                raise ValueError("Contract axes contain only optional name and unit strings.")
    for key in ("min", "max"):
        if key in value and (type(value[key]) not in (int, float) or not math.isfinite(value[key])):
            raise ValueError("Contract bounds must be finite numbers.")
    if "min" in value and "max" in value and value["min"] > value["max"]:
        raise ValueError("Contract min must not exceed max.")


def contract_hash(contract: dict | None) -> str | None:
    if contract is None:
        return None
    # JSON parses 1 and 1.0 to the same contract value; normalize integral bounds.
    def canonical(value):
        if isinstance(value, dict):
            return {key: canonical(item) for key, item in value.items()}
        if isinstance(value, list):
            return [canonical(item) for item in value]
        return int(value) if isinstance(value, float) and value.is_integer() else value
    return hashlib.sha256(json.dumps(canonical(contract), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def assert_tensor_contract(contract: dict, tensor: dict, *, values: bool = False) -> None:
    shape = tensor.get("shape")
    if tensor.get("dtype") != contract["dtype"] or not isinstance(shape, list) or len(shape) != len(contract["shape"]) or any(expected is not None and expected != actual for expected, actual in zip(contract["shape"], shape)):
        raise ValueError("Tensor dtype/shape does not match the declared Calculation contract.")
    for key in ("unit", "quantityKind", "tensorOrder"):
        if key in contract and tensor.get(key) != contract[key]:
            raise ValueError(f"Tensor {key} does not match the declared Calculation contract.")
    for index, axis in enumerate(contract.get("axes", [])):
        actual = (tensor.get("axes") or [])[index:index + 1]
        if not actual or any(actual[0].get(key) != value for key, value in axis.items()):
            raise ValueError("Tensor axes do not match the declared Calculation contract.")
    if values and ("min" in contract or "max" in contract):
        data = tensor.get("data")
        if isinstance(data, dict):
            raise ValueError("Resolve tensor attachments before checking declared bounds.")
        pending = [data]
        while pending:
            item = pending.pop()
            if isinstance(item, list):
                pending.extend(item)
            elif type(item) not in (int, float) or not math.isfinite(item) or item < contract.get("min", -math.inf) or item > contract.get("max", math.inf):
                raise ValueError("Tensor data violates the declared Calculation bounds.")
