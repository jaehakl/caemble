import type { dbTables, DbTableRecord } from './api'

export type {
  CalculationDataAnalysisItem,
  CalculationDataAnalysisResponse,
  CalculationDataAnalysisStatus,
  CalculationDataAnalysisSummary,
  AvailableExperimentRecord,
  AvailableExperimentsResponse,
  DbTableName,
  DbTableRecord,
  AccessKeyRecord,
  AccessKeyScope,
  CalculationDataMissingRequest,
  CalculationDataOutput,
  CalculationOutputLayout,
  CalculationDataRecord,
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
  ExperimentRecordedDataRecord,
  ExperimentRecordContract,
  RecordedDataSaveLeaf,
  SaveExperimentResponse,
  SaveExperimentRequest,
  UpsertResponse,
  UserRecord,
} from './api'

export type UserData = Awaited<ReturnType<typeof dbTables.User.fetchMe>>
export type MaterialRecord = DbTableRecord<'Material'>
export type MaterialNameRecord = DbTableRecord<'MaterialName'>
export type MaterialParameterRecord = DbTableRecord<'MaterialParameter'>
export type MaterialParameterQualifierRecord = DbTableRecord<'MaterialParameterQualifier'>
export type SavedExperimentRecord = DbTableRecord<'Experiment'>
export type MeasurementRecord = DbTableRecord<'Measurement'>
export type RecordedDataRecord = DbTableRecord<'RecordedData'>
export type CalculationRecord = DbTableRecord<'Calculation'>
