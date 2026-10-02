import type { RecordedDataRule, Vars } from '@caemble/execution/cad/model'
import type {
  PredictionCohortDiagnosticGroup,
  PredictionCohortExclusionReason,
  PredictionDirection,
  PredictionQueryDiagnostic,
  PredictionTensorLayout,
  PredictionTensorSample,
  PredictionNeighbor,
  PredictionWeighting,
} from './types'

export type PredictionAlgorithm = Readonly<{
  kind: 'knn'
  kMode: 'auto' | 'manual'
  manualK: number
  weighting: PredictionWeighting
}>

/** Numerical implementation details are optional at the application boundary. */
export type PredictionModelProfile = Readonly<{
  direction: PredictionDirection
  rowCount: number
  inputLayouts: readonly PredictionTensorLayout[]
  inputSize: number
  outputSize: number
  includedMeasurementIds: readonly number[]
  warningMeasurementIds: readonly number[]
  diagnostics: readonly PredictionCohortDiagnosticGroup[]
  omittedDiagnosticGroups: number
  excluded: Readonly<Record<PredictionCohortExclusionReason, number>>
  knn?: Readonly<{
    dominantShapeSignature: string
    baselineMeasurementId: number
    k: number
    weighting: PredictionWeighting
    inputScaling: 'range'
    inputScales: Float64Array
    inputBlockWeights: Readonly<Record<string, number>>
    activeInputBlockCount: number
  }>
  resources?: Readonly<{ persistentBytes: number; workingSetBytes: number }>
}>

export type PredictionExecutionResult = Readonly<{
  direction: PredictionDirection
  fingerprint: string
  output: readonly PredictionTensorSample[]
  extrapolatedInputKeys: readonly string[]
  constantInputKeysChanged: readonly string[]
  queryDiagnostics: readonly PredictionQueryDiagnostic[]
  knn?: Readonly<{ neighbors: readonly PredictionNeighbor[] }>
  provenance?: PredictionProvenance
}>

export type PredictionProvenance = Readonly<{
  modelId: string
  modelRevision: number
  datasetId: string
  datasetRevision: number
}>

export type SavedPredictionModel = PredictionProvenance &
  Readonly<{
    direction: PredictionDirection
    fingerprint: string
    manifestChecksum?: string
    contract?: PredictionSavedContract
  }>

/** A preferred path to one copy; it never changes the saved model's meaning. */
export type PredictionExecutionRoute = Readonly<{
  replicaId?: string
  storageId: string
  launcherId: string
}>

export type PredictionSavedContract = Readonly<{
  experimentId: number
  varsSchemaFingerprint: string
  records: Readonly<Record<number, string>>
}>

export type PredictionModelInstance = Readonly<{
  executionId: string
  sessionId: string
  generation: number
  handle: string
}>

export type PredictionRecordProfile = Readonly<{
  recordId: number
  name: string
  error: string | null
  profile: PredictionModelProfile | null
}>

export type PreparedPredictionModel = Readonly<{
  fingerprint: string
  instance: PredictionModelInstance
  profile: PredictionModelProfile
  errors: Readonly<Record<number, string>>
  recordProfiles: readonly PredictionRecordProfile[]
  rules: readonly RecordedDataRule[]
  provenance?: PredictionProvenance
}>

export type PredictionRequest = Readonly<{ requestId: string; signal: AbortSignal }>
export type PredictionInput = Readonly<{ direction: 'forward'; vars: Readonly<Vars> }>

/** A local interface, not a transport protocol or a persistent model registry. */
export interface PredictionExecution {
  readonly id: string
  readonly location: 'remote'
  readonly sessionId: string
  readonly algorithms: readonly string[]
  readonly directions: readonly PredictionDirection[]
  readonly representations?: readonly string[]
  load(
    model: SavedPredictionModel,
    request: PredictionRequest,
    route?: PredictionExecutionRoute,
  ): Promise<PreparedPredictionModel>
  predict(
    instance: PredictionModelInstance,
    input: PredictionInput,
    request: PredictionRequest,
  ): Promise<PredictionExecutionResult>
  cancel(requestId: string): void
  release(instance: PredictionModelInstance): Promise<void>
  dispose(): void
}

/** Only the execution implementation decides whether a lost instance is recoverable. */
export class PredictionInstanceInvalidatedError extends Error {
  override readonly name: string = 'PredictionInstanceInvalidatedError'
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message)
  }
}
