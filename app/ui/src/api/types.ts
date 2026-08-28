import type { dbTables, DbTableRecord } from './api'

export type {
  DbTableName,
  DbTableRecord,
  AccessKeyRecord,
  AccessKeyScope,
  CalculationDataMissingRequest,
  CalculationDataOutput,
  CalculationDataScalar,
  CalculationDataTarget,
  GetListRequest,
  GetListResponse,
  JobState,
  JobSummary,
  LauncherRecord,
  LauncherRuntime,
  MeasurementCreateRequest,
  MeasurementRecordRequest,
  MeasurementRecordedData,
  RecordedDataSaveLeaf,
  SaveExperimentResponse,
  SaveExperimentRequest,
  UpsertResponse,
} from './api'

export type UserData = Awaited<ReturnType<typeof dbTables.User.fetchMe>>
export type MaterialRecord = DbTableRecord<'Material'>
export type MaterialNameRecord = DbTableRecord<'MaterialName'>
export type MaterialParameterRecord = DbTableRecord<'MaterialParameter'>
export type MaterialParameterQualifierRecord = DbTableRecord<'MaterialParameterQualifier'>
export type ExperimentRecord = DbTableRecord<'Experiment'>
export type MeasurementRecord = DbTableRecord<'Measurement'>
export type RecordedDataRecord = DbTableRecord<'RecordedData'>
export type CalculationRecord = DbTableRecord<'Calculation'>
