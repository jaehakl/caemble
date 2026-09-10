"""모노파일의 명시적 부재와 구조 interface를 연결한다."""

from collections.abc import Mapping

import numpy as np

from app.kernel.api import BundleValue, SolverInvocation


def prepare_hydrodynamics(invocation: SolverInvocation):
    settings = {
        key: value["value"]
        if isinstance(value, Mapping) and "value" in value
        else value
        for key, value in invocation.config["parameters"].items()
    }
    rule = next(
        item
        for item in invocation.config["initializations"]
        if item["methodId"] == "hydro.members"
    )
    members = {
        key: np.asarray(
            value["value"] if isinstance(value, Mapping) and "value" in value else value
        )
        for key, value in rule["parameters"].items()
    }
    interface, motion = (
        invocation.inputs["model"].value,
        invocation.inputs["motion"].value,
    )
    if not isinstance(interface, BundleValue) or not isinstance(motion, BundleValue):
        raise TypeError("hydrodynamics requires interface and motion bundles")
    model, history = interface.members, motion.members
    if model["modelIdentity"] != history["modelIdentity"] or not np.array_equal(
        model["nodeIds"], history["nodeIds"]
    ):
        raise ValueError("hydrodynamic model and motion must identify the same nodes")
    indices = {int(node): index for index, node in enumerate(model["nodeIds"])}
    members["indices"] = np.asarray(
        [[indices[int(node)] for node in pair] for pair in members["memberNodes"]],
        dtype=int,
    )
    previous = invocation.state.get("hydrodynamic_loading", {}).get(
        invocation.task_name, {}
    )
    return settings, members, model, history, previous
