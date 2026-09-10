"""ABI 3 조합: 모델 준비 → 계산 → 상태/공개 결과 구성."""

import numpy as np

from app.kernel.api import (
    SolverImplementation,
    SolverInvocation,
    SolverResult,
    StatePatch,
)

from .analysis import (
    buckling_analysis,
    harmonic_analysis,
    initial_solution,
    initialize_acceleration,
    modal_analysis,
    static_analysis,
)
from .coupling import (
    advance_window,
    apply_resultant_loads,
    clock_tolerance,
    initialize_motion,
    predict_motion,
)
from .domain import build_model, parameter
from .formulation import prepare_matrices
from .outputs import build_outputs, configure_history
from .state import append_history, encode_state, read_state


async def run(invocation: SolverInvocation) -> SolverResult:
    model = build_model(invocation)
    configure_history(model, invocation.config["outputs"])
    parameters = {key: parameter(value) for key, value in invocation.config["parameters"].items()}
    if invocation.cancellation is not None:
        invocation.cancellation.raise_if_cancelled()
    matrices = prepare_matrices(model)
    stiffness, mass, damping, prepared = matrices
    analysis = parameters["analysis"]
    motion = None
    coupling_residual, converged = 0.0, True
    history_complete = True
    patch = StatePatch()
    if analysis == "transient":
        time_rule = next(item for item in invocation.config["initializations"] if item["methodId"] == "fea.time")
        settings = {key: parameter(value) for key, value in time_rule["parameters"].items()}
        if min(settings["dt"], settings["windowSize"], settings["outputInterval"], settings["duration"]) <= 0:
            raise ValueError("structural time increments and duration must be positive")
        if min(settings["dampingMass"], settings["dampingStiffness"]) < 0 or not 0 < settings["relaxation"] <= 1 or settings["couplingTolerance"] <= 0 or settings["maxCouplingIterations"] < 1:
            raise ValueError("damping must be nonnegative and coupling controls must be positive with relaxation <= 1")
        saved = invocation.state.get("structural_mechanics", {}).get(invocation.task_name)
        if saved is None:
            solution = initialize_motion(model, invocation.config["initializations"])
            gravity = np.zeros(model.size)
            gravity.reshape(-1, 6)[:, :3] = model.gravity
            initial_pitch = 0.0 if model.rotor is None else model.rotor["initialPitch"]
            initial_damping = damping + settings["dampingMass"] * mass
            solution = initialize_acceleration(model, solution, prepared, stiffness, mass, initial_damping, model.force.ravel() + mass @ gravity, bool(parameters["geometricNonlinear"]), initial_pitch, damping_stiffness=settings["dampingStiffness"])
            solution.history = {}
            append_history(model, solution, initial_pitch)
            motion = predict_motion(model, solution, settings)
        else:
            solution = read_state(model, saved)
            if solution.time >= settings["duration"] - clock_tolerance(settings):
                raise ValueError("structural task has already reached its configured duration")
            solution, motion, coupling_residual, converged = advance_window(invocation, model, solution, settings, matrices)
        history_complete = converged and solution.time >= settings["duration"] - clock_tolerance(settings)
        if "structural_mechanics" not in invocation.state:
            patch = patch.put(("structural_mechanics",), {})
        patch = patch.put(("structural_mechanics", invocation.task_name), encode_state(model, solution))
    elif analysis in ("static", "buckling"):
        if analysis == "buckling" and (parameters["geometricNonlinear"] or model.contacts or any(e.material["model"] == "mechanics.j2-plasticity@1" for e in model.elements)):
            raise ValueError("linear buckling requires an elastic small-displacement preload without contact")
        apply_resultant_loads(invocation, model)
        solution = static_analysis(model, prepared, stiffness, mass, parameters["relativeTolerance"], int(parameters["maxIterations"]), bool(parameters["geometricNonlinear"]), invocation.cancellation)
        if analysis == "buckling":
            spectrum_rule = next(item for item in invocation.config["initializations"] if item["methodId"] == "fea.spectrum")
            solution.spectrum = buckling_analysis(model, stiffness, solution.displacement, prepared, int(parameter(spectrum_rule["parameters"]["modeCount"])))
    elif analysis in ("modal", "harmonic"):
        if model.contacts or any(e.material["model"] == "mechanics.j2-plasticity@1" for e in model.elements):
            raise ValueError("modal/harmonic analysis currently requires elastic elements without contact")
        solution = initial_solution(model)
        spectrum_rule = next(item for item in invocation.config["initializations"] if item["methodId"] == "fea.spectrum")
        spectrum = {key: parameter(value) for key, value in spectrum_rule["parameters"].items()}
        solution.spectrum = modal_analysis(model, stiffness, mass, int(spectrum["modeCount"])) if analysis == "modal" else harmonic_analysis(model, stiffness, mass, damping, spectrum["frequencies"])
    else:
        raise ValueError(f"unsupported structural analysis {analysis}")
    if not solution.history:
        append_history(model, solution)
    if invocation.progress is not None:
        await invocation.progress({"stage": "structural-response", "completed": 1, "total": 1})
    return SolverResult(state_patch=patch, artifacts=build_outputs(invocation.config, invocation.descriptor, model, solution, motion, history_complete=history_complete), observations={"time": float(solution.time), "iterations": int(solution.iterations), "relativeResidual": float(solution.residual), "couplingResidual": float(coupling_residual), "couplingConverged": bool(converged), "strainEnergy": float(solution.strain_energy), "kineticEnergy": float(solution.kinetic_energy)})


implementation = SolverImplementation(abi_version=3, run=run)
