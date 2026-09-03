import type { SimulationProcess } from './simulationUiTypes'

export type AppStatus =
  'Dirty' | 'Checking' | 'Compiling' | 'Evaluating' | 'Resolving Materials' | 'Ready' | 'Rendering' | 'Error'

export type RunError = Readonly<{
  title: string
  message: string
  stack?: string
}>

export type CadWorkspaceLifecycleState = Readonly<{
  status: AppStatus
  error: RunError | null
  process: SimulationProcess
  stale: boolean
}>

type ActiveSimulation = Readonly<{
  runId: string
  startedAt: number
  finishedAt: number
}>

export type CadWorkspaceLifecycleAction =
  | Readonly<{ type: 'sourceCleared' }>
  | Readonly<{ type: 'sourceChecking' }>
  | Readonly<{ type: 'compilationStarted' }>
  | Readonly<{ type: 'candidatePending' }>
  | Readonly<{ type: 'evaluationStarted' }>
  | Readonly<{ type: 'materialsResolutionStarted' }>
  | Readonly<{ type: 'evaluationSucceeded' }>
  | Readonly<{ type: 'evaluationFailed'; error: RunError }>
  | Readonly<{ type: 'renderStarted' }>
  | Readonly<{ type: 'renderSucceeded' }>
  | Readonly<{ type: 'renderFailed'; error: RunError }>
  | Readonly<{ type: 'simulationInvalidated'; hasRecordedData: boolean; active: ActiveSimulation | null }>
  | Readonly<{ type: 'simulationStarted'; runId: string; startedAt: number }>
  | Readonly<{ type: 'simulationProgressed'; runId: string; stage: string; startedAt: number }>
  | Readonly<{
      type: 'simulationStatusChanged'
      runId: string
      status: 'preparing' | 'running'
      stage: string
      startedAt: number
    }>
  | Readonly<{
      type: 'simulationSucceeded'
      runId: string
      startedAt: number
      finishedAt: number
      stale: boolean
    }>
  | Readonly<{
      type: 'simulationFailed'
      runId: string
      startedAt: number
      finishedAt: number
      error: string
    }>
  | Readonly<{
      type: 'simulationCancelled'
      runId: string
      startedAt: number
      finishedAt: number
    }>

const simulationEngine = Object.freeze({ name: 'caemble-cae', version: '1' })

const idleSimulationProcess: SimulationProcess = Object.freeze({
  runId: null,
  status: 'idle',
  engine: null,
  stage: null,
  error: null,
  startedAt: null,
  finishedAt: null,
})

export const initialCadWorkspaceLifecycleState: CadWorkspaceLifecycleState = Object.freeze({
  status: 'Ready',
  error: null,
  process: idleSimulationProcess,
  stale: false,
})

export function cadWorkspaceLifecycleReducer(
  state: CadWorkspaceLifecycleState,
  action: CadWorkspaceLifecycleAction,
): CadWorkspaceLifecycleState {
  switch (action.type) {
    case 'sourceCleared':
      return { ...state, status: 'Ready', error: null }
    case 'sourceChecking':
      return { ...state, status: 'Checking', error: null }
    case 'compilationStarted':
      return { ...state, status: 'Compiling' }
    case 'candidatePending':
      return { ...state, status: 'Checking' }
    case 'evaluationStarted':
      return { ...state, status: 'Evaluating', error: null }
    case 'materialsResolutionStarted':
      return { ...state, status: 'Resolving Materials' }
    case 'evaluationSucceeded':
      return { ...state, status: 'Ready' }
    case 'evaluationFailed':
      return { ...state, status: 'Error', error: action.error }
    case 'renderStarted':
      return { ...state, status: 'Rendering' }
    case 'renderSucceeded':
      return { ...state, status: 'Ready' }
    case 'renderFailed':
      return { ...state, status: 'Error', error: action.error }
    case 'simulationInvalidated':
      return {
        ...state,
        stale: state.stale || action.hasRecordedData,
        process: action.active
          ? Object.freeze({
              runId: action.active.runId,
              status: 'cancelled',
              engine: simulationEngine,
              stage: null,
              error: 'Simulation run was invalidated by an Experiment or candidate change.',
              startedAt: action.active.startedAt,
              finishedAt: action.active.finishedAt,
            })
          : state.process,
      }
    case 'simulationStarted':
      return {
        ...state,
        stale: false,
        process: Object.freeze({
          runId: action.runId,
          status: 'preparing',
          engine: simulationEngine,
          stage: 'startup',
          error: null,
          startedAt: action.startedAt,
          finishedAt: null,
        }),
      }
    case 'simulationProgressed':
      return {
        ...state,
        process: Object.freeze({
          runId: action.runId,
          status: 'running',
          engine: simulationEngine,
          stage: action.stage,
          error: null,
          startedAt: action.startedAt,
          finishedAt: null,
        }),
      }
    case 'simulationStatusChanged':
      return {
        ...state,
        process: Object.freeze({
          runId: action.runId,
          status: action.status,
          engine: simulationEngine,
          stage: action.stage,
          error: null,
          startedAt: action.startedAt,
          finishedAt: null,
        }),
      }
    case 'simulationSucceeded':
      return {
        ...state,
        stale: action.stale,
        process: Object.freeze({
          runId: action.runId,
          status: 'succeeded',
          engine: simulationEngine,
          stage: null,
          error: null,
          startedAt: action.startedAt,
          finishedAt: action.finishedAt,
        }),
      }
    case 'simulationFailed':
      return {
        ...state,
        process: Object.freeze({
          runId: action.runId,
          status: 'failed',
          engine: simulationEngine,
          stage: null,
          error: action.error,
          startedAt: action.startedAt,
          finishedAt: action.finishedAt,
        }),
      }
    case 'simulationCancelled':
      return {
        ...state,
        process: Object.freeze({
          runId: action.runId,
          status: 'cancelled',
          engine: simulationEngine,
          stage: null,
          error: 'Simulation run was cancelled.',
          startedAt: action.startedAt,
          finishedAt: action.finishedAt,
        }),
      }
  }
}
