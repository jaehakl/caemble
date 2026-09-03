import type { PersistedDataTensor } from '../cad-persistence'
import type { FrozenMaterialParameters } from '../material'

export type { PersistedDataTensor } from '../cad-persistence'

export type DataSchema = Readonly<Record<string, unknown>>

export type MeasurementMaterialParameters = Readonly<{
  experiment: FrozenMaterialParameters
  tasks: Readonly<Record<string, FrozenMaterialParameters>>
}>

export type MeasurementRecordedDataWriteLeaf = Readonly<{
  experiment_record_id: number
  data: PersistedDataTensor
}>

export type MeasurementRecordedDataLeaf = Readonly<{
  experiment_record_id: number
  quantity_kind: string | null
  tensor_order: number
  dtype: string
  data_schema: DataSchema | null
  data: unknown
}>

export interface MeasurementRecordedDataGroup {
  readonly [name: string]: MeasurementRecordedDataNode
}
export type MeasurementRecordedDataNode = MeasurementRecordedDataLeaf | MeasurementRecordedDataGroup
export interface MeasurementRecordedData {
  readonly [name: string]: MeasurementRecordedDataNode
}

export type MeasurementCreateRequest = Readonly<{
  experiment_id: number
  experiment_source_hash: string
  vars: Readonly<Record<string, unknown>>
  material_parameters: MeasurementMaterialParameters
}>

export type MeasurementRecordRequest = Readonly<{
  recorded_data: readonly MeasurementRecordedDataWriteLeaf[]
}>

type MeasurementReadFields = Readonly<{
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  experiment_id: number
  vars: Readonly<Record<string, unknown>>
  material_parameters: MeasurementMaterialParameters
  recorded_at: string | null
  calculation_data_count: number
}>

export type PersistedMeasurementRecord = MeasurementReadFields & Readonly<{ id: number }>
/** Compatibility alias. List endpoints return PersistedMeasurementRecord. */
export type MeasurementRecord = MeasurementReadFields & Readonly<{ id?: number }>

type RecordedDataReadFields = Readonly<{
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  measurement_id: number
  experiment_record_id: number
  name: string
  quantity_kind: string | null
  tensor_order: number
  dtype: string
  data_schema?: DataSchema | null
  data?: unknown | null
  data_url?: string | null
  file_size?: number | null
}>

export type PersistedRecordedDataRecord = RecordedDataReadFields & Readonly<{ id: number }>
/** Compatibility alias. List endpoints return PersistedRecordedDataRecord. */
export type RecordedDataRecord = RecordedDataReadFields & Readonly<{ id?: number }>
