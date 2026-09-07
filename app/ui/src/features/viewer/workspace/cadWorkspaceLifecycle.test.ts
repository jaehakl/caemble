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
})
