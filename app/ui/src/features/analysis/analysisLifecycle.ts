import type { AnalysisProgressStage } from './analysis-types'

export type AnalysisLifecycleState = Readonly<{
  generation: number
  primary: 'idle' | 'loading' | 'ready' | 'mining' | 'exporting' | 'failed'
  relationships: 'idle' | 'loading' | 'ready' | 'failed'
  plot: 'idle' | 'loading' | 'ready' | 'failed'
  table: 'idle' | 'loading' | 'ready' | 'failed'
  staleCheck: 'idle' | 'checking' | 'ready' | 'failed'
  progress: AnalysisProgressStage | null
  progressCount: Readonly<{ completed: number; total: number }> | null
  error: string | null
  stale: boolean
}>

export const initialAnalysisLifecycleState: AnalysisLifecycleState = Object.freeze({
  generation: 0,
  primary: 'idle',
  relationships: 'idle',
  plot: 'idle',
  table: 'idle',
  staleCheck: 'idle',
  progress: null,
  progressCount: null,
  error: null,
  stale: false,
})

export type AnalysisLifecycleAction =
  | Readonly<{ type: 'loadStarted' }>
  | Readonly<{
      type: 'progress'
      stage: AnalysisProgressStage
      completed?: number
      total?: number
    }>
  | Readonly<{ type: 'loadSucceeded' }>
  | Readonly<{ type: 'relationshipsStarted' }>
  | Readonly<{ type: 'relationshipsSucceeded' }>
  | Readonly<{ type: 'plotStarted' }>
  | Readonly<{ type: 'plotSucceeded' }>
  | Readonly<{ type: 'tableStarted' }>
  | Readonly<{ type: 'tableSucceeded' }>
  | Readonly<{ type: 'miningStarted' }>
  | Readonly<{ type: 'miningSucceeded' }>
  | Readonly<{ type: 'exportStarted' }>
  | Readonly<{ type: 'exportSucceeded' }>
  | Readonly<{ type: 'staleCheckStarted' }>
  | Readonly<{ type: 'staleResolved'; stale: boolean }>
  | Readonly<{ type: 'staleFailed'; message: string }>
  | Readonly<{ type: 'failed'; message: string; clearProgress: boolean }>
  | Readonly<{ type: 'generationAdvanced' }>

export function analysisLifecycleReducer(
  state: AnalysisLifecycleState,
  action: AnalysisLifecycleAction,
): AnalysisLifecycleState {
  switch (action.type) {
    case 'loadStarted':
      return {
        ...state,
        primary: 'loading',
        relationships: 'idle',
        plot: 'idle',
        table: 'idle',
        staleCheck: 'idle',
        progress: 'Measurement 조회',
        progressCount: null,
        error: null,
        stale: false,
      }
    case 'progress':
      return {
        ...state,
        progress: action.stage,
        progressCount:
          action.completed === undefined || action.total === undefined
            ? null
            : { completed: action.completed, total: action.total },
      }
    case 'loadSucceeded':
      return { ...state, primary: 'ready', progress: null, progressCount: null }
    case 'relationshipsStarted':
      return { ...state, relationships: 'loading', progress: '상관 분석', progressCount: null }
    case 'relationshipsSucceeded':
      return { ...state, relationships: 'ready', progress: null, progressCount: null }
    case 'plotStarted':
      return {
        ...state,
        primary: state.primary === 'failed' ? 'ready' : state.primary,
        plot: 'loading',
        error: null,
      }
    case 'plotSucceeded':
      return { ...state, plot: 'ready' }
    case 'tableStarted':
      return { ...state, table: 'loading' }
    case 'tableSucceeded':
      return { ...state, table: 'ready' }
    case 'miningStarted':
      return { ...state, primary: 'mining', error: null }
    case 'miningSucceeded':
      return { ...state, primary: 'ready', progress: null }
    case 'exportStarted':
      return { ...state, primary: 'exporting', error: null }
    case 'exportSucceeded':
      return { ...state, primary: 'ready' }
    case 'staleCheckStarted':
      return { ...state, staleCheck: 'checking' }
    case 'staleResolved':
      return { ...state, staleCheck: 'ready', stale: action.stale }
    case 'staleFailed':
      return { ...state, staleCheck: 'failed', error: action.message }
    case 'failed':
      return {
        ...state,
        primary: 'failed',
        relationships: state.relationships === 'loading' ? 'failed' : state.relationships,
        plot: state.plot === 'loading' ? 'failed' : state.plot,
        table: state.table === 'loading' ? 'failed' : state.table,
        staleCheck: state.staleCheck === 'checking' ? 'failed' : state.staleCheck,
        progress: action.clearProgress ? null : state.progress,
        error: action.message,
      }
    case 'generationAdvanced':
      return { ...state, generation: state.generation + 1 }
  }
}

export function selectAnalysisLifecycle(state: AnalysisLifecycleState) {
  return {
    busy:
      state.primary === 'loading'
        ? ('load' as const)
        : state.primary === 'mining'
          ? ('mine' as const)
          : state.primary === 'exporting'
            ? ('export' as const)
            : null,
    error: state.error,
    plotBusy: state.plot === 'loading',
    progress: state.progress,
    progressCount: state.progressCount,
    relationshipsBusy: state.relationships === 'loading',
    stale: state.stale,
  }
}
