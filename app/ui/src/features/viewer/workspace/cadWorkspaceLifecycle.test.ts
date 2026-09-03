import { describe, expect, it } from 'vitest'
import { cadWorkspaceLifecycleReducer, initialCadWorkspaceLifecycleState } from './cadWorkspaceLifecycle'

describe('cadWorkspaceLifecycleReducer', () => {
  it('models source checking, compilation, evaluation, material resolution, and readiness', () => {
    const checking = cadWorkspaceLifecycleReducer(initialCadWorkspaceLifecycleState, { type: 'sourceChecking' })
    const compiling = cadWorkspaceLifecycleReducer(checking, { type: 'compilationStarted' })
    const evaluating = cadWorkspaceLifecycleReducer(compiling, { type: 'evaluationStarted' })
    const resolving = cadWorkspaceLifecycleReducer(evaluating, { type: 'materialsResolutionStarted' })
    const ready = cadWorkspaceLifecycleReducer(resolving, { type: 'evaluationSucceeded' })

    expect(checking.status).toBe('Checking')
    expect(compiling.status).toBe('Compiling')
    expect(evaluating.status).toBe('Evaluating')
    expect(resolving.status).toBe('Resolving Materials')
    expect(ready).toMatchObject({ status: 'Ready', error: null })
  })

  it('keeps the prepared-document and pending-candidate paths explicit', () => {
    const failed = cadWorkspaceLifecycleReducer(initialCadWorkspaceLifecycleState, {
      type: 'evaluationFailed',
      error: { title: 'Compile Error', message: 'invalid source' },
    })
    const prepared = cadWorkspaceLifecycleReducer(failed, { type: 'evaluationStarted' })
    const pending = cadWorkspaceLifecycleReducer(prepared, { type: 'candidatePending' })
    const cleared = cadWorkspaceLifecycleReducer(failed, { type: 'sourceCleared' })

    expect(prepared).toMatchObject({ status: 'Evaluating', error: null })
    expect(pending.status).toBe('Checking')
    expect(cleared).toMatchObject({ status: 'Ready', error: null })
  })

  it('models rendering success and failure without placing rendered data in state', () => {
    const rendering = cadWorkspaceLifecycleReducer(initialCadWorkspaceLifecycleState, { type: 'renderStarted' })
    const ready = cadWorkspaceLifecycleReducer(rendering, { type: 'renderSucceeded' })
    const failed = cadWorkspaceLifecycleReducer(rendering, {
      type: 'renderFailed',
      error: { title: 'Rendering Error', message: 'render failed' },
    })

    expect(rendering.status).toBe('Rendering')
    expect(ready.status).toBe('Ready')
    expect(failed).toMatchObject({ status: 'Error', error: { message: 'render failed' } })
    expect(Object.keys(failed)).not.toContain('scene')
  })

  it('tracks a simulation from preparation through progress and success', () => {
    const started = cadWorkspaceLifecycleReducer(initialCadWorkspaceLifecycleState, {
      type: 'simulationStarted',
      runId: 'request-1',
      startedAt: 10,
    })
    const validating = cadWorkspaceLifecycleReducer(started, {
      type: 'simulationStatusChanged',
      runId: 'run-1',
      status: 'preparing',
      stage: 'validating',
      startedAt: 10,
    })
    const running = cadWorkspaceLifecycleReducer(validating, {
      type: 'simulationProgressed',
      runId: 'run-1',
      stage: 'solve: running',
      startedAt: 10,
    })
    const succeeded = cadWorkspaceLifecycleReducer(running, {
      type: 'simulationSucceeded',
      runId: 'run-1',
      startedAt: 10,
      finishedAt: 20,
      stale: false,
    })

    expect(started.process).toMatchObject({ status: 'preparing', stage: 'startup' })
    expect(validating.process).toMatchObject({ status: 'preparing', stage: 'validating' })
    expect(running.process).toMatchObject({ status: 'running', stage: 'solve: running' })
    expect(succeeded.process).toEqual({
      runId: 'run-1',
      status: 'succeeded',
      engine: { name: 'caemble-cae', version: '1' },
      stage: null,
      error: null,
      startedAt: 10,
      finishedAt: 20,
    })
    expect(succeeded.stale).toBe(false)
    expect(Object.isFrozen(succeeded.process)).toBe(true)
  })

  it('atomically marks recorded output stale and cancels an invalidated active run', () => {
    const invalidated = cadWorkspaceLifecycleReducer(initialCadWorkspaceLifecycleState, {
      type: 'simulationInvalidated',
      hasRecordedData: true,
      active: { runId: 'run-2', startedAt: 30, finishedAt: 40 },
    })

    expect(invalidated.stale).toBe(true)
    expect(invalidated.process).toMatchObject({
      runId: 'run-2',
      status: 'cancelled',
      error: 'Simulation run was invalidated by an Experiment or candidate change.',
      startedAt: 30,
      finishedAt: 40,
    })
  })

  it('preserves public failure and user-cancellation process details', () => {
    const failed = cadWorkspaceLifecycleReducer(initialCadWorkspaceLifecycleState, {
      type: 'simulationFailed',
      runId: 'run-3',
      startedAt: 50,
      finishedAt: 60,
      error: 'transport failed',
    })
    const cancelled = cadWorkspaceLifecycleReducer(failed, {
      type: 'simulationCancelled',
      runId: 'run-4',
      startedAt: 70,
      finishedAt: 80,
    })

    expect(failed.process).toMatchObject({ status: 'failed', error: 'transport failed' })
    expect(cancelled.process).toMatchObject({ status: 'cancelled', error: 'Simulation run was cancelled.' })
    expect(Object.keys(cancelled)).not.toEqual(expect.arrayContaining(['worker', 'controller', 'preparedDocument']))
  })
})
