import type { PredictionCohortOptions, PredictionResult, PredictionTensorLayout, PredictionTensorSample } from './knn'

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
  excluded: Readonly<Record<string, number>>
}>

export type PredictionWorkerResponse =
  | (PredictionWorkerIdentity & Readonly<{ type: 'model-ready'; profile: PredictionWorkerModelProfile }>)
  | (PredictionWorkerIdentity & Readonly<{ type: 'prediction'; result: PredictionResult }>)
  | (PredictionWorkerIdentity & Readonly<{ type: 'model-dropped' }>)
  | (PredictionWorkerIdentity & Readonly<{ type: 'stale' }>)
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
