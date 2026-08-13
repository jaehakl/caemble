import type { dbTables, DbTableRecord } from './api'

export type {
  DbTableName,
  DbTableRecord,
  CodeEntityHistoryItem,
  CodeEntityHistoryResponse,
  AccessKeyRecord,
  AccessKeyScope,
  GetListRequest,
  GetListResponse,
  JobState,
  JobSummary,
  LauncherRecord,
  LauncherRuntime,
  MeasurementCreateRequest,
  MeasurementRecordRequest,
  SaveCodeEntityResponse,
  SaveExperimentRequest,
  UpsertResponse,
} from './api'

export type UserData = Awaited<ReturnType<typeof dbTables.User.fetchMe>>
export type MaterialRecord = DbTableRecord<'Material'>
export type MaterialNameRecord = DbTableRecord<'MaterialName'>
export type MaterialParameterRecord = DbTableRecord<'MaterialParameter'>
export type MaterialParameterQualifierRecord = DbTableRecord<'MaterialParameterQualifier'>
export type GeometryRepositoryRecord = DbTableRecord<'GeometryRepository'>
export type GeometryPackageRecord = DbTableRecord<'GeometryPackage'>
export type GeometryVersionRecord = DbTableRecord<'GeometryVersion'>
export type ExperimentRecord = DbTableRecord<'Experiment'>
export type MeasurementRecord = DbTableRecord<'Measurement'>
export type RecordedDataRecord = DbTableRecord<'RecordedData'>
export type DesignerModelRecord = DbTableRecord<'DesignerModel'>
export type PredictorModelRecord = DbTableRecord<'PredictorModel'>
