"""Catalog 입력을 공력 계산 배열로 준비한다. 형상·계수는 여기서 추측하지 않는다."""

from collections.abc import Mapping

import numpy as np

from app.kernel.api import BundleValue, SolverInvocation


def prepare_aerodynamics(invocation: SolverInvocation):
    settings = {
        key: value["value"]
        if isinstance(value, Mapping) and "value" in value
        else value
        for key, value in invocation.config["parameters"].items()
    }
    rule = next(
        item
        for item in invocation.config["initializations"]
        if item["methodId"] == "aero.blade-sections"
    )
    sections = {
        key: np.asarray(
            value["value"] if isinstance(value, Mapping) and "value" in value else value
        )
        for key, value in rule["parameters"].items()
    }
    interface = invocation.inputs["model"].value
    motion = invocation.inputs["motion"].value
    if not isinstance(interface, BundleValue) or not isinstance(motion, BundleValue):
        raise TypeError("aerodynamics requires interface and motion bundles")
    model, history = interface.members, motion.members
    if model["modelIdentity"] != history["modelIdentity"] or not np.array_equal(
        model["nodeIds"], history["nodeIds"]
    ):
        raise ValueError("aerodynamic model and motion must identify the same nodes")
    indices = {int(node): index for index, node in enumerate(model["nodeIds"])}
    sections["indices"] = np.asarray(
        [indices[int(node)] for node in sections["nodeIds"]], dtype=int
    )
    previous = invocation.state.get("aerodynamic_loading", {}).get(
        invocation.task_name, {}
    )
    return settings, sections, model, history, previous
