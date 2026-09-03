import { API_URL, request } from './http'
import type { RequestContext } from './http'
import type {
  AccessKeyRecord,
  AccessKeyScope,
  AvailableExperimentRecord,
  AvailableExperimentsResponse,
  CalculationDataAnalysisResponse,
  CalculationDataAnalysisStatus,
  CalculationDataMissingRequest,
  CalculationDataMissingResponse,
  CalculationDataOutput,
  CalculationDataRecord,
  CalculationDataSaveResponse,
  CalculationDataScalar,
  CalculationRecord,
  CalculationUpsertInput,
  DbTableName,
  DbTableRecord,
  ExperimentRecordedDataRecord,
  ExperimentUsageResponse,
  GetListRequest,
  GetListResponse,
  JobSummary,
  LauncherRecord,
  LauncherRuntime,
  MaterialNameRecord,
  MaterialNameUpsertInput,
  MaterialParameterQualifierRecord,
  MaterialParameterQualifierUpsertInput,
  MaterialParameterRecord,
  MaterialParameterUpsertInput,
  MaterialRecord,
  MaterialUpsertInput,
  MeasurementCreateRequest,
  MeasurementRecord,
  MeasurementRecordedData,
  MeasurementRecordRequest,
  PersistedCalculationRecord,
  PersistedMaterialNameRecord,
  PersistedMaterialParameterQualifierRecord,
  PersistedMaterialParameterRecord,
  PersistedMaterialRecord,
  PersistedMeasurementRecord,
  PersistedRecordedDataRecord,
  RecordedDataRecord,
  RuntimeCrudListRequest,
  SaveExperimentRequest,
  SaveExperimentResponse,
  SavedExperimentRecord,
  UpsertResponse,
  UserRecord,
} from '@/contracts/api'
import {
  parseCalculationDataAnalysisResponse,
  parseCalculationDataAnalysisStatus,
  parseCalculationDataListResponse,
  parseCalculationDataMissingResponse,
  parseCalculationDataSaveResponse,
  parseCalculationDataScalarsResponse,
  parseCalculationListResponse,
} from '@/contracts/api/calculationValidators'
import {
  parseAvailableExperimentsResponse,
  parseDemoCandidatesResponse,
  parseExperimentListResponse,
  parseExperimentRecordListResponse,
  parseExperimentUsageResponse,
  parseSaveExperimentResponse,
} from '@/contracts/api/experimentValidators'
import {
  parseMaterialListResponse,
  parseMaterialNameListResponse,
  parseMaterialParameterListResponse,
  parseMaterialParameterQualifierListResponse,
} from '@/contracts/api/materialValidators'
import {
  parseMeasurementListResponse,
  parseMeasurementRecordedDataResponse,
  parseRecordedDataListResponse,
} from '@/contracts/api/measurementValidators'
import {
  parseAccessKeyCreateResponse,
  parseAccessKeyListResponse,
  parseDeletedResponse,
  parseJobSummaryList,
  parseLauncherListResponse,
  parseLauncherReconcileResponse,
  parseLauncherRuntimeList,
  parseNullableUserRecord,
  parseOkResponse,
  parseUserRecord,
  parseUserRecordList,
} from '@/contracts/api/runtimeValidators'
import {
  parseBooleanResponse,
  parseEmptyResponse,
  parseIdResponse,
  parseUpsertResponseList,
} from '@/contracts/api/validators'

export type * from '@/contracts/api'

const csrfRequired = { csrf: 'required' } as const
const csrfOmitted = { csrf: 'omit' } as const

function runtimeCrudListRequest(overrides: Partial<RuntimeCrudListRequest> = {}): RuntimeCrudListRequest {
  return {
    offset: 0,
    limit: 100,
    selected_ids: [],
    search_text: null,
    text_filter: {},
    filter: {},
    sort: null,
    ...overrides,
  }
}

export const dbTables = {
  User: {
    recordType: undefined as unknown as UserRecord,
    fetchMe: (context?: RequestContext) =>
      request<UserRecord>('get', '/auth/me', undefined, { signal: context?.signal, validate: parseUserRecord }),
    getAllUsersAdmin: (limit: number, offset: number, context?: RequestContext) =>
      request<UserRecord[]>(
        'get',
        `/user_admin/get_all_users/${encodeURIComponent(String(limit))}/${encodeURIComponent(String(offset))}`,
        undefined,
        { signal: context?.signal, validate: parseUserRecordList },
      ),
    deleteUserAdmin: (id: string) =>
      request<boolean>('delete', `/user_admin/${encodeURIComponent(id)}`, undefined, {
        ...csrfRequired,
        validate: parseBooleanResponse,
      }),
    getUserSummaryAdmin: (userId: string, context?: RequestContext) =>
      request<UserRecord | null>('get', `/user_data/summary/admin/${encodeURIComponent(userId)}`, undefined, {
        signal: context?.signal,
        validate: parseNullableUserRecord,
      }),
    getUserSummaryUser: (context?: RequestContext) =>
      request<UserRecord | null>('get', '/user_data/summary/user', undefined, {
        signal: context?.signal,
        validate: parseNullableUserRecord,
      }),
  },
  AccessKey: {
    list: (context?: RequestContext) =>
      request<{ total: number; items: AccessKeyRecord[] }>(
        'post',
        '/web/crud/access_keys/list',
        runtimeCrudListRequest({ sort: ['created_at', 'desc'] }),
        { ...csrfRequired, signal: context?.signal, validate: parseAccessKeyListResponse },
      ),
    create: (value: Readonly<{ name: string; scopes: readonly AccessKeyScope[]; expires_at?: string | null }>) =>
      request<{ access_key: AccessKeyRecord; secret: string }>('post', '/web/users/me/access-tokens', value, {
        ...csrfRequired,
        validate: parseAccessKeyCreateResponse,
      }),
    revoke: (id: string) =>
      request<{ deleted: number }>(
        'post',
        '/web/crud/access_keys/delete',
        { ids: [id] },
        {
          ...csrfRequired,
          validate: parseDeletedResponse,
        },
      ),
  },
  Launcher: {
    list: (context?: RequestContext) =>
      request<{ total: number; items: LauncherRecord[] }>(
        'post',
        '/web/crud/launchers/list',
        runtimeCrudListRequest({ limit: 200, sort: ['last_heartbeat_at', 'desc'] }),
        { ...csrfRequired, signal: context?.signal, validate: parseLauncherListResponse },
      ),
    runtime: (context?: RequestContext) =>
      request<LauncherRuntime[]>('get', '/web/launchers/runtime', undefined, {
        signal: context?.signal,
        validate: parseLauncherRuntimeList,
      }),
    reconcile: () =>
      request<{ ok: true; launchers: number }>('post', '/web/launchers/reconcile-disconnected', undefined, {
        ...csrfRequired,
        validate: parseLauncherReconcileResponse,
      }),
    cancelCurrentJob: (id: string) =>
      request<{ ok: true }>('post', `/web/launchers/${encodeURIComponent(id)}/cancel-current-job`, undefined, {
        ...csrfRequired,
        validate: parseOkResponse,
      }),
    resetWorker: (id: string) =>
      request<{ ok: true }>('post', `/web/launchers/${encodeURIComponent(id)}/reset-worker`, undefined, {
        ...csrfRequired,
        validate: parseOkResponse,
      }),
  },
  Job: {
    list: (activeOnly = true, context?: RequestContext) =>
      request<JobSummary[]>(
        'get',
        `/web/jobs?${new URLSearchParams({ active_only: String(activeOnly), limit: '200' })}`,
        undefined,
        { signal: context?.signal, validate: parseJobSummaryList },
      ),
    kill: (id: string) =>
      request<{ ok: true }>('post', `/web/jobs/${encodeURIComponent(id)}/kill`, undefined, {
        ...csrfRequired,
        validate: parseOkResponse,
      }),
  },
  Material: {
    recordType: undefined as unknown as MaterialRecord,
    listRows: (payload: GetListRequest = getListRequest(), context?: RequestContext) =>
      request<GetListResponse<PersistedMaterialRecord>>('post', '/material/list', payload, {
        ...csrfOmitted,
        signal: context?.signal,
        validate: parseMaterialListResponse,
      }),
    upsertRow: (payload: readonly MaterialUpsertInput[]) =>
      request<UpsertResponse[]>('post', '/material/upsert', payload, {
        ...csrfOmitted,
        validate: parseUpsertResponseList,
      }),
    deleteRows: (ids: readonly number[]) =>
      request<void>('delete', '/material/', ids, { ...csrfOmitted, validate: parseEmptyResponse }),
  },
  MaterialName: {
    recordType: undefined as unknown as MaterialNameRecord,
    listRows: (payload: GetListRequest = getListRequest(), context?: RequestContext) =>
      request<GetListResponse<PersistedMaterialNameRecord>>('post', '/material_name/list', payload, {
        ...csrfOmitted,
        signal: context?.signal,
        validate: parseMaterialNameListResponse,
      }),
    upsertRow: (payload: readonly MaterialNameUpsertInput[]) =>
      request<UpsertResponse[]>('post', '/material_name/upsert', payload, {
        ...csrfOmitted,
        validate: parseUpsertResponseList,
      }),
    deleteRows: (ids: readonly number[]) =>
      request<void>('delete', '/material_name/', ids, { ...csrfOmitted, validate: parseEmptyResponse }),
  },
  MaterialParameter: {
    recordType: undefined as unknown as MaterialParameterRecord,
    listRows: (payload: GetListRequest = getListRequest(), context?: RequestContext) =>
      request<GetListResponse<PersistedMaterialParameterRecord>>('post', '/material_parameter/list', payload, {
        ...csrfOmitted,
        signal: context?.signal,
        validate: parseMaterialParameterListResponse,
      }),
    upsertRow: (payload: readonly MaterialParameterUpsertInput[]) =>
      request<UpsertResponse[]>('post', '/material_parameter/upsert', payload, {
        ...csrfOmitted,
        validate: parseUpsertResponseList,
      }),
    deleteRows: (ids: readonly number[]) =>
      request<void>('delete', '/material_parameter/', ids, { ...csrfOmitted, validate: parseEmptyResponse }),
  },
  MaterialParameterQualifier: {
    recordType: undefined as unknown as MaterialParameterQualifierRecord,
    listRows: (payload: GetListRequest = getListRequest(), context?: RequestContext) =>
      request<GetListResponse<PersistedMaterialParameterQualifierRecord>>(
        'post',
        '/material_parameter_qualifier/list',
        payload,
        {
          ...csrfOmitted,
          signal: context?.signal,
          validate: parseMaterialParameterQualifierListResponse,
        },
      ),
    upsertRow: (payload: readonly MaterialParameterQualifierUpsertInput[]) =>
      request<UpsertResponse[]>('post', '/material_parameter_qualifier/upsert', payload, {
        ...csrfOmitted,
        validate: parseUpsertResponseList,
      }),
    deleteRows: (ids: readonly number[]) =>
      request<void>('delete', '/material_parameter_qualifier/', ids, {
        ...csrfOmitted,
        validate: parseEmptyResponse,
      }),
  },
  Experiment: {
    recordType: undefined as unknown as SavedExperimentRecord,
    listRows: (payload: GetListRequest = getListRequest(), context?: RequestContext) =>
      request<GetListResponse<SavedExperimentRecord>>('post', '/experiment/list', payload, {
        ...csrfRequired,
        signal: context?.signal,
        validate: parseExperimentListResponse,
      }),
    save: (payload: SaveExperimentRequest) =>
      request<SaveExperimentResponse>('post', '/experiment/save', payload, {
        ...csrfRequired,
        validate: parseSaveExperimentResponse,
      }),
    deleteRows: (ids: readonly number[]) =>
      request<void>('delete', '/experiment/', ids, { ...csrfRequired, validate: parseEmptyResponse }),
    usage: (experimentIds: readonly number[]) =>
      request<ExperimentUsageResponse>(
        'post',
        '/experiment/usage',
        { experimentIds },
        {
          ...csrfRequired,
          validate: parseExperimentUsageResponse,
        },
      ),
    available: (context?: RequestContext) =>
      request<AvailableExperimentsResponse>('get', '/experiment/available', undefined, {
        signal: context?.signal,
        validate: parseAvailableExperimentsResponse,
      }),
    demoCandidates: (context?: RequestContext) =>
      request<{ items: AvailableExperimentRecord[] }>('get', '/admin/demo-experiments/candidates', undefined, {
        signal: context?.signal,
        validate: parseDemoCandidatesResponse,
      }),
    replaceDemos: (experimentIds: readonly number[], defaultExperimentId: number | null) =>
      request<AvailableExperimentsResponse>(
        'put',
        '/admin/demo-experiments',
        {
          experiment_ids: experimentIds,
          default_experiment_id: defaultExperimentId,
        },
        { ...csrfRequired, validate: parseAvailableExperimentsResponse },
      ),
  },
  ExperimentRecord: {
    recordType: undefined as unknown as ExperimentRecordedDataRecord,
    listRows: (payload: GetListRequest & Readonly<{ experiment_id: number }>, context?: RequestContext) =>
      request<GetListResponse<ExperimentRecordedDataRecord>>('post', '/experiment_record/list', payload, {
        ...csrfOmitted,
        signal: context?.signal,
        validate: parseExperimentRecordListResponse,
      }),
  },
  Measurement: {
    recordType: undefined as unknown as MeasurementRecord,
    listRows: (payload: GetListRequest = getListRequest(), context?: RequestContext) =>
      request<GetListResponse<PersistedMeasurementRecord>>('post', '/measurement/list', payload, {
        ...csrfOmitted,
        signal: context?.signal,
        validate: parseMeasurementListResponse,
      }),
    create: (payload: MeasurementCreateRequest) =>
      request<{ id: number }>('post', '/measurement/create', payload, {
        ...csrfOmitted,
        validate: parseIdResponse,
      }),
    record: (id: number, payload: MeasurementRecordRequest) =>
      request<{ id: number }>('post', `/measurement/${id}/record`, payload, {
        ...csrfOmitted,
        validate: parseIdResponse,
      }),
    readRecordedData: async (id: number, context?: RequestContext) =>
      (
        await request<Readonly<{ recorded_data: MeasurementRecordedData }>>(
          'get',
          `/measurement/${id}/recorded-data`,
          undefined,
          { signal: context?.signal, validate: parseMeasurementRecordedDataResponse },
        )
      ).recorded_data,
    deleteRows: (ids: readonly number[]) =>
      request<void>('delete', '/measurement/', ids, { ...csrfOmitted, validate: parseEmptyResponse }),
  },
  RecordedData: {
    recordType: undefined as unknown as RecordedDataRecord,
    listRows: (
      payload: GetListRequest &
        Readonly<{ experiment_id?: number; experiment_record_ids?: readonly number[] }> = getListRequest(),
      context?: RequestContext,
    ) =>
      request<GetListResponse<PersistedRecordedDataRecord>>('post', '/recorded_data/list', payload, {
        ...csrfOmitted,
        signal: context?.signal,
        validate: parseRecordedDataListResponse,
      }),
  },
  Calculation: {
    recordType: undefined as unknown as CalculationRecord,
    listRows: (payload: GetListRequest, context?: RequestContext) =>
      request<GetListResponse<PersistedCalculationRecord>>('post', '/calculation/list', payload, {
        ...csrfOmitted,
        signal: context?.signal,
        validate: parseCalculationListResponse,
      }),
    upsertRow: (payload: readonly CalculationUpsertInput[]) =>
      request<UpsertResponse[]>('post', '/calculation/upsert', payload, {
        ...csrfOmitted,
        validate: parseUpsertResponseList,
      }),
    deleteRows: (ids: readonly number[]) =>
      request<void>('delete', '/calculation/', ids, { ...csrfOmitted, validate: parseEmptyResponse }),
  },
  CalculationData: {
    recordType: undefined as unknown as CalculationDataRecord,
    listRows: (payload: GetListRequest & Readonly<{ experiment_id: number }>, context?: RequestContext) =>
      request<GetListResponse<CalculationDataRecord>>('post', '/calculation_data/list', payload, {
        ...csrfOmitted,
        signal: context?.signal,
        validate: parseCalculationDataListResponse,
      }),
    analysis: (experimentId: number, context?: RequestContext) =>
      request<CalculationDataAnalysisResponse>(
        'post',
        '/calculation_data/analysis',
        { experiment_id: experimentId },
        { ...csrfOmitted, signal: context?.signal, validate: parseCalculationDataAnalysisResponse },
      ),
    analysisStatus: (experimentId: number, context?: RequestContext) =>
      request<CalculationDataAnalysisStatus>(
        'post',
        '/calculation_data/analysis/status',
        {
          experiment_id: experimentId,
        },
        { ...csrfOmitted, signal: context?.signal, validate: parseCalculationDataAnalysisStatus },
      ),
    missing: (payload: CalculationDataMissingRequest, context?: RequestContext) =>
      request<CalculationDataMissingResponse>('post', '/calculation_data/missing', payload, {
        ...csrfOmitted,
        signal: context?.signal,
        validate: parseCalculationDataMissingResponse,
      }),
    save: (
      payload: Readonly<{
        calculation_id: number
        measurement_id: number
        source_hash: string
        data: CalculationDataOutput
      }>,
      context?: RequestContext,
    ) =>
      request<CalculationDataSaveResponse>('post', '/calculation_data/save', payload, {
        ...csrfOmitted,
        signal: context?.signal,
        validate: parseCalculationDataSaveResponse,
      }),
    scalars: (
      payload: Readonly<{ calculation_id: number; exclude_measurement_id?: number }>,
      context?: RequestContext,
    ) =>
      request<{ total: number; items: CalculationDataScalar[] }>('post', '/calculation_data/scalars', payload, {
        ...csrfOmitted,
        signal: context?.signal,
        validate: parseCalculationDataScalarsResponse,
      }),
  },
} as const satisfies Record<string, unknown> & {
  readonly [TTable in DbTableName]: Readonly<{ recordType: DbTableRecord<TTable> }> & Record<string, unknown>
}

export { API_URL }

export function googleLoginUrl(returnTo = window.location.href) {
  return `${API_URL}/auth/google/start?return_to=${encodeURIComponent(returnTo)}`
}

export function startGoogleLogin(returnTo?: string) {
  window.location.assign(googleLoginUrl(returnTo))
}

export function logout() {
  return request<{ ok: true }>('post', '/auth/logout', undefined, { ...csrfOmitted, validate: parseOkResponse })
}

export function getListRequest(
  scope: NonNullable<GetListRequest['scope']> = 'visible',
  selectedIds: readonly number[] = [],
): GetListRequest {
  return {
    scope,
    offset: 0,
    limit: 24,
    selected_ids: selectedIds,
    search_text: null,
    text_filter: {},
    filter: {},
    null_filter: {},
    sort: ['updated_at', 'desc'],
  }
}
