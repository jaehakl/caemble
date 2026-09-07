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

export const initialCadWorkspaceLifecycleState: CadWorkspaceLifecycleState = Object.freeze({
  status: 'Ready',
  error: null,
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
  }
}
