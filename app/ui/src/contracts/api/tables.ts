import type { CalculationDataRecord, CalculationRecord } from './calculation'
import type { ExperimentRecordedDataRecord, SavedExperimentRecord } from './experiment'
import type {
  MaterialNameRecord,
  MaterialParameterQualifierRecord,
  MaterialParameterRecord,
  MaterialRecord,
} from './materials'
import type { MeasurementRecord, RecordedDataRecord } from './measurement'
import type { UserRecord } from './runtime'

export type DbTableRecordMap = Readonly<{
  User: UserRecord
  Material: MaterialRecord
  MaterialName: MaterialNameRecord
  MaterialParameter: MaterialParameterRecord
  MaterialParameterQualifier: MaterialParameterQualifierRecord
  Experiment: SavedExperimentRecord
  ExperimentRecord: ExperimentRecordedDataRecord
  Measurement: MeasurementRecord
  RecordedData: RecordedDataRecord
  Calculation: CalculationRecord
  CalculationData: CalculationDataRecord
}>

export type DbTableName = keyof DbTableRecordMap
export type DbTableRecord<TTable extends DbTableName> = DbTableRecordMap[TTable]
