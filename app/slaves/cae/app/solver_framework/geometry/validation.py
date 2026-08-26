from __future__ import annotations

import hashlib
import json
import math
import re
from decimal import Decimal
from typing import Any

from app.errors import CaeError
from app.solver_framework.geometry.complexity import (
    MAX_BOOLEAN_OPERANDS,
    MAX_BOOLEAN_WORK,
    MAX_TRIANGLES,
    enforce_boolean_work_limit,
    enforce_triangle_limit,
    estimated_triangle_count,
)
from app.solver_framework.units import convert_ucum_value

_HASH = re.compile(r"^[0-9a-f]{64}$")
_PRIMITIVE_SURFACES = {
    "box": {0, 1, 2, 3, 4, 5},
    "cylinder": {0, 1, 2},
    "sphere": {0},
    "curvedEdgeCylinder": {0, 1, 2},
    "curvedSurfaceSphere": {0},
}
_MAX_ROOTS = 10_000
_MAX_NODES = 100_000
_MAX_NODE_DEPTH = 128
_MAX_ARRAY_ITEMS = 1_000_000
_MAX_SEGMENTS = 65_536
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


def validate_canonical_geometry_scene(value: Any, path: str) -> None:
    expected = {
        "geometryFormatVersion",
        "geometryHash",
        "lengthUnit",
        "roots",
        "geometryGroups",
        "surfaceGroups",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise CaeError("invalid_input", f"{path} must be an exact CanonicalGeometrySceneV2")
    if value.get("geometryFormatVersion") != 2 or isinstance(value["geometryFormatVersion"], bool):
        raise CaeError("invalid_input", f"{path}.geometryFormatVersion must be 2")
    if not isinstance(value.get("geometryHash"), str) or _HASH.fullmatch(value["geometryHash"]) is None:
        raise CaeError("invalid_input", f"{path}.geometryHash is invalid")
    if not isinstance(value.get("lengthUnit"), str) or not value["lengthUnit"]:
        raise CaeError("invalid_input", f"{path}.lengthUnit must be a non-empty UCUM unit")
    try:
        scale = convert_ucum_value(1, value["lengthUnit"], "m", f"{path}.lengthUnit") - convert_ucum_value(
            0,
            value["lengthUnit"],
            "m",
            f"{path}.lengthUnit",
        )
    except CaeError as exc:
        raise CaeError("invalid_input", f"{path}.lengthUnit must be a UCUM length unit") from exc
    if not math.isfinite(scale) or scale <= 0:
        raise CaeError("invalid_input", f"{path}.lengthUnit must be a positive UCUM length unit")
    if not isinstance(value.get("roots"), list) or len(value["roots"]) > _MAX_ROOTS:
        raise CaeError("invalid_input", f"{path}.roots must contain at most {_MAX_ROOTS} roots")
    if not isinstance(value.get("geometryGroups"), list) or not isinstance(value.get("surfaceGroups"), list):
        raise CaeError("invalid_input", f"{path} groups must be arrays")

    roots: dict[str, dict[str, Any]] = {}
    root_nodes: dict[str, dict[str, set[int]]] = {}
    node_count = [0]
    scene_triangle_count = 0
    scene_boolean_work = 0
    for index, root in enumerate(value["roots"]):
        root_path = f"{path}.roots[{index}]"
        if not isinstance(root, dict) or set(root) not in (
            {"id", "materialRole", "node"},
            {"id", "materialRole", "material", "node"},
        ):
            raise CaeError("invalid_input", f"{root_path} fields are invalid")
        root_id = _non_empty_string(root.get("id"), f"{root_path}.id")
        if root_id in roots:
            raise CaeError("invalid_input", f"{path} root ids must be unique")
        _non_empty_string(root.get("materialRole"), f"{root_path}.materialRole")
        if "material" in root:
            _validate_material(root["material"], f"{root_path}.material")
        node_ids: set[str] = set()
        surfaces: dict[str, set[int]] = {}
        _validate_node(root.get("node"), f"{root_path}.node", node_ids, surfaces, node_count, 1)
        enforce_triangle_limit(root["node"], f"{root_path}.node")
        root_boolean_work = enforce_boolean_work_limit(root["node"], f"{root_path}.node")
        scene_triangle_count += estimated_triangle_count(root["node"])
        scene_boolean_work = min(MAX_BOOLEAN_WORK + 1, scene_boolean_work + root_boolean_work)
        roots[root_id] = root
        root_nodes[root_id] = surfaces
    if scene_triangle_count > MAX_TRIANGLES:
        raise CaeError(
            "resource_limit",
            f"{path}.roots require {scene_triangle_count} derived triangles; the scene limit is {MAX_TRIANGLES}",
        )
    if scene_boolean_work > MAX_BOOLEAN_WORK:
        raise CaeError(
            "resource_limit",
            f"{path}.roots exceed the estimated Boolean work limit of {MAX_BOOLEAN_WORK}",
        )

    geometry_group_ids: set[str] = set()
    geometry_group_names: set[str] = set()
    for index, group in enumerate(value["geometryGroups"]):
        group_path = f"{path}.geometryGroups[{index}]"
        expected_group = {"id", "name", "kind", "memberIds", "rootIds", "missingMemberIds"}
        if not isinstance(group, dict) or set(group) != expected_group or group.get("kind") != "geometry":
            raise CaeError("invalid_input", f"{group_path} fields are invalid")
        group_id = _non_empty_string(group.get("id"), f"{group_path}.id")
        if group_id in geometry_group_ids:
            raise CaeError("invalid_input", f"{path} geometry group ids must be unique")
        geometry_group_ids.add(group_id)
        group_name = _non_empty_string(group.get("name"), f"{group_path}.name")
        if group_name in geometry_group_names:
            raise CaeError("invalid_input", f"{path} geometry group names must be unique")
        geometry_group_names.add(group_name)
        member_ids = _string_array(group.get("memberIds"), f"{group_path}.memberIds")
        root_ids = _string_array(group.get("rootIds"), f"{group_path}.rootIds")
        missing_ids = _string_array(group.get("missingMemberIds"), f"{group_path}.missingMemberIds")
        if not set(missing_ids).issubset(member_ids):
            raise CaeError("invalid_input", f"{group_path}.missingMemberIds must be a subset of memberIds")
        if any(root_id not in roots for root_id in root_ids):
            raise CaeError("invalid_input", f"{group_path}.rootIds references a missing root")

    surface_group_ids: set[str] = set()
    surface_group_names: set[str] = set()
    for index, group in enumerate(value["surfaceGroups"]):
        group_path = f"{path}.surfaceGroups[{index}]"
        expected_group = {"id", "name", "kind", "memberIds", "selectors", "missingMemberIds"}
        if not isinstance(group, dict) or set(group) != expected_group or group.get("kind") != "surface":
            raise CaeError("invalid_input", f"{group_path} fields are invalid")
        group_id = _non_empty_string(group.get("id"), f"{group_path}.id")
        if group_id in surface_group_ids:
            raise CaeError("invalid_input", f"{path} surface group ids must be unique")
        surface_group_ids.add(group_id)
        group_name = _non_empty_string(group.get("name"), f"{group_path}.name")
        if group_name in surface_group_names:
            raise CaeError("invalid_input", f"{path} surface group names must be unique")
        surface_group_names.add(group_name)
        member_ids = _string_array(group.get("memberIds"), f"{group_path}.memberIds")
        missing_ids = _string_array(group.get("missingMemberIds"), f"{group_path}.missingMemberIds")
        if not set(missing_ids).issubset(member_ids):
            raise CaeError("invalid_input", f"{group_path}.missingMemberIds must be a subset of memberIds")
        if any(_surface_member(member_id) is None for member_id in member_ids):
            raise CaeError("invalid_input", f"{group_path}.memberIds must use canonical /surface/<index> references")
        selectors = group.get("selectors")
        if not isinstance(selectors, list) or len(selectors) > _MAX_ARRAY_ITEMS:
            raise CaeError("invalid_input", f"{group_path}.selectors is invalid")
        missing_set = set(missing_ids)
        resolved_members = [member_id for member_id in member_ids if member_id not in missing_set]
        if len(selectors) != len(resolved_members):
            raise CaeError(
                "invalid_input",
                f"{group_path}.selectors must positionally match non-missing memberIds",
            )
        selector_triples: set[tuple[str, str, int]] = set()
        for selector_index, selector in enumerate(selectors):
            selector_path = f"{group_path}.selectors[{selector_index}]"
            if not isinstance(selector, dict) or set(selector) != {"rootId", "sourceNodeId", "surfaceIndex"}:
                raise CaeError("invalid_input", f"{selector_path} fields are invalid")
            root_id = _non_empty_string(selector.get("rootId"), f"{selector_path}.rootId")
            source_node_id = _non_empty_string(selector.get("sourceNodeId"), f"{selector_path}.sourceNodeId")
            surface_index = selector.get("surfaceIndex")
            if (
                not isinstance(surface_index, int)
                or isinstance(surface_index, bool)
                or surface_index < 0
                or surface_index > _MAX_SAFE_INTEGER
            ):
                raise CaeError("invalid_input", f"{selector_path}.surfaceIndex must be a non-negative safe integer")
            if root_id not in roots:
                raise CaeError("invalid_input", f"{selector_path}.rootId references a missing root")
            if surface_index not in root_nodes[root_id].get(source_node_id, set()):
                raise CaeError("invalid_input", f"{selector_path} does not identify a source surface slot")
            triple = (root_id, source_node_id, surface_index)
            if triple in selector_triples:
                raise CaeError("invalid_input", f"{group_path}.selectors must not contain duplicates")
            selector_triples.add(triple)
            member = _surface_member(resolved_members[selector_index])
            if member is None:
                raise CaeError(
                    "invalid_input",
                    f"{group_path}.memberIds must use <sourceNodeId>/surface/<surfaceIndex>",
                )
            member_source_node_id, member_surface_index = member
            if member_surface_index != surface_index or member_source_node_id != source_node_id:
                raise CaeError(
                    "invalid_input",
                    f"{selector_path} must positionally match its authored surface member",
                )

    draft = {key: item for key, item in value.items() if key != "geometryHash"}
    actual_hash = canonical_geometry_hash(draft)
    if actual_hash != value["geometryHash"]:
        raise CaeError("invalid_input", f"{path}.geometryHash does not match its canonical scene")


def canonical_geometry_hash(scene_without_hash: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(scene_without_hash).encode("utf-8")).hexdigest()


def _surface_member(member_id: str) -> tuple[str, int] | None:
    marker = "/surface/"
    marker_index = member_id.rfind(marker)
    if marker_index <= 0 or marker_index + len(marker) == len(member_id):
        return None
    source_node_id = member_id[:marker_index]
    raw_surface_index = member_id[marker_index + len(marker) :]
    if re.fullmatch(r"(?:0|[1-9]\d*)", raw_surface_index) is None:
        return None
    surface_index = int(raw_surface_index)
    return (source_node_id, surface_index) if surface_index <= _MAX_SAFE_INTEGER else None


def _validate_material(value: Any, path: str) -> None:
    if not isinstance(value, dict) or set(value) not in (
        {"name"},
        {"name", "source"},
        {"name", "version"},
        {"name", "source", "version"},
    ):
        raise CaeError("invalid_input", f"{path} fields are invalid")
    _non_empty_string(value.get("name"), f"{path}.name")
    for key in ("source", "version"):
        if key in value:
            _non_empty_string(value[key], f"{path}.{key}")


def _validate_node(
    value: Any,
    path: str,
    node_ids: set[str],
    surfaces: dict[str, set[int]],
    node_count: list[int],
    depth: int,
) -> None:
    if not isinstance(value, dict) or depth > _MAX_NODE_DEPTH:
        raise CaeError("invalid_input", f"{path} is not a valid geometry node")
    node_count[0] += 1
    if node_count[0] > _MAX_NODES:
        raise CaeError("resource_limit", f"Canonical Geometry may contain at most {_MAX_NODES} nodes")
    node_id = _non_empty_string(value.get("nodeId"), f"{path}.nodeId")
    if node_id in node_ids:
        raise CaeError("invalid_input", f"{path}.nodeId must be unique within its root")
    node_ids.add(node_id)
    kind = value.get("kind")
    if kind == "primitive":
        if set(value) != {"kind", "nodeId", "primitive", "parameters"}:
            raise CaeError("invalid_input", f"{path} primitive fields are invalid")
        primitive = value.get("primitive")
        if primitive not in _PRIMITIVE_SURFACES:
            raise CaeError("invalid_input", f"{path}.primitive is unsupported")
        _validate_primitive_parameters(primitive, value.get("parameters"), f"{path}.parameters")
        if primitive == "cylinder":
            parameters = value["parameters"]
            surfaces[node_id] = {
                1,
                *([0] if parameters["radius"] > 0 else []),
                *([2] if parameters["radius_2"] > 0 else []),
            }
        else:
            surfaces[node_id] = _PRIMITIVE_SURFACES[primitive]
        return
    if kind == "fiber":
        if set(value) != {"kind", "nodeId", "points", "radii", "frames", "radialSegments"}:
            raise CaeError("invalid_input", f"{path} fiber fields are invalid")
        points = value.get("points")
        radii = value.get("radii")
        frames = value.get("frames")
        if (
            not isinstance(points, list)
            or len(points) < 2
            or len(points) > _MAX_ARRAY_ITEMS
            or not isinstance(radii, list)
            or len(radii) != len(points)
            or not isinstance(frames, list)
            or len(frames) != len(points)
        ):
            raise CaeError("invalid_input", f"{path} fiber samples are invalid")
        for index, point in enumerate(points):
            _vector(point, f"{path}.points[{index}]")
        for index, radius in enumerate(radii):
            _positive_number(radius, f"{path}.radii[{index}]")
        for index, frame in enumerate(frames):
            if not isinstance(frame, dict) or set(frame) != {"tangent", "normal", "binormal"}:
                raise CaeError("invalid_input", f"{path}.frames[{index}] fields are invalid")
            for key in ("tangent", "normal", "binormal"):
                _vector(frame[key], f"{path}.frames[{index}].{key}")
        _segment_count(value.get("radialSegments"), 3, f"{path}.radialSegments")
        surfaces[node_id] = {0, 1, 2}
        return
    if kind in {"transform", "instance"}:
        expected = {"kind", "nodeId", "matrix", "child"}
        if kind == "instance":
            expected.add("instanceId")
        if set(value) != expected:
            raise CaeError("invalid_input", f"{path} {kind} fields are invalid")
        if kind == "instance":
            _non_empty_string(value.get("instanceId"), f"{path}.instanceId")
        _matrix(value.get("matrix"), f"{path}.matrix")
        _validate_node(value.get("child"), f"{path}.child", node_ids, surfaces, node_count, depth + 1)
        return
    if kind == "boolean":
        if set(value) != {"kind", "nodeId", "operation", "children"}:
            raise CaeError("invalid_input", f"{path} boolean fields are invalid")
        operation = value.get("operation")
        children = value.get("children")
        minimum = 1 if operation == "union" else 2
        if operation not in {"union", "subtract", "intersect"} or not isinstance(children, list) or len(children) < minimum:
            raise CaeError("invalid_input", f"{path} boolean operands are invalid")
        if len(children) > MAX_BOOLEAN_OPERANDS:
            raise CaeError(
                "resource_limit",
                f"{path}.children may contain at most {MAX_BOOLEAN_OPERANDS} Boolean operands",
            )
        for index, child in enumerate(children):
            _validate_node(child, f"{path}.children[{index}]", node_ids, surfaces, node_count, depth + 1)
        return
    if kind == "shell":
        if set(value) != {"kind", "nodeId", "innerOffset", "outerOffset", "child"}:
            raise CaeError("invalid_input", f"{path} shell fields are invalid")
        inner = _finite_number(value.get("innerOffset"), f"{path}.innerOffset")
        outer = _finite_number(value.get("outerOffset"), f"{path}.outerOffset")
        if inner >= outer:
            raise CaeError("invalid_input", f"{path} shell innerOffset must be less than outerOffset")
        surfaces_before_child = set(surfaces)
        _validate_node(value.get("child"), f"{path}.child", node_ids, surfaces, node_count, depth + 1)
        for descendant_node_id in set(surfaces) - surfaces_before_child:
            del surfaces[descendant_node_id]
        surfaces[node_id] = {0, 1}
        return
    raise CaeError("invalid_input", f"{path}.kind is unsupported")


def _validate_primitive_parameters(primitive: str, value: Any, path: str) -> None:
    if not isinstance(value, dict):
        raise CaeError("invalid_input", f"{path} must be an object")
    if primitive == "box":
        if set(value) != {"size"}:
            raise CaeError("invalid_input", f"{path} fields are invalid")
        size = _vector(value["size"], f"{path}.size")
        if any(item <= 0 for item in size):
            raise CaeError("invalid_input", f"{path}.size values must be positive")
    elif primitive == "cylinder":
        if set(value) != {"radius", "radius_2", "height", "segments"}:
            raise CaeError("invalid_input", f"{path} fields are invalid")
        radius = _non_negative_number(value["radius"], f"{path}.radius")
        radius_2 = _non_negative_number(value["radius_2"], f"{path}.radius_2")
        if radius == 0 and radius_2 == 0:
            raise CaeError("invalid_input", f"{path} radii cannot both be zero")
        _positive_number(value["height"], f"{path}.height")
        _segment_count(value["segments"], 4, f"{path}.segments")
    elif primitive == "sphere":
        if set(value) != {"radius", "segments"}:
            raise CaeError("invalid_input", f"{path} fields are invalid")
        _positive_number(value["radius"], f"{path}.radius")
        _segment_count(value["segments"], 4, f"{path}.segments")
    elif primitive == "curvedEdgeCylinder":
        expected = {"height", "azimuthalCurve", "verticalCurve", "azimuthalSegments", "verticalSegments"}
        if set(value) != expected:
            raise CaeError("invalid_input", f"{path} fields are invalid")
        _positive_number(value["height"], f"{path}.height")
        _fourier_modes(value["azimuthalCurve"], f"{path}.azimuthalCurve")
        vertical = value["verticalCurve"]
        if not isinstance(vertical, dict) or set(vertical) != {"origin", "coefficients"}:
            raise CaeError("invalid_input", f"{path}.verticalCurve fields are invalid")
        _finite_number(vertical["origin"], f"{path}.verticalCurve.origin")
        coefficients = vertical["coefficients"]
        if not isinstance(coefficients, list) or not coefficients or len(coefficients) > _MAX_ARRAY_ITEMS:
            raise CaeError("invalid_input", f"{path}.verticalCurve.coefficients is invalid")
        for index, coefficient in enumerate(coefficients):
            _finite_number(coefficient, f"{path}.verticalCurve.coefficients[{index}]")
        _segment_count(value["azimuthalSegments"], 4, f"{path}.azimuthalSegments")
        _segment_count(value["verticalSegments"], 1, f"{path}.verticalSegments")
    else:
        expected = {"azimuthalCurve", "polarCurve", "azimuthalSegments", "polarSegments"}
        if set(value) != expected:
            raise CaeError("invalid_input", f"{path} fields are invalid")
        _fourier_modes(value["azimuthalCurve"], f"{path}.azimuthalCurve")
        _fourier_modes(value["polarCurve"], f"{path}.polarCurve")
        _segment_count(value["azimuthalSegments"], 4, f"{path}.azimuthalSegments")
        _segment_count(value["polarSegments"], 2, f"{path}.polarSegments")


def _fourier_modes(value: Any, path: str) -> None:
    if not isinstance(value, list) or not value or len(value) > _MAX_ARRAY_ITEMS:
        raise CaeError("invalid_input", f"{path} must be a non-empty array")
    for index, mode in enumerate(value):
        if not isinstance(mode, dict) or set(mode) != {"amplitude", "phase"}:
            raise CaeError("invalid_input", f"{path}[{index}] fields are invalid")
        _non_negative_number(mode["amplitude"], f"{path}[{index}].amplitude")
        _finite_number(mode["phase"], f"{path}[{index}].phase")


def _matrix(value: Any, path: str) -> None:
    if not isinstance(value, list) or len(value) != 16:
        raise CaeError("invalid_input", f"{path} must contain 16 finite row-major numbers")
    matrix = [_finite_number(item, f"{path}[{index}]") for index, item in enumerate(value)]
    if matrix[12:] != [0.0, 0.0, 0.0, 1.0]:
        raise CaeError("invalid_input", f"{path} must be affine with last row [0,0,0,1]")


def _vector(value: Any, path: str) -> tuple[float, float, float]:
    if not isinstance(value, list) or len(value) != 3:
        raise CaeError("invalid_input", f"{path} must contain three finite numbers")
    return tuple(_finite_number(item, f"{path}[{index}]") for index, item in enumerate(value))  # type: ignore[return-value]


def _string_array(value: Any, path: str) -> list[str]:
    if not isinstance(value, list) or len(value) > _MAX_ARRAY_ITEMS:
        raise CaeError("invalid_input", f"{path} must be an array of strings")
    result = [_non_empty_string(item, f"{path}[{index}]") for index, item in enumerate(value)]
    if len(set(result)) != len(result):
        raise CaeError("invalid_input", f"{path} values must be unique")
    return result


def _non_empty_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value or _has_lone_surrogate(value):
        raise CaeError("invalid_input", f"{path} must be a non-empty string")
    return value


def _finite_number(value: Any, path: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise CaeError("invalid_input", f"{path} must be a finite number")
    try:
        number = float(value)
    except (OverflowError, ValueError):
        raise CaeError("invalid_input", f"{path} must be a finite number") from None
    if not math.isfinite(number):
        raise CaeError("invalid_input", f"{path} must be a finite number")
    return number


def _positive_number(value: Any, path: str) -> float:
    number = _finite_number(value, path)
    if number <= 0:
        raise CaeError("invalid_input", f"{path} must be positive")
    return number


def _non_negative_number(value: Any, path: str) -> float:
    number = _finite_number(value, path)
    if number < 0:
        raise CaeError("invalid_input", f"{path} must be non-negative")
    return number


def _segment_count(value: Any, minimum: int, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > _MAX_SEGMENTS:
        raise CaeError("invalid_input", f"{path} must be an integer from {minimum} to {_MAX_SEGMENTS}")
    return value


def _canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, int):
        try:
            number = float(value)
        except OverflowError:
            raise CaeError("invalid_input", "Canonical Geometry contains a non-finite JSON number") from None
        if not math.isfinite(number):
            raise CaeError("invalid_input", "Canonical Geometry contains a non-finite JSON number")
        return _javascript_number(number)
    if isinstance(value, float):
        return _javascript_number(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            _json_string(key) + ":" + _canonical_json(value[key])
            for key in sorted(value)
        ) + "}"
    raise CaeError("invalid_input", "Canonical Geometry contains a non-JSON value")


def _json_string(value: str) -> str:
    normalized: list[str] = []
    index = 0
    while index < len(value):
        code = ord(value[index])
        if 0xD800 <= code <= 0xDBFF and index + 1 < len(value):
            following = ord(value[index + 1])
            if 0xDC00 <= following <= 0xDFFF:
                normalized.append(chr(0x10000 + (code - 0xD800) * 0x400 + following - 0xDC00))
                index += 2
                continue
        if 0xD800 <= code <= 0xDFFF:
            raise CaeError("invalid_input", "Canonical Geometry strings must contain well-formed Unicode")
        normalized.append(value[index])
        index += 1
    return json.dumps("".join(normalized), ensure_ascii=False, separators=(",", ":"))


def _has_lone_surrogate(value: str) -> bool:
    index = 0
    while index < len(value):
        code = ord(value[index])
        if 0xD800 <= code <= 0xDBFF:
            if index + 1 >= len(value) or not 0xDC00 <= ord(value[index + 1]) <= 0xDFFF:
                return True
            index += 2
            continue
        if 0xDC00 <= code <= 0xDFFF:
            return True
        index += 1
    return False


def _javascript_number(value: float) -> str:
    if value == 0:
        return "0"
    absolute = abs(value)
    encoded = repr(value).lower()
    if 1e-6 <= absolute < 1e21 and "e" in encoded:
        fixed = format(Decimal(encoded), "f")
        return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
    if "e" not in encoded:
        return encoded.removesuffix(".0")
    mantissa, exponent = encoded.split("e", 1)
    exponent_value = int(exponent)
    sign = "+" if exponent_value >= 0 else "-"
    return f"{mantissa}e{sign}{abs(exponent_value)}"
