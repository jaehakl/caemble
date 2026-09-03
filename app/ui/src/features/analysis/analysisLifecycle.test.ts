import { describe, expect, it } from 'vitest'
import { analysisLifecycleReducer, initialAnalysisLifecycleState, selectAnalysisLifecycle } from './analysisLifecycle'

describe('analysisLifecycleReducer', () => {
  it('tracks load progress and the follow-up relationship and plot requests independently', () => {
    const loading = analysisLifecycleReducer(initialAnalysisLifecycleState, { type: 'loadStarted' })
    const progressed = analysisLifecycleReducer(loading, {
      type: 'progress',
      stage: 'Calculation Data 조회',
      completed: 4,
      total: 10,
    })
    const loaded = analysisLifecycleReducer(progressed, { type: 'loadSucceeded' })
    const relationships = analysisLifecycleReducer(loaded, { type: 'relationshipsStarted' })
    const relationshipsReady = analysisLifecycleReducer(relationships, { type: 'relationshipsSucceeded' })
    const plotting = analysisLifecycleReducer(relationshipsReady, { type: 'plotStarted' })
    const plotted = analysisLifecycleReducer(plotting, { type: 'plotSucceeded' })

    expect(selectAnalysisLifecycle(loading).busy).toBe('load')
    expect(progressed.progressCount).toEqual({ completed: 4, total: 10 })
    expect(relationships).toMatchObject({ primary: 'ready', relationships: 'loading', progress: '상관 분석' })
    expect(selectAnalysisLifecycle(relationships).relationshipsBusy).toBe(true)
    expect(plotting).toMatchObject({ relationships: 'ready', plot: 'loading' })
    expect(selectAnalysisLifecycle(plotting).plotBusy).toBe(true)
    expect(plotted.plot).toBe('ready')
  })

  it('tracks table and stale checks without turning them into a primary busy operation', () => {
    const loaded = analysisLifecycleReducer(
      analysisLifecycleReducer(initialAnalysisLifecycleState, { type: 'loadStarted' }),
      { type: 'loadSucceeded' },
    )
    const tableLoading = analysisLifecycleReducer(loaded, { type: 'tableStarted' })
    const tableReady = analysisLifecycleReducer(tableLoading, { type: 'tableSucceeded' })
    const checking = analysisLifecycleReducer(tableReady, { type: 'staleCheckStarted' })
    const stale = analysisLifecycleReducer(checking, { type: 'staleResolved', stale: true })

    expect(tableLoading.table).toBe('loading')
    expect(selectAnalysisLifecycle(tableLoading).busy).toBeNull()
    expect(tableReady.table).toBe('ready')
    expect(checking.staleCheck).toBe('checking')
    expect(stale).toMatchObject({ staleCheck: 'ready', stale: true })
  })

  it('ends a failed stale check without failing the ready primary analysis', () => {
    const ready = analysisLifecycleReducer(
      analysisLifecycleReducer(initialAnalysisLifecycleState, { type: 'loadStarted' }),
      { type: 'loadSucceeded' },
    )
    const checking = analysisLifecycleReducer(ready, { type: 'staleCheckStarted' })
    const failed = analysisLifecycleReducer(checking, { type: 'staleFailed', message: 'stale check failed' })

    expect(failed).toMatchObject({ primary: 'ready', staleCheck: 'failed', error: 'stale check failed' })
    expect(selectAnalysisLifecycle(failed).busy).toBeNull()
  })

  it('preserves the existing progress-count behavior while failing active work', () => {
    const progressed = analysisLifecycleReducer(
      analysisLifecycleReducer(initialAnalysisLifecycleState, { type: 'loadStarted' }),
      { type: 'progress', stage: 'Measurement 조회', completed: 2, total: 5 },
    )
    const failed = analysisLifecycleReducer(progressed, {
      type: 'failed',
      message: 'worker failed',
      clearProgress: true,
    })

    expect(failed).toMatchObject({
      primary: 'failed',
      progress: null,
      progressCount: { completed: 2, total: 5 },
      error: 'worker failed',
    })
    expect(selectAnalysisLifecycle(failed).busy).toBeNull()
  })

  it('models mining, export, and worker generation changes without storing request objects', () => {
    const mining = analysisLifecycleReducer(initialAnalysisLifecycleState, { type: 'miningStarted' })
    const mined = analysisLifecycleReducer(mining, { type: 'miningSucceeded' })
    const exporting = analysisLifecycleReducer(mined, { type: 'exportStarted' })
    const exported = analysisLifecycleReducer(exporting, { type: 'exportSucceeded' })
    const restarted = analysisLifecycleReducer(exported, { type: 'generationAdvanced' })

    expect(selectAnalysisLifecycle(mining).busy).toBe('mine')
    expect(selectAnalysisLifecycle(exporting).busy).toBe('export')
    expect(exported.primary).toBe('ready')
    expect(restarted.generation).toBe(1)
    expect(Object.keys(restarted)).not.toContain('worker')
    expect(Object.keys(restarted)).not.toContain('requestId')
  })
})
