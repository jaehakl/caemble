export type CalculationDataAxis = Readonly<{
  name: string
  ticks: readonly number[]
  unit?: string
}>

export type CalculationDataOutput = Readonly<{
  dtype: 'float32' | 'float64' | 'int8' | 'int16' | 'int32' | 'uint8' | 'uint16' | 'uint32'
  shape: readonly number[]
  data: number | readonly number[]
  axes: readonly CalculationDataAxis[]
}>

export type CalculationOutputLayout = Omit<CalculationDataOutput, 'data'>

type CalculationWriteRecord = Readonly<{
  created_at?: string | null
  updated_at?: string | null
  experiment_id: number
  name: string
  description?: string | null
  source_code: string
  source_hash?: string | null
  output_layout?: CalculationOutputLayout | null
  preflight_measurement_id?: number | null
  contract_status: 'ready' | 'needs_preflight'
  experiment_record_ids: readonly number[]
}>

export type CalculationUpsertInput = CalculationWriteRecord & Readonly<{ id?: number }>
export type PersistedCalculationRecord = CalculationWriteRecord & Readonly<{ id: number }>
/** Compatibility alias. Prefer PersistedCalculationRecord for reads and CalculationUpsertInput for writes. */
export type CalculationRecord = CalculationUpsertInput

export type CalculationDataTarget = Readonly<{ calculation_id: number; measurement_id: number }>

export type CalculationDataMissingRequest = Readonly<{
  experiment_id: number
  calculation_id?: number
  measurement_id?: number
}>

export type CalculationDataMissingResponse = Readonly<{
  total: number
  items: readonly CalculationDataTarget[]
}>

export type CalculationDataSaveResponse = Readonly<{
  id: number
  created: boolean
}>

export type CalculationDataScalar = Readonly<{ measurement_id: number; value: number }>

export type CalculationDataAnalysisSummary =
  | Readonly<{ kind: 'scalar'; value: number }>
  | Readonly<{ kind: 'tensor'; rank: 1 | 2; count: number; mean: number | null; std: number | null }>

export type CalculationDataAnalysisItem = Readonly<{
  calculation_data_id: number
  calculation_id: number
  calculation_name: string
  measurement_id: number
  dtype: CalculationDataOutput['dtype']
  summary: CalculationDataAnalysisSummary
}>

export type CalculationDataRecord = Readonly<{
  id: number
  created_at?: string | null
  updated_at?: string | null
  calculation_id: number
  measurement_id: number
  data: CalculationDataOutput
}>

export type CalculationDataAnalysisResponse = Readonly<{
  fingerprint: string
  total: number
  measurement_count: number
  items: readonly CalculationDataAnalysisItem[]
}>

export type CalculationDataAnalysisStatus = Readonly<{
  fingerprint: string
  total: number
  measurement_count: number
}>
