import type { dbTables, DbTableRecord } from './api'

export type {
  DbTableName,
  DbTableRecord,
  CodeEntityHistoryItem,
  CodeEntityHistoryResponse,
  DefinitionScope,
  AccessKeyRecord,
  AccessKeyScope,
  GetListRequest,
  GetListResponse,
  JobState,
  JobSummary,
  LauncherRecord,
  LauncherRuntime,
  MeasurementSaveRequest,
  MeasurementContextListRequest,
  MeasurementPairListItem,
  MeasurementPairListRequest,
  MeasurementPairListResponse,
  SaveCodeEntityRequest,
  SaveCodeEntityResponse,
  SaveExperimentRequest,
  UpsertResponse,
} from './api'

export type UserData = Awaited<ReturnType<typeof dbTables.User.fetchMe>>
export type MaterialRecord = DbTableRecord<'Material'>
export type MaterialNameRecord = DbTableRecord<'MaterialName'>
export type MaterialParameterRecord = DbTableRecord<'MaterialParameter'>
export type MaterialParameterQualifierRecord = DbTableRecord<'MaterialParameterQualifier'>
export type GeometryRecord = DbTableRecord<'Geometry'>
export type StructureRecord = DbTableRecord<'Structure'>
export type ExperimentRecord = DbTableRecord<'Experiment'>
export type SampleRecord = DbTableRecord<'Sample'>
export type SetupRecord = DbTableRecord<'Setup'>
export type MeasurementRecord = DbTableRecord<'Measurement'>
export type RecordedDataRecord = DbTableRecord<'RecordedData'>
export type DesignerModelRecord = DbTableRecord<'DesignerModel'>
export type PredictorModelRecord = DbTableRecord<'PredictorModel'>
