export type MeasurementOperation =
  'candidate' | 'delete' | 'generate-and-run' | 'measurement' | 'record' | 'save' | 'save-and-run'

export type GenerateAndRunState = Readonly<{
  attempt: number
  baselineRevision: number
  candidateGeneration: number
  experimentId: number
  failures: number
  measurementId: number | null
  phase: 'candidate' | 'measurement' | 'running' | 'saving'
  repeat: boolean
  sequence: number
  sourceHash: string
  successes: number
  total: number
}>

export type SaveAndRunState = Readonly<{
  attemptId: number
  baselineRevision: number
  experimentId: number
  measurementId: number | null
  phase: 'saving' | 'measurement' | 'running'
  sourceHash: string
}>

type MeasurementLifecycleSharedState = Readonly<{
  automaticCalculationData: boolean
  error: string | null
  generateAndRunState: GenerateAndRunState | null
  pendingRecordMeasurementId: number | null
  saveAndRunState: SaveAndRunState | null
}>

type MeasurementLifecycleActiveStatus = 'preparing' | 'running' | 'recording' | 'calculating' | 'cancelling'

export type MeasurementLifecycleState =
  | (MeasurementLifecycleSharedState &
      Readonly<{
        status: 'idle' | 'succeeded'
        operation: null
        stage: null
      }>)
  | (MeasurementLifecycleSharedState &
      Readonly<{
        status: 'failed'
        operation: null
        stage: null
        error: string
      }>)
  | (MeasurementLifecycleSharedState &
      Readonly<{
        status: MeasurementLifecycleActiveStatus
        operation: MeasurementOperation
        stage: string
      }>)

export const initialMeasurementLifecycleState: MeasurementLifecycleState = Object.freeze({
  status: 'idle',
  operation: null,
  stage: null,
  error: null,
  pendingRecordMeasurementId: null,
  automaticCalculationData: false,
  generateAndRunState: null,
  saveAndRunState: null,
})

export type MeasurementLifecycleAction =
  | Readonly<{
      type: 'start'
      operation: MeasurementOperation
      status: Exclude<MeasurementLifecycleActiveStatus, 'cancelling' | 'calculating'>
      stage: string
      generateAndRunState?: GenerateAndRunState | null
      saveAndRunState?: SaveAndRunState | null
    }>
  | Readonly<{
      type: 'progress'
      status?: Exclude<MeasurementLifecycleActiveStatus, 'cancelling' | 'calculating'>
      stage?: string
      generateAndRunState?: GenerateAndRunState | null
      saveAndRunState?: SaveAndRunState | null
    }>
  | Readonly<{ type: 'calculationStarted'; stage?: string }>
  | Readonly<{ type: 'calculationFinished' }>
  | Readonly<{ type: 'recordPending'; measurementId: number }>
  | Readonly<{ type: 'recordResolved' }>
  | Readonly<{ type: 'retrySucceeded' }>
  | Readonly<{ type: 'fail'; message: string }>
  | Readonly<{ type: 'cancel'; stage?: string }>
  | Readonly<{ type: 'complete' }>
  | Readonly<{ type: 'reset' }>

export function measurementLifecycleReducer(
  state: MeasurementLifecycleState,
  action: MeasurementLifecycleAction,
): MeasurementLifecycleState {
  switch (action.type) {
    case 'start':
      return {
        status: action.status,
        operation: action.operation,
        stage: action.stage,
        error: null,
        pendingRecordMeasurementId: state.pendingRecordMeasurementId,
        automaticCalculationData: state.automaticCalculationData,
        generateAndRunState: action.generateAndRunState ?? null,
        saveAndRunState: action.saveAndRunState ?? null,
      }
    case 'progress': {
      if (state.operation === null) return state
      const status = action.status ?? state.status
      const stage = action.stage ?? state.stage
      const generateAndRunState =
        'generateAndRunState' in action ? (action.generateAndRunState ?? null) : state.generateAndRunState
      const saveAndRunState = 'saveAndRunState' in action ? (action.saveAndRunState ?? null) : state.saveAndRunState
      if (
        status === state.status &&
        stage === state.stage &&
        generateAndRunState === state.generateAndRunState &&
        saveAndRunState === state.saveAndRunState
      ) {
        return state
      }
      return {
        ...state,
        status,
        stage,
        generateAndRunState,
        saveAndRunState,
      }
    }
    case 'calculationStarted':
      if (state.operation === null) return state
      return {
        ...state,
        status: 'calculating',
        stage: action.stage ?? state.stage,
        automaticCalculationData: true,
      }
    case 'calculationFinished':
      if (state.operation === null || state.status !== 'calculating') {
        return { ...state, automaticCalculationData: false }
      }
      return { ...state, status: 'recording', automaticCalculationData: false }
    case 'recordPending':
      return { ...state, pendingRecordMeasurementId: action.measurementId }
    case 'recordResolved':
      return { ...state, pendingRecordMeasurementId: null }
    case 'retrySucceeded':
      if (state.operation !== null) {
        return { ...state, error: null, pendingRecordMeasurementId: null }
      }
      return {
        ...state,
        status: 'succeeded',
        operation: null,
        stage: null,
        error: null,
        pendingRecordMeasurementId: null,
      }
    case 'fail':
      if (state.operation !== null) return { ...state, error: action.message }
      return {
        ...state,
        status: 'failed',
        operation: null,
        stage: null,
        error: action.message,
      }
    case 'cancel':
      if (state.operation === null) return state
      return {
        ...state,
        status: 'cancelling',
        stage: action.stage ?? state.stage,
      }
    case 'complete': {
      const completed = {
        operation: null,
        stage: null,
        error: state.error,
        pendingRecordMeasurementId: state.pendingRecordMeasurementId,
        automaticCalculationData: state.automaticCalculationData,
        generateAndRunState: null,
        saveAndRunState: null,
      }
      return state.error
        ? { ...completed, status: 'failed', error: state.error }
        : { ...completed, status: 'succeeded' }
    }
    case 'reset':
      return initialMeasurementLifecycleState
  }
}

export function selectMeasurementLifecycle(state: MeasurementLifecycleState) {
  return {
    automaticCalculationData: state.automaticCalculationData,
    busy: state.operation !== null,
    error: state.error,
    generateAndRunState: state.generateAndRunState,
    operation: state.operation,
    pendingRecordMeasurementId: state.pendingRecordMeasurementId,
    saveAndRunState: state.saveAndRunState,
    stage: state.stage,
    status: state.status,
  }
}
