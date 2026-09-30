import type { CalculationDataOutput, CalculationDataRecord, RecordedDataRecord } from '@/api'
import type { RecordedDataRule, Vars, VarsSchemaEntry } from '@/lib/cad/model'
import type {
  PredictionCohortDiagnosticGroup,
  PredictionCohortExclusionReason,
  PredictionDirection,
  PredictionNeighbor,
  PredictionQueryDiagnostic,
  PredictionTensorLayout,
  PredictionTensorSample,
  PredictionWeighting,
} from './knn'
import type { TrainingSnapshot } from './trainingSnapshot'

export type PredictionAlgorithm = Readonly<{
  kind: 'knn'
  kMode: 'auto' | 'manual'
  manualK: number
  weighting: PredictionWeighting
  calculationWeights: Readonly<Record<number, number>>
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
    inputScaling: 'range' | 'standard-deviation'
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
}>

export type PredictionModelDefinition = Readonly<{
  fingerprint: string
  snapshotFingerprint: string
  algorithm: PredictionAlgorithm
  implementationId: string
  implementationVersion: string
  preprocessingVersion: string
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
}>

export type PredictionRequest = Readonly<{ requestId: string; signal: AbortSignal }>
export type PredictionInput =
  | Readonly<{ direction: 'forward'; vars: Readonly<Vars> }>
  | Readonly<{ direction: 'inverse'; targets: Readonly<Record<number, CalculationDataOutput>> }>

export type PredictionTrainingPolicy = Readonly<{
  checkRecordedData: (rows: readonly RecordedDataRecord[], schema: Readonly<Record<string, VarsSchemaEntry>>) => void
  checkCalculationData: (rows: readonly CalculationDataRecord[]) => void
}>

/** A local interface, not a transport protocol or a persistent model registry. */
export interface PredictionExecution {
  readonly id: string
  readonly location: 'browser' | 'remote'
  readonly sessionId: string
  readonly implementationVersion: string
  readonly preprocessingVersion: string
  readonly algorithms: readonly PredictionAlgorithm['kind'][]
  readonly directions: readonly PredictionDirection[]
  readonly trainingPolicy?: PredictionTrainingPolicy
  prepare(
    snapshot: TrainingSnapshot,
    definition: PredictionModelDefinition,
    request: PredictionRequest,
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
