import type {
  PredictionCohortDiagnosticGroup,
  PredictionCohortExclusionReason,
  PredictionCohortOptions,
  PredictionResult,
  PredictionTensorLayout,
  PredictionTensorSample,
} from './knn'
import type { PredictionSamplingOptions, PredictionSamplingProfile } from './sampling'

type PredictionWorkerIdentity = Readonly<{
  requestId: string
  modelId: string
  generation: number
  fingerprint: string
}>

export type PredictionWorkerRequest =
  | (PredictionWorkerIdentity & Readonly<{ type: 'build-model'; options: PredictionCohortOptions }>)
  | (PredictionWorkerIdentity & Readonly<{ type: 'predict'; query: readonly PredictionTensorSample[] }>)
  | (PredictionWorkerIdentity & Readonly<{ type: 'drop-model' }>)
  | Readonly<{ type: 'start-sampling'; requestId: string; sessionId: string; options: PredictionSamplingOptions }>
  | Readonly<{ type: 'next-sample'; requestId: string; sessionId: string; fingerprint: string; attempt: number }>
  | Readonly<{
      type: 'accept-sample'
      requestId: string
      sessionId: string
      fingerprint: string
      sample: readonly PredictionTensorSample[]
    }>
  | Readonly<{ type: 'drop-sampling'; requestId: string; sessionId: string }>
  | Readonly<{ type: 'dispose'; requestId: string }>

export type PredictionWorkerModelProfile = Readonly<{
  direction: 'forward' | 'inverse'
  activeInputBlockCount: number
  rowCount: number
  k: number
  weighting: 'uniform' | 'distance'
  inputScaling: 'range' | 'standard-deviation'
  inputLayouts: readonly PredictionTensorLayout[]
  inputScales: Float64Array
  inputBlockWeights: Readonly<Record<string, number>>
  inputSize: number
  outputSize: number
  persistentBytes: number
  workingSetBytes: number
  includedMeasurementIds: readonly number[]
  warningMeasurementIds: readonly number[]
  dominantShapeSignature: string
  baselineMeasurementId: number
  diagnostics: readonly PredictionCohortDiagnosticGroup[]
  omittedDiagnosticGroups: number
  excluded: Readonly<Record<PredictionCohortExclusionReason, number>>
}>

export type PredictionWorkerResponse =
  | (PredictionWorkerIdentity & Readonly<{ type: 'model-ready'; profile: PredictionWorkerModelProfile }>)
  | (PredictionWorkerIdentity & Readonly<{ type: 'prediction'; result: PredictionResult }>)
  | (PredictionWorkerIdentity & Readonly<{ type: 'model-dropped' }>)
  | (PredictionWorkerIdentity & Readonly<{ type: 'stale' }>)
  | Readonly<{
      type: 'sampling-ready'
      requestId: string
      sessionId: string
      fingerprint: string
      profile: PredictionSamplingProfile
    }>
  | Readonly<{
      type: 'sampling-candidate'
      requestId: string
      sessionId: string
      fingerprint: string
      sample: readonly PredictionTensorSample[]
    }>
  | Readonly<{
      type: 'sampling-accepted'
      requestId: string
      sessionId: string
      fingerprint: string
      centerCount: number
    }>
  | Readonly<{ type: 'sampling-dropped'; requestId: string; sessionId: string }>
  | (Partial<PredictionWorkerIdentity> & Readonly<{ type: 'error'; requestId: string; code: string; message: string }>)
  | Readonly<{ type: 'disposed'; requestId: string }>

export function predictionWorkerResponseIsCurrent(
  response: PredictionWorkerResponse,
  expected: Readonly<{ modelId: string; generation: number; fingerprint: string }>,
) {
  return (
    'modelId' in response &&
    response.modelId === expected.modelId &&
    response.generation === expected.generation &&
    response.fingerprint === expected.fingerprint
  )
}
