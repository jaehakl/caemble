"""Frozen numerical precision and response thresholds, using canonical authoring inputs."""

from copy import deepcopy

import numpy as np


def freeze_microheater_precision_mesh(measurement):
    """Keep the original precision when interactive example defaults change."""
    for task in measurement["experiment"]["simulationProgram"]["tasks"].values():
        config = task["config"]
        config["parameters"]["relativeTolerance"]["value"] = 1e-8
        config["parameters"]["linearSolver"] = "cg-amg"
        if task["kernel"]["name"] == "structural-mechanics":
            config["parameters"]["spatialResolution"].update(value=.1, unit="um")
            config["parameters"]["maxIterations"] = 30
        for rule in config["initializations"]:
            parameters = rule["parameters"]
            if rule["methodId"] in ("dc.mesh", "heat.mesh"):
                parameters["maxElementSize"].update(value=.1, unit="um")
            elif rule["methodId"].endswith(".region-mesh"):
                parameters["maxElementSize"].update(value=.05, unit="um")
                parameters["layerSubdivisions"] = 64
            elif rule["methodId"] == "heat.coupling":
                parameters["relativeTolerance"]["value"] = 1e-8
                parameters["absoluteTolerance"]["value"] = 1e-8
                parameters["relaxation"]["value"] = 1.
                parameters["maxIterations"] = 100
    return measurement


def precision_pulse_measurement(catalog_builds, dt):
    # Keep the original physical geometry, material coefficients, 40 ns on/off
    # window and thin-layer refinement. Only the temporal refinement changes.
    measurement = catalog_builds["pulsed-microheater"]
    freeze_microheater_precision_mesh(measurement)
    tasks = measurement["experiment"]["simulationProgram"]["tasks"]
    times = np.arange(round(80e-9 / dt) + 1) * dt
    for task in tasks.values():
        config = task["config"]
        for rule in config["initializations"]:
            parameters = rule["parameters"]
            method = rule["methodId"]
            if method == "heat.time-grid":
                parameters["times"].update(value=times.tolist(), unit="s", axes=[{"length": len(times)}])
        for rule in config.get("boundaryConditions", ()):
            if rule["methodId"] == "dc.pulsed-potential":
                for name in ("onTime", "offTime"):
                    rule["parameters"][name].update(value=40e-9, unit="s")
    variables = {name: value for name, value in measurement["experiment"]["variables"].items()
                 if name not in {"onTime", "offTime"}}
    reference = catalog_builds.measurement("feedback-microheater", variables)
    freeze_microheater_precision_mesh(reference)
    program = measurement["experiment"]["simulationProgram"]
    steady_program = reference["experiment"]["simulationProgram"]
    for task_name in ("electric", "thermal"):
        steady_name = "steady-" + task_name
        program["tasks"][steady_name] = deepcopy(steady_program["tasks"][task_name])
        measurement["experiment"]["taskScenes"][steady_name] = deepcopy(reference["experiment"]["taskScenes"][task_name])
        for mapping in ("taskMaterialSnapshots", "materialSelections", "interactionSelections"):
            measurement[mapping][steady_name] = deepcopy(reference[mapping][task_name])
    for mapping in ("recordedData", "resultContracts", "boxGrids"):
        program[mapping]["steadyMeanTemperature"] = deepcopy(steady_program[mapping]["meanTemperature"])
    program["resultContracts"]["steadyMeanTemperature"]["task"] = "steady-thermal"
    prefix, _ = steady_program["pythonSource"].split('    structural = await sim.run(tasks["structural"]', 1)
    prefix = prefix.replace('tasks["electric"]', 'tasks["steady-electric"]').replace('tasks["thermal"]', 'tasks["steady-thermal"]')
    pulse_body = program["pythonSource"].split("\n", 1)[1]
    assert '    seed = await sim.run(tasks["thermal"])' in pulse_body
    pulse_body = pulse_body.replace('    seed = await sim.run(tasks["thermal"])',
        '    seed = await sim.run(tasks["thermal"], state=thermal["state"])\n'
        '    sim.release(thermal["state"], keep=seed["state"])', 1)
    program["pythonSource"] = (prefix
        + '    await sim.record("steadyMeanTemperature", thermal["artifacts"]["meanTemperature"])\n'
        + '    sim.release(electric["artifacts"])\n'
        + '    sim.release(thermal["artifacts"])\n'
        + '    sim.release(base, keep=thermal["state"])\n'
        + pulse_body)
    return measurement


def pulse_response_times(times, temperature, drive_times, power, steady):
    """Original first-pulse t90/t10: rows are responses, columns seconds/validity."""
    if len(temperature) != len(times) or len(power) + 1 != len(times):
        raise ValueError("Response times require scalar accepted histories including the initial Heat sample.")
    if not np.array_equal(drive_times, times[1:]):
        raise ValueError("Electrical and thermal physical times differ.")
    first_off = next((i for i, value in enumerate(power) if value == 0), -1)
    result = np.zeros((2, 2))
    baseline = temperature[0]
    if first_off <= 0 or steady <= baseline:
        return result
    off_end = next((i for i in range(first_off + 1, len(power)) if power[i] > 0), len(power))
    thresholds = (baseline + .9 * (steady - baseline), baseline + .1 * (temperature[first_off] - baseline))
    for row, (start, end, threshold) in enumerate(((0, first_off, thresholds[0]), (first_off, off_end, thresholds[1]))):
        for i in range(start + 1, end + 1):
            crossed = (temperature[i - 1] < threshold <= temperature[i] if row == 0
                       else temperature[i - 1] > threshold >= temperature[i])
            if crossed:
                result[row] = (times[i - 1] + (times[i] - times[i - 1])
                               * (threshold - temperature[i - 1]) / (temperature[i] - temperature[i - 1]) - times[start], 1)
                break
    return result
