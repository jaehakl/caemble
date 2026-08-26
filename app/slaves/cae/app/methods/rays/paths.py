from __future__ import annotations

from collections.abc import Mapping
from typing import Any

RAY_PATH_BUNDLE_KIND = "caemble.ray-path-bundle/v1"


def typed_ray_path_bundle(bundle: Mapping[str, Any]) -> dict[str, Any]:
    return {"kind": RAY_PATH_BUNDLE_KIND, "members": bundle}

