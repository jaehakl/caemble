import type { PredictionDirection } from './knn'

export type PredictionSamplingProgress = Readonly<{
  attempt: number
  failures: number
  phase: 'candidate' | 'sampling' | 'simulation' | 'stopping'
  recorded: number
  sessionId: string
  successes: number
  total: number
}>

export type PredictionOperation =
  | 'idle'
  | 'loading'
  | 'forward'
  | 'inverse'
  | 'sampling'
  | 'validation'
  | 'validation-retry'
  | 'initializing-targets'
  | 'calculating-missing'

export type PredictionLifecycleState = Readonly<{
  busy: boolean
  dataStale: boolean
  direction: PredictionDirection
  freshnessPending: boolean
  operation: PredictionOperation
  retryingValidation: boolean
  samplingProgress: PredictionSamplingProgress | null
  status: string
  validating: boolean
}>

export type PredictionLifecycleAction =
  | Readonly<{
      type: 'operation-started'
      operation: Exclude<PredictionOperation, 'idle'>
      status: string
      direction?: PredictionDirection
      samplingProgress?: PredictionSamplingProgress
    }>
  | Readonly<{ type: 'operation-finished'; status?: string; clearSampling?: boolean }>
  | Readonly<{
      type: 'cancelled'
      dataStale: boolean
      freshnessPending: boolean
    }>
  | Readonly<{ type: 'status-changed'; status: string }>
  | Readonly<{ type: 'direction-changed'; direction: PredictionDirection }>
  | Readonly<{ type: 'sampling-progressed'; progress: PredictionSamplingProgress | null }>
  | Readonly<{ type: 'freshness-pending-changed'; pending: boolean }>
  | Readonly<{ type: 'data-stale-changed'; stale: boolean }>

export const initialPredictionLifecycleState: PredictionLifecycleState = Object.freeze({
  busy: false,
  dataStale: false,
  direction: 'forward',
  freshnessPending: true,
  operation: 'idle',
  retryingValidation: false,
  samplingProgress: null,
  status: 'Prediction 데이터를 준비하세요.',
  validating: false,
})

export function predictionLifecycleReducer(
  state: PredictionLifecycleState,
  action: PredictionLifecycleAction,
): PredictionLifecycleState {
  switch (action.type) {
    case 'operation-started':
      return Object.freeze({
        ...state,
        busy: true,
        direction: action.direction ?? state.direction,
        operation: action.operation,
        retryingValidation: action.operation === 'validation-retry',
        samplingProgress: action.samplingProgress ?? state.samplingProgress,
        status: action.status,
        validating: action.operation === 'validation' || action.operation === 'validation-retry',
      })
    case 'operation-finished':
      return Object.freeze({
        ...state,
        busy: false,
        operation: 'idle',
        retryingValidation: false,
        samplingProgress: action.clearSampling ? null : state.samplingProgress,
        status: action.status ?? state.status,
        validating: false,
      })
    case 'cancelled':
      return Object.freeze({
        ...state,
        busy: false,
        dataStale: action.dataStale,
        freshnessPending: action.freshnessPending,
        operation: 'idle',
        retryingValidation: false,
        samplingProgress: null,
        status: 'Prediction 작업을 취소했습니다.',
        validating: false,
      })
    case 'status-changed':
      return Object.freeze({ ...state, status: action.status })
    case 'direction-changed':
      return Object.freeze({ ...state, direction: action.direction })
    case 'sampling-progressed':
      return Object.freeze({ ...state, samplingProgress: action.progress })
    case 'freshness-pending-changed':
      return Object.freeze({ ...state, freshnessPending: action.pending })
    case 'data-stale-changed':
      return Object.freeze({ ...state, dataStale: action.stale })
  }
}
