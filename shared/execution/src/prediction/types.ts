import type { BoxGridData } from '../contracts/boxGrid'

export const predictionNumericDtypes = [
  'float16',
  'float32',
  'float64',
  'complex64',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
] as const

export type PredictionNumericDtype = (typeof predictionNumericDtypes)[number]
export type PredictionDirection = 'forward'
export type PredictionWeighting = 'uniform' | 'distance'
export type PredictionNeighbor = Readonly<{
  measurementId: number
  distanceSquared: number
  weight: number
}>

export type PredictionAxis = Readonly<{
  name: string
  ticks: readonly (number | string)[]
  unit?: string
}>

export type PredictionTensorLayout = Readonly<{
  key: string
  dtype: PredictionNumericDtype
  shape: readonly number[]
  axes?: readonly PredictionAxis[]
  dataSchemaSignature?: string
  tensorOrder?: number
  unit?: string
  quantityKind?: string
  minimum?: number
  maximum?: number
  boxGrid?: BoxGridData
  frequencyOutput?: boolean
}>

export type PredictionTensorSample = Readonly<{
  layout: PredictionTensorLayout
  values: readonly number[]
}>

export type PredictionCohortExclusionReason =
  'missing-block' | 'extra-block' | 'invalid-tensor' | 'fixed-layout-mismatch' | 'layout-mismatch'

export type PredictionCohortDiagnosticDisposition = 'included-with-warning' | 'excluded'

export type PredictionCohortDiagnosticGroup = Readonly<{
  direction: PredictionDirection
  disposition: PredictionCohortDiagnosticDisposition
  reason: PredictionCohortExclusionReason | 'metadata-mismatch'
  side: 'input' | 'output'
  blockKey: string
  fieldPath: string
  baselineMeasurementId: number | null
  expected: string
  actual: string
  measurementIds: readonly number[]
  mismatchCount?: number
  firstMismatchIndex?: number
  maxAbsoluteDifference?: number
}>

export type PredictionCohortSummary = Readonly<{
  totalRows: number
  includedRows: number
  includedMeasurementIds: readonly number[]
  warningMeasurementIds: readonly number[]
  dominantShapeSignature: string
  baselineMeasurementId: number
  diagnostics: readonly PredictionCohortDiagnosticGroup[]
  omittedDiagnosticGroups: number
  excluded: Readonly<Record<PredictionCohortExclusionReason, number>>
}>

export type PredictionQueryDiagnostic = Readonly<{
  blockKey: string
  fieldPath: string
  expected: string
  actual: string
  mismatchCount?: number
  firstMismatchIndex?: number
  maxAbsoluteDifference?: number
}>
