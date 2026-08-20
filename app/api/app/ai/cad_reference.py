from __future__ import annotations

import json
from pathlib import Path
from typing import Any


_REFERENCE_PATH = Path(__file__).with_name("cad_authoring_reference.json")
CAD_AUTHORING_REFERENCE = json.loads(_REFERENCE_PATH.read_text(encoding="utf-8"))

if (
    not isinstance(CAD_AUTHORING_REFERENCE, dict)
    or CAD_AUTHORING_REFERENCE.get("schemaVersion") != 1
    or CAD_AUTHORING_REFERENCE.get("apiVersion") != 8
    or not isinstance(CAD_AUTHORING_REFERENCE.get("core"), str)
    or not isinstance(CAD_AUTHORING_REFERENCE.get("elements"), list)
    or len(CAD_AUTHORING_REFERENCE["elements"]) != 14
):
    raise RuntimeError("Generated CAD authoring reference is invalid")

CAD_AUTHORING_REFERENCE_HASH = CAD_AUTHORING_REFERENCE.get("referenceHash")
PROMPT_TOOL_VERSION = CAD_AUTHORING_REFERENCE.get("promptToolVersion")
if (
    not isinstance(CAD_AUTHORING_REFERENCE_HASH, str)
    or len(CAD_AUTHORING_REFERENCE_HASH) != 64
    or PROMPT_TOOL_VERSION != f"caemble-ai-agent-v4-{CAD_AUTHORING_REFERENCE_HASH[:12]}"
):
    raise RuntimeError("Generated CAD authoring reference version is invalid")

CAD_AUTHORING_CORE: str = CAD_AUTHORING_REFERENCE["core"]
_ELEMENTS_BY_NAME: dict[str, dict[str, Any]] = {}
for _element in CAD_AUTHORING_REFERENCE["elements"]:
    if not isinstance(_element, dict):
        raise RuntimeError("Generated CAD authoring element is invalid")
    for _name in (_element.get("authoringName"), _element.get("tag")):
        if not isinstance(_name, str) or not _name or (
            _name in _ELEMENTS_BY_NAME and _ELEMENTS_BY_NAME[_name] is not _element
        ):
            raise RuntimeError("Generated CAD authoring element name is invalid")
        _ELEMENTS_BY_NAME[_name] = _element

CAD_AUTHORING_ELEMENT_NAMES = tuple(sorted(_ELEMENTS_BY_NAME))


def cad_authoring_reference_details(elements: Any) -> dict[str, Any]:
    if (
        not isinstance(elements, list)
        or not 1 <= len(elements) <= len(CAD_AUTHORING_REFERENCE["elements"])
        or any(not isinstance(name, str) for name in elements)
    ):
        raise ValueError("elements must contain between 1 and 14 CAD authoring names or tags")
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for name in elements:
        element = _ELEMENTS_BY_NAME.get(name)
        if element is None:
            raise ValueError(f"CAD authoring element is not supported: {name}")
        tag = element["tag"]
        if tag not in seen:
            seen.add(tag)
            selected.append(element)
    return {
        "schemaVersion": CAD_AUTHORING_REFERENCE["schemaVersion"],
        "apiVersion": CAD_AUTHORING_REFERENCE["apiVersion"],
        "declarationFingerprint": CAD_AUTHORING_REFERENCE["declarationFingerprint"],
        "referenceHash": CAD_AUTHORING_REFERENCE_HASH,
        "elements": selected,
    }
