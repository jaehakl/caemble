"""Heat-owned physical clock and unrelaxed electrothermal convergence checks."""

from dataclasses import replace

import numpy as np

from app.kernel.api import BundleValue, ContentKey, FieldValue
from app.kernel.api.world import scalar_parameter
from app.methods.coupling.clock import read_step_control
from .formulation import HeatSolution, solve_heat


def thermal_clock(invocation, setup):
    parameters = invocation.config["parameters"]
    analysis = parameters.get("analysis", "steady")
    if analysis not in ("steady", "transient"):
        raise ValueError("Heat supports steady or transient analysis")
    rules = invocation.config["initializations"]
    coupling = next((item["parameters"] for item in rules if item["methodId"] == "heat.coupling"), None)
    clock = next((item["parameters"] for item in rules if item["methodId"] == "heat.time-grid"), None)
    if (analysis == "transient") != (clock is not None):
        raise ValueError("transient Heat and heat.time-grid must be configured together")
    times = None
    if clock is not None:
        raw = clock["times"]
        times = np.asarray(raw["value"] if isinstance(raw, dict) else raw, dtype=float)
        if times.ndim != 1 or len(times) < 2 or not np.isfinite(times).all() or times[0] != 0 or np.any(np.diff(times) <= 0):
            raise ValueError("thermal times must start at zero and increase strictly")
    initial = scalar_parameter((clock or coupling)["initialTemperature"]) if clock is not None or coupling is not None else 0.
    identity = ContentKey.from_parts("heat-physical-state-v1", setup.mesh.field_domain.identity, times,
        setup.conductivity, setup.volumetric_capacity, setup.boundaries, setup.interfaces, initial).digest
    return analysis, times, initial, coupling, identity


def next_step(domain, times, index, identity):
    if times is None:
        return None
    following = min(index + 1, len(times) - 1)
    return BundleValue("caemble.heat/step-control@1", {
        "startTime": float(times[index]), "endTime": float(times[following]), "index": np.array(following, dtype=np.int32),
        "complete": following == index,
    }, {"assemblyIdentity": domain.metadata["assemblyIdentity"], "clockIdentity": identity})


def read_estimate(artifact, domain):
    field = artifact.value
    if not isinstance(field, FieldValue) or str(field.location) != "node" or field.quantity_kind != "thermodynamics.Temperature" or field.unit != "K":
        raise ValueError("coupling estimate must be a native kelvin temperature field")
    source = field.domain
    if (source.identity != domain.identity or not np.array_equal(source.points, domain.points)
            or not np.array_equal(source.cells["tet4"], domain.cells["tet4"])
            or any(not np.array_equal(source.metadata[key], domain.metadata[key])
                   for key in ("parentCellIds", "parentNodeIds", "cellRegions", "regionIds"))
            or source.metadata.get("assemblyIdentity") != domain.metadata.get("assemblyIdentity")):
        raise ValueError("coupling estimate belongs to a different thermal domain")
    values = np.asarray(field.values)
    if values.shape != (len(domain.points),) or not np.isfinite(values).all():
        raise ValueError("coupling estimate must cover every thermal node")
    return values, field.metadata


def evaluate_heat_invocation(invocation, setup):
    analysis, times, initial, coupling, identity = thermal_clock(invocation, setup)
    domain = setup.mesh.field_domain
    saved = invocation.state.get("heat_transfer", {}).get(invocation.task_name)
    if saved is not None and saved["identity"] != identity:
        raise ValueError("heat state belongs to a different physical problem or time grid")
    source = invocation.inputs.get("heatSource")
    estimate = invocation.inputs.get("temperatureEstimate")
    step_artifact = invocation.inputs.get("stepControl")
    initialized = ((analysis == "transient" and saved is None)
                   or (analysis == "steady" and coupling is not None and source is None and estimate is None))
    if initialized:
        if source is not None or estimate is not None or step_artifact is not None:
            raise ValueError("Heat must initialize its temperature and clock before advancing")
        temperature = np.full(len(domain.points), initial)
        for node, value in setup.fixed.items():
            temperature[node] = value
        flux = -np.einsum("eij,ej->ei", setup.conductivity, setup.mesh.elements.gradient(temperature))
        energy = 0. if setup.volumetric_capacity is None else float(
            setup.mesh.elements.volume_load(setup.volumetric_capacity) @ (temperature - initial))
        result = HeatSolution(setup, temperature, flux, 0., 0., 0., 0., 0., 0., energy)
        time, index, converged, iteration, residual, phase = 0., 0, False, 0, 0., "iterate"
        proposed = temperature.copy()
    else:
        index, time, previous, dt = 0, 0., None, None
        if analysis == "transient":
            step = read_step_control(step_artifact, domain)
            index = saved["index"] + 1
            if (index >= len(times) or step["clockIdentity"] != identity or step["index"] != index
                    or step["startTime"] != times[index - 1] or step["endTime"] != times[index]):
                raise ValueError("step-control does not advance the supplied accepted Heat state")
            time, dt = float(times[index]), float(times[index] - times[index - 1])
            previous = saved["temperature"]
            if source is not None and "clockIdentity" in source.value.metadata:
                if source.value.metadata["clockIdentity"] != identity or source.value.metadata.get("time") != time:
                    raise ValueError("Joule source belongs to another physical time trial")
        elif step_artifact is not None:
            raise ValueError("steady Heat does not accept a physical step-control")
        result = solve_heat(setup, None if source is None else source.value,
            scalar_parameter(invocation.config["parameters"]["relativeTolerance"]), invocation.cancellation,
            backend=invocation.config["parameters"].get("linearSolver", "direct"), previous=previous,
            time_step=dt, reference_temperature=initial)
        if source is not None and "inputPower" in source.value.metadata:
            supplied = float(source.value.metadata["inputPower"])
            if abs(supplied - result.source_power) > 1e-6 * max(abs(supplied), abs(result.source_power), np.finfo(float).tiny):
                raise ValueError("DC input power and transferred Heat source do not balance")
        converged, iteration, residual, phase = True, 0, 0., "iterate"
        proposed = result.temperature
        if coupling is not None:
            if estimate is None:
                raise ValueError("electrothermal coupling requires a temperature estimate")
            values, metadata = read_estimate(estimate, domain)
            if metadata.get("trialTime", time) != time or metadata.get("clockIdentity", identity) != identity:
                raise ValueError("temperature estimate belongs to another physical time trial")
            iteration = int(metadata.get("couplingIteration", 0)) + 1
            relative = scalar_parameter(coupling.get("relativeTolerance", 1e-8))
            absolute = scalar_parameter(coupling.get("absoluteTolerance", 1e-8))
            weight = scalar_parameter(coupling.get("relaxation", .5))
            maximum = int(scalar_parameter(coupling.get("maxIterations", 100)))
            if not 0 < weight <= 1 or min(relative, absolute) <= 0 or maximum < 2:
                raise ValueError("invalid electrothermal coupling tolerances or relaxation")
            error = float(np.max(np.abs(result.temperature - values)))
            scale = max(float(np.max(np.abs(result.temperature - initial))), float(np.max(np.abs(values - initial))), 1.)
            residual = error / scale
            within = error <= absolute + relative * scale
            converged = within and metadata.get("couplingPhase") == "verify"
            phase = "verify" if within else "iterate"
            proposed = result.temperature if within else values + weight * (result.temperature - values)
            imbalance = abs(result.source_power - result.outward_power - result.storage_power)
            power_scale = max(abs(result.source_power), abs(result.outward_power), abs(result.storage_power), np.finfo(float).tiny)
            if imbalance > power_scale * 1e-6 and power_scale > 1e-15:
                raise ValueError("electrothermal candidate violates the thermal energy balance")
            if not converged and iteration >= maximum:
                raise ValueError(f"electrothermal coupling did not converge after {iteration} iterations: residual {residual:g}")
    accepted = initialized or converged
    metadata = {"clockIdentity": identity, "time": time, "analysis": analysis, "accepted": accepted}
    proposal_metadata = {"clockIdentity": identity, "trialTime": time, "couplingIteration": iteration,
        "couplingPhase": phase, "accepted": False}
    temperature = FieldValue(domain, "node", "thermodynamics.Temperature", "K", result.temperature, metadata=metadata)
    proposal = replace(temperature, values=proposed, metadata=proposal_metadata)
    state = {"identity": identity, "temperature": result.temperature, "time": time, "index": index}
    control = next_step(domain, times, index, identity)
    observations = {"time": time, "initialized": initialized, "complete": times is None or index == len(times) - 1,
        "stepCount": 0 if times is None else len(times) - 1,
        "couplingConverged": converged, "couplingIteration": iteration, "couplingResidual": residual}
    return result, temperature, proposal, control, state, saved, accepted, observations
