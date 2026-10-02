"""Atomic physical windows, recoverable numerical trials and passive observations."""

import asyncio
from types import SimpleNamespace

import numpy as np

from app.kernel.api.errors import CaeError

from .transient import TransientStepFailure


async def advance_window(invocation, domain, saved, clock, controls, stepper):
    current = float(saved["time"])
    if current >= clock["duration"]:
        raise ValueError("flow task has already reached its configured duration")
    window = int(saved["windows"]) + 1
    end = min(window * clock["windowSize"], clock["duration"])
    if end <= current:
        raise CaeError("solver_convergence", f"flow window cannot advance representable time at {current:g} s, "
                       f"dt={saved['nextDt']:g} s; position and residuals unavailable before a candidate solve")
    solution = SimpleNamespace(pressure=saved["pressure"], velocity=saved["velocity"],
                               face_volume_flux=saved["faceVolumeFlux"])
    count, next_dt, dt_tick = int(saved["steps"]), float(saved["nextDt"]), int(saved["nextDtTick"])
    output_tick = int(np.floor(current / clock["outputInterval"])) + 1
    absolute_divergence, volumes = abs(domain.mesh.divergence), domain.mesh.cell_volumes
    samples = []
    diagnostics = {"retryCount": 0, "iterationCount": 0, "lastDt": 0., "maxCourant": 0.}

    async def report(event):
        if invocation.progress is not None:
            await invocation.progress({**event, "physicalTime": {
                "completed": current, "total": clock["duration"], "dt": used,
            }})

    while current < end:
        if invocation.cancellation is not None:
            invocation.cancellation.raise_if_cancelled()
        rates = (absolute_divergence @ np.abs(solution.face_volume_flux)) / (2 * volumes)
        maximum_rate = float(rates.max())
        courant_limit = .9 * controls["maxCourant"] / maximum_rate if maximum_rate else clock["dt"]
        proposed = min(clock["dt"], next_dt, courant_limit)
        # A global dt lattice makes matching physical step sequences independent
        # of invocation boundaries. Observation ticks never enter this limit.
        lattice = dt_tick * clock["dt"]
        tolerance = 8 * np.finfo(float).eps * max(abs(current), clock["dt"])
        if lattice <= current + tolerance:
            dt_tick += 1
            lattice = dt_tick * clock["dt"]
        used = min(proposed, min(lattice, end) - current)
        rejection = "no candidate could advance time"
        for retry in range(13):
            if not np.isfinite(used) or used <= 0 or current + used <= current:
                raise CaeError("solver_convergence", f"flow cannot advance representable time at {current:g} s, "
                               f"dt={used:g} s; {rejection}")
            if invocation.cancellation is not None:
                invocation.cancellation.raise_if_cancelled()
            try:
                candidate = await stepper.step(
                    pressure=solution.pressure, velocity=solution.velocity,
                    face_volume_flux=solution.face_volume_flux, dt=used, time=current,
                    max_iterations=controls["maxIterations"],
                    max_nonlinear_iterations=controls["maxNonlinearIterations"],
                    tolerance=controls["tolerance"], cancellation=invocation.cancellation,
                    progress=report if invocation.progress is not None else None,
                )
                diagnostics["iterationCount"] += candidate.iterations
                candidate_rates = (absolute_divergence @ np.abs(candidate.face_volume_flux)) / (2 * volumes)
                courant = used * float(candidate_rates.max())
                if np.isfinite(courant) and courant <= controls["maxCourant"] * (1 + 1e-12):
                    break
                cell = int(np.argmax(candidate_rates))
                rejection = (f"Courant {courant:g} exceeds {controls['maxCourant']:g} at cell {cell}, "
                             f"position {domain.mesh.cell_centers[cell].tolist()}; mass={candidate.mass_residual:g}, "
                             f"momentum={candidate.momentum_residual:g}, pressure={candidate.pressure_residual:g}")
            except TransientStepFailure as error:
                diagnostics["iterationCount"] += error.iterations
                rejection = str(error)
            if retry == 12:
                raise CaeError("solver_convergence", f"flow exhausted 12 timestep retries at {current:g} s, "
                               f"dt={used:g} s; {rejection}")
            diagnostics["retryCount"] += 1
            if invocation.progress is not None:
                await report({"stage": "flow-retry", "completed": current,
                              "total": clock["duration"], "message": rejection})
            used *= .5
        accepted = current + used
        if abs(accepted - min(lattice, end)) <= tolerance:
            accepted = min(lattice, end)
        sample_tolerance = 8 * np.finfo(float).eps * max(abs(accepted), clock["outputInterval"])
        while output_tick * clock["outputInterval"] <= accepted + sample_tolerance:
            sampled_time = output_tick * clock["outputInterval"]
            if sampled_time > current + sample_tolerance:
                fraction = float(np.clip((sampled_time - current) / used, 0., 1.))
                samples.append({"times": min(sampled_time, accepted),
                                "pressure": solution.pressure + fraction * (candidate.pressure - solution.pressure),
                                "velocity": solution.velocity + fraction * (candidate.velocity - solution.velocity),
                                "boundaryFlux": (solution.face_volume_flux + fraction *
                                    (candidate.face_volume_flux - solution.face_volume_flux))[domain.mesh.boundary_interface_indices]})
            output_tick += 1
        # Boundary clipping alone must not reduce the next proposal. A rejected
        # trial does reduce it, even if the rejected step ended on a window edge.
        next_dt = min(clock["dt"], 1.25 * (used if retry else proposed))
        solution, current, count = candidate, accepted, count + 1
        diagnostics["lastDt"] = used
        diagnostics["maxCourant"] = max(diagnostics["maxCourant"], courant)
        if invocation.progress is not None:
            await report({"stage": "flow-time", "completed": current, "total": clock["duration"]})
        await asyncio.sleep(0)
    history = dict(saved["history"])
    if samples:
        for name in samples[0]:
            chunk = np.asarray([sample[name] for sample in samples])
            chunk.setflags(write=False)
            history[name] = (*history[name], chunk)
    result = {**saved, "clock": clock, "time": current, "steps": count, "windows": window,
              "nextDt": next_dt, "nextDtTick": dt_tick, "history": history,
              "pressure": solution.pressure, "velocity": solution.velocity,
              "faceVolumeFlux": solution.face_volume_flux}
    return result, solution, diagnostics
