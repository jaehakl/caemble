"""Reproducible flow checkpoints and native observation chunks; no sparse workspace."""

import numpy as np

from app.kernel.api import ContentKey
from app.methods.finite_volume.tetrahedral import create_fv_mesh

from .domain import FlowDomain, parameter


def read_settings(config, analysis):
    controls = {name: parameter(config["parameters"].get(name, default)) for name, default in
                (("maxIterations", 1000), ("maxNonlinearIterations", 30), ("tolerance", 1e-8), ("maxCourant", .5))}
    for name, value in controls.items():
        if not np.isfinite(value) or value <= 0:
            raise ValueError(f"flow {name} must be finite and positive")
        if name in {"maxIterations", "maxNonlinearIterations"} and (isinstance(value, bool) or int(value) != value):
            raise ValueError(f"flow {name} must be a positive integer")
        if name in {"maxIterations", "maxNonlinearIterations"}:
            controls[name] = int(value)
    rules = [rule for rule in config["initializations"] if rule["methodId"] == "flow.time"]
    if analysis == "steady-stokes":
        if rules:
            raise ValueError("steady-stokes does not accept flow.time initialization")
        return controls, None
    if analysis != "transient-navier-stokes":
        raise ValueError(f"unsupported incompressible flow analysis {analysis!r}")
    if len(rules) != 1 or rules[0].get("target"):
        raise ValueError("transient-navier-stokes requires exactly one target-free flow.time initialization")
    clock = {name: float(parameter(rules[0]["parameters"][name]))
             for name in ("dt", "duration", "windowSize", "outputInterval")}
    if any(not np.isfinite(value) or value <= 0 for value in clock.values()):
        raise ValueError("flow time settings must be finite and positive")
    return controls, clock


def save_domain(domain):
    return {"points": domain.mesh.points, "cells": domain.mesh.cells,
            "boundaryFaces": domain.metadata["boundaryFaces"], "metadata": domain.metadata,
            "density": domain.density, "viscosity": domain.viscosity, "gravity": domain.gravity,
            "boundaryVelocity": domain.boundary_velocity, "boundaryPressure": domain.boundary_pressure,
            "requestIdentity": domain.identity,
            "identity": str(ContentKey.from_parts("incompressible-flow.fixed-mesh.v2", domain.identity,
                domain.mesh.points, domain.mesh.cells, domain.metadata["boundaryFaces"]))}


def initial_state(domain, solution, clock):
    return {"model": save_domain(domain), "clock": clock, "time": 0., "steps": 0, "windows": 0,
            "nextDt": clock["dt"], "nextDtTick": 1, "pressure": solution.pressure, "velocity": solution.velocity,
            "faceVolumeFlux": solution.face_volume_flux,
            "history": {"times": (np.asarray([0.]),),
                        "pressure": (solution.pressure[None, :],),
                        "velocity": (solution.velocity[None, :, :],)}}


def read_checkpoint(saved, request, clock):
    if saved["model"]["requestIdentity"] != request["identity"]:
        raise ValueError("flow checkpoint belongs to a different geometry, material, boundary or integration model")
    if any(saved["clock"][name] != clock[name] for name in ("dt", "duration", "windowSize")):
        raise ValueError("flow continuation requires the checkpoint's physical time settings")
    model = saved["model"]
    mesh = create_fv_mesh(model["points"], model["cells"], model["boundaryFaces"])
    return FlowDomain(mesh, model["density"], model["viscosity"], model["gravity"],
                      model["boundaryVelocity"], model["boundaryPressure"], model["requestIdentity"], model["metadata"])


def history_values(saved):
    """A window endpoint is exposed without becoming a permanent observation tick."""
    result = {name: np.concatenate(chunks) for name, chunks in saved["history"].items()}
    endpoint = {"times": saved["time"], "pressure": saved["pressure"], "velocity": saved["velocity"]}
    tolerance = 8 * np.finfo(float).eps * max(abs(saved["time"]), np.finfo(float).tiny)
    if abs(result["times"][-1] - saved["time"]) <= tolerance:
        result["times"][-1] = saved["time"]
    else:
        result = {name: np.concatenate((value, np.asarray([endpoint[name]]))) for name, value in result.items()}
    return result
