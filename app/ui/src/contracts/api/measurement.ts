import type { RecordedResultContracts } from '../results'
import type { MaterialSnapshot, TaskMaterialSelections } from '../material'
import type { CatalogMaterialModel } from '../catalog'

export type { PersistedDataTensor } from '../cad-persistence'

export type DataSchema = Readonly<Record<string, unknown>>

export type MeasurementMaterialSnapshot = Readonly<{
  experiment: MaterialSnapshot
  tasks: Readonly<Record<string, MaterialSnapshot>>
  sourceHash: string
  varsHash: string
  modelDefinitions: readonly CatalogMaterialModel[]
  selections: Readonly<Record<string, TaskMaterialSelections>>
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
  material_snapshot: MeasurementMaterialSnapshot
}>

type MeasurementReadFields = Readonly<{
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  experiment_id: number
  vars: Readonly<Record<string, unknown>>
  material_snapshot: MeasurementMaterialSnapshot
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

export type MeasurementResults = Readonly<{
  recorded_data: MeasurementRecordedData
  result_contracts: RecordedResultContracts | null
  result_errors?: Readonly<Record<string, string>>
}>
