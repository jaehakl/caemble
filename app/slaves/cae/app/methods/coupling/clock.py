"""Typed interval validation; each consuming solver owns its physical stepping."""

import numpy as np

from app.kernel.api import BundleValue


def read_step_control(artifact, domain):
    value = None if artifact is None else artifact.value
    if not isinstance(value, BundleValue) or value.bundle_type != "caemble.heat/step-control@1":
        raise ValueError("a native heat step-control input is required")
    if value.metadata.get("assemblyIdentity") != domain.metadata.get("assemblyIdentity"):
        raise ValueError("step-control belongs to a different assembly")
    result = dict(value.members)
    start, end = float(result["startTime"]), float(result["endTime"])
    if (result["complete"] or not value.metadata.get("clockIdentity") or start < 0
            or not np.isfinite([start, end]).all() or end <= start
            or int(result["index"]) != result["index"] or result["index"] < 1):
        raise ValueError("step-control requires a positive finite time interval and integer index")
    return {**result, "startTime": start, "endTime": end, "clockIdentity": value.metadata.get("clockIdentity")}
