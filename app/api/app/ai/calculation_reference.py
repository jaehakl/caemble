from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


REFERENCE_PATH = Path(__file__).with_name("calculation_authoring_reference.json")


@lru_cache(maxsize=1)
def calculation_authoring_reference() -> dict[str, Any]:
    with REFERENCE_PATH.open("r", encoding="utf-8") as file:
        value = json.load(file)
    if not isinstance(value, dict):
        raise RuntimeError("Calculation authoring reference is invalid")
    return value


def calculation_authoring_core() -> str:
    reference = calculation_authoring_reference()
    return json.dumps(
        {
            "language": reference["language"],
            "contract": reference["contract"],
            "limits": reference["limits"],
            "mathjsGroups": [group["group"] for group in reference["mathjs"]],
            "skeleton": reference["skeleton"],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def calculation_authoring_reference_details(sections: list[str]) -> dict[str, Any]:
    reference = calculation_authoring_reference()
    allowed = {"contract", "limits", "mathjs", "declaration", "skeleton"}
    requested = list(dict.fromkeys(sections))
    if not requested or any(section not in allowed for section in requested):
        raise ValueError("Calculation reference section is not supported")
    return {"language": reference["language"], **{section: reference[section] for section in requested}}
