"""Accepted quasi-static thermal snapshots and the existing deformation playback."""

import numpy as np

from app.kernel.api import ContentKey
from app.methods.fields.history import append_box_history, append_history_chunk
from .outputs.build import build_outputs


def build_thermal_history_outputs(invocation, model, solution):
    metadata = invocation.inputs["temperature"].value.metadata
    time = float(metadata["time"])
    identity = ContentKey.from_parts("structural-thermal-history-v1", model.identity,
        invocation.world["materials"], metadata["clockIdentity"]).digest
    previous = invocation.state.get("structural_thermal", {}).get(invocation.task_name)
    if previous is not None and (previous["identity"] != identity or time <= previous["time"]):
        raise ValueError("thermal structural history requires the same model and increasing accepted times")
    times = (*(previous["times"] if previous else ()), np.array([time]))
    count = len(model.points) if model.physical_node_count is None else model.physical_node_count
    displacements = (*(previous["displacements"] if previous else ()), np.array([solution.displacement[:count, :3]]))
    solution.time = time
    solution.history = {"times": times, "displacement": displacements}
    config = {**invocation.config, "outputs": [{**item, "methodId": item["methodId"].removesuffix("-history")}
                                              for item in invocation.config["outputs"]]}
    artifacts, exports, visuals = build_outputs(config, invocation.descriptor, model, solution)
    history_keys = {item["key"] for item in invocation.config["outputs"] if item["methodId"].endswith("-history")}
    definitions = {item["methodId"]: item for item in invocation.descriptor["methods"]["outputs"]}
    for output in invocation.config["outputs"]:
        if output["key"] in history_keys:
            # Reuse static sampling, but retain the requested history contract's
            # metadata rather than the static method's configuration profile.
            artifacts[output["key"]]["boxGrid"] = {
                **output["boxGrid"], **definitions[output["methodId"]]["data"]["boxGrid"]}
    box_history = None
    if history_keys:
        box_history, values = append_box_history(None if previous is None else previous["boxHistory"],
            {key: artifacts[key] for key in history_keys}, time, identity)
        for output in invocation.config["outputs"]:
            if output["key"] in history_keys and output["parameters"].get("scope", "cumulative") != "cumulative":
                scope = output["parameters"]["scope"]
                if scope not in ("latest-window", "final"):
                    raise ValueError("thermal history scope must be cumulative, latest-window or final")
                current = artifacts[output["key"]]
                axes = [dict(axis) for axis in current["axes"]]
                axes[3] = {"ticks": np.array([time]), "unit": "s"}
                values[output["key"]] = {**current, "axes": axes}
        artifacts.update(values)
    # Keep this invocation's last sample separate while building outputs, then
    # group small stored frames so subsequent children can use mmap transport.
    stored_displacements = append_history_chunk(previous["displacements"] if previous else (),
        displacements[-1], axis=0)
    saved = {"identity": identity, "time": time, "times": times, "displacements": stored_displacements, "boxHistory": box_history}
    return artifacts, exports, visuals, saved
