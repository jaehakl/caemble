import type { CalculationDataRecord, CalculationRecord } from '@caemble/execution/contracts/api/calculation'
import type { ExperimentRecordedDataRecord, SavedExperimentRecord } from '@caemble/execution/contracts/api/experiment'
import type { MeasurementRecord, RecordedDataRecord } from '@caemble/execution/contracts/api/measurement'
import type { UserRecord } from './runtime'

export type DbTableRecordMap = Readonly<{
  User: UserRecord
  Experiment: SavedExperimentRecord
  ExperimentRecord: ExperimentRecordedDataRecord
  Measurement: MeasurementRecord
  RecordedData: RecordedDataRecord
  Calculation: CalculationRecord
  CalculationData: CalculationDataRecord
}>

export type DbTableName = keyof DbTableRecordMap
export type DbTableRecord<TTable extends DbTableName> = DbTableRecordMap[TTable]
