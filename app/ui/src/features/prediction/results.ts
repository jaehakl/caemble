import type { CalculationDataOutput } from '@/api'
import type { PredictionDirection, PredictionNeighbor, PredictionResult, PredictionTensorLayout } from './knn'
import type { PredictionValidationMetric } from './metrics'
import type { PredictionWorkerModelProfile } from './protocol'
import type { PredictionForwardRecordProfile } from './usePredictionController'

type ForwardRefreshFailure = Readonly<{
  fingerprint: string
  message: string
}>

export type ValidationRow = Readonly<{
  actual: CalculationDataOutput | null
  calculationId: number
  metric: PredictionValidationMetric | null
  error: string | null
  reference: CalculationDataOutput
}>

export type ValidationResult = Readonly<{
  aggregateError: number | null
  calculationContractFingerprint: string
  candidateVarsFingerprint: string
  calculationWeights: Readonly<Record<number, number>>
  direction: PredictionDirection
  experimentId: number
  inverseInputLayouts: readonly PredictionTensorLayout[] | null
  inverseInputScales: Float64Array | null
  measurementId: number
  primaryRevision: number
  repredicted: Readonly<Record<number, CalculationDataOutput>>
  rows: readonly ValidationRow[]
  snapshotFingerprint: string
  sourceFingerprints: Readonly<Record<number, string>>
  setupFingerprint: string
  sourceIdentity: string
  summary: string
  transactionId: number
}>

type Outputs = Readonly<Record<number, CalculationDataOutput>>
type Errors = Readonly<Record<number, string>>

export type PredictionResults = Readonly<{
  calculationErrors: Errors
  surrogateValues: Outputs
  surrogateErrors: Errors
  neighborsByDirection: Partial<Record<PredictionDirection, readonly PredictionNeighbor[]>>
  profiles: Partial<Record<PredictionDirection, PredictionWorkerModelProfile>>
  forwardRecordProfiles: readonly PredictionForwardRecordProfile[]
  lastResult: PredictionResult | null
  forwardVarsFingerprint: string | null
  forwardFailure: ForwardRefreshFailure | null
  inverseVarsFingerprint: string | null
  validation: ValidationResult | null
}>

export const initialPredictionResults: PredictionResults = {
  calculationErrors: {},
  surrogateValues: {},
  surrogateErrors: {},
  neighborsByDirection: {},
  profiles: {},
  forwardRecordProfiles: [],
  lastResult: null,
  forwardVarsFingerprint: null,
  forwardFailure: null,
  inverseVarsFingerprint: null,
  validation: null,
}

type PredictionResultsAction =
  | { type: 'experiment-changed' | 'access-lost' }
  | { type: 'context-reloaded'; validation: ValidationResult | null }
  | { type: 'model-caches-cleared' }
  | { type: 'profile-received'; profile: PredictionWorkerModelProfile }
  | { type: 'record-profiles-received'; profiles: readonly PredictionForwardRecordProfile[] }
  | { type: 'forward-started' | 'inverse-started' | 'predictions-invalidated' }
  | { type: 'forward-completed'; result: PredictionResult; errors: Errors; fingerprint: string; failure?: string }
  | { type: 'forward-failed'; fingerprint: string; message: string }
  | { type: 'inverse-completed'; result: PredictionResult; fingerprint: string }
  | { type: 'surrogate-completed'; values: Outputs; errors: Errors }
  | { type: 'surrogate-failed' }
  | { type: 'candidate-edited'; direction: PredictionDirection }
  | { type: 'validation-cleared' | 'sampling-started' | 'setup-applied' | 'target-initialization-started' }
  | { type: 'validation-completed'; validation: ValidationResult }
  | { type: 'targets-initialized'; errors: Errors }

export function predictionResultsReducer(state: PredictionResults, action: PredictionResultsAction): PredictionResults {
  switch (action.type) {
    case 'experiment-changed':
    case 'access-lost':
      return initialPredictionResults
    case 'context-reloaded':
      return { ...initialPredictionResults, validation: action.validation }
    case 'model-caches-cleared':
      return { ...state, forwardRecordProfiles: [] }
    case 'profile-received':
      return { ...state, profiles: { ...state.profiles, [action.profile.direction]: action.profile } }
    case 'record-profiles-received':
      return { ...state, forwardRecordProfiles: action.profiles }
    case 'forward-started':
    case 'inverse-started':
    case 'predictions-invalidated':
      return {
        ...state,
        forwardVarsFingerprint: null,
        forwardFailure: null,
        inverseVarsFingerprint: null,
        ...(action.type === 'forward-started' ? { calculationErrors: {} } : {}),
        ...(action.type === 'inverse-started' ? { surrogateValues: {}, surrogateErrors: {} } : {}),
      }
    case 'forward-completed':
      return {
        ...state,
        calculationErrors: action.errors,
        surrogateValues: {},
        surrogateErrors: {},
        neighborsByDirection: { ...state.neighborsByDirection, forward: action.result.neighbors },
        lastResult: action.result,
        forwardVarsFingerprint: action.failure ? null : action.fingerprint,
        forwardFailure: action.failure ? { fingerprint: action.fingerprint, message: action.failure } : null,
        inverseVarsFingerprint: null,
      }
    case 'forward-failed':
      return { ...state, forwardFailure: { fingerprint: action.fingerprint, message: action.message } }
    case 'inverse-completed':
      return {
        ...state,
        inverseVarsFingerprint: action.fingerprint,
        forwardVarsFingerprint: null,
        neighborsByDirection: { ...state.neighborsByDirection, inverse: action.result.neighbors },
        lastResult: action.result,
      }
    case 'surrogate-completed':
      return { ...state, surrogateValues: action.values, surrogateErrors: action.errors }
    case 'surrogate-failed':
      return { ...state, surrogateValues: {}, surrogateErrors: {} }
    case 'candidate-edited':
      return {
        ...state,
        forwardVarsFingerprint: null,
        forwardFailure: null,
        inverseVarsFingerprint: null,
        validation: null,
        surrogateValues: {},
        surrogateErrors: {},
        calculationErrors: action.direction === 'forward' ? {} : state.calculationErrors,
      }
    case 'validation-cleared':
      return { ...state, validation: null }
    case 'validation-completed':
      return { ...state, validation: action.validation }
    case 'sampling-started':
      return { ...state, forwardFailure: null, validation: null }
    case 'setup-applied':
      return { ...state, forwardFailure: null, validation: null, profiles: {}, neighborsByDirection: {} }
    case 'target-initialization-started':
      return { ...state, forwardFailure: null }
    case 'targets-initialized':
      return { ...state, calculationErrors: action.errors }
  }
}
