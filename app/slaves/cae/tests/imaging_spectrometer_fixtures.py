"""Publicly built imaging-spectrometer inputs and saved-grid optical metrics."""
import numpy as np
from app.kernel.api import SolverInvocation
from app.kernel.coordinator.plan import RunPlan, detached
from app.kernel.execution import SpawnSolverExecutor


async def trace_imager(measurement, *, budget=1, paths=0):
    program = measurement['experiment']['simulationProgram']
    plan = RunPlan.prepare(measurement, program['tasks'], program['recordedData'])
    spec = plan.task_specs['trace']
    config = detached(spec.task['config'])
    config['parameters']['maxPaths'] = paths
    executor = SpawnSolverExecutor(cpu_budget=budget)
    return await executor.execute(spec.locator, SolverInvocation(
        config=config, state={}, inputs={}, world=plan.world(spec), geometry=None, progress=None,
        descriptor=detached(spec.descriptor)), timeout=150)


def imager_metrics(result):
    signal = result.artifacts['detectorPower']
    power = signal['value'][:, :, 0, 0, :, 0, 0]
    u = np.asarray(signal['axes'][0]['ticks']) * 1000
    v = np.asarray(signal['axes'][1]['ticks']) * 1000
    profile = power.sum(axis=1)
    total = profile.sum(axis=0)
    if np.any(total <= 0):
        raise ValueError('No signal in one or more test wavelengths')
    centers = u @ profile / total
    rms = np.sqrt(np.maximum(0, (u * u) @ profile / total - centers * centers))
    return {'power': total, 'u': centers, 'v': v @ power.sum(axis=0) / total,
            'rms': rms, 'wavelength': 299792458e9 / np.asarray(signal['axes'][4]['ticks'])}
