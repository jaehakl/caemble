from __future__ import annotations

import json
from pathlib import Path
from typing import Any


_REFERENCE_PATH = Path(__file__).with_name("cad_authoring_reference.json")
CAD_AUTHORING_REFERENCE = json.loads(_REFERENCE_PATH.read_text(encoding="utf-8"))

CAD_AUTHORING_CORE: str = CAD_AUTHORING_REFERENCE["core"]
_ELEMENTS_BY_NAME: dict[str, dict[str, Any]] = {}
for _element in CAD_AUTHORING_REFERENCE["elements"]:
    for _name in (_element.get("authoringName"), _element.get("tag")):
        _ELEMENTS_BY_NAME[_name] = _element

CAD_AUTHORING_ELEMENT_NAMES = tuple(sorted(_ELEMENTS_BY_NAME))


def cad_authoring_reference_details(elements: Any) -> dict[str, Any]:
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    for name in elements:
        element = _ELEMENTS_BY_NAME[name]
        tag = element["tag"]
        if tag not in seen:
            seen.add(tag)
            selected.append(element)
    return {
        "elements": selected,
    }
