import { readMeasurementResults } from './measurementResults'
import type { CalculationUpsertResponse } from '@/contracts/api/calculation'
import { externalizeObjects } from './objectStorage'
import { calculationDataOutputSchema } from '@/contracts/api/calculationValidators'
import { parseCalculationUpsertResponse } from '@/contracts/api/calculationValidators'
import { API_URL, request, browserClient, type CaembleClient } from './http'
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
  MeasurementCreateRequest,
  MeasurementRecord,
  MeasurementRecordedData,
  PersistedCalculationRecord,
  PersistedMeasurementRecord,
  PersistedRecordedDataRecord,
  RecordedDataRecord,
  RuntimeCrudListRequest,
  SaveExperimentRequest,
  SaveExperimentResponse,
  SavedExperimentRecord,
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
import { parseBooleanResponse, parseEmptyResponse, parseIdResponse } from '@/contracts/api/validators'

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

export function createDbTables(client: CaembleClient) {
  const { request } = client
  return {
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
          resolveObjects: context?.resolveObjects ?? true,
          validate: parseMeasurementListResponse,
        }),
      create: async (payload: MeasurementCreateRequest) =>
        request<{ id: number }>(
          'post',
          '/measurement/create',
          await externalizeObjects(
            client,
            { purpose: 'measurement', experiment_id: payload.experiment_id, request_id: crypto.randomUUID() },
            payload,
          ),
          {
            ...csrfOmitted,
            validate: parseIdResponse,
          },
        ),
      readResults: (id: number, context?: RequestContext) => readMeasurementResults(client, id, context),
      readRecordedData: async (id: number, context?: RequestContext) =>
        (
          await request<Readonly<{ recorded_data: MeasurementRecordedData }>>(
            'get',
            `/measurement/${id}/recorded-data`,
            undefined,
            {
              ...context,
              resolveObjects: context?.resolveObjects ?? true,
              validate: parseMeasurementRecordedDataResponse,
            },
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
          resolveObjects: context?.resolveObjects ?? true,
          validate: parseRecordedDataListResponse,
        }),
    },
    Calculation: {
      recordType: undefined as unknown as CalculationRecord,
      listRows: (payload: GetListRequest & Readonly<{ experiment_id?: number }>, context?: RequestContext) =>
        request<GetListResponse<PersistedCalculationRecord>>('post', '/calculation/list', payload, {
          ...csrfOmitted,
          signal: context?.signal,
          resolveObjects: true,
          validate: parseCalculationListResponse,
        }),
      upsertRow: async (payload: readonly CalculationUpsertInput[]) => {
        const stored = []
        for (const item of payload) {
          stored.push({
            ...item,
            output_layout: await externalizeObjects(
              client,
              { purpose: 'layout', experiment_id: item.experiment_id, request_id: crypto.randomUUID() },
              item.output_layout,
            ),
          })
        }
        return request<CalculationUpsertResponse[]>('post', '/calculation/upsert', stored, {
          ...csrfOmitted,
          validate: parseCalculationUpsertResponse,
        })
      },
      deleteRows: (ids: readonly number[]) =>
        request<void>('delete', '/calculation/', ids, { ...csrfOmitted, validate: parseEmptyResponse }),
    },
    CalculationData: {
      recordType: undefined as unknown as CalculationDataRecord,
      listRows: (payload: GetListRequest & Readonly<{ experiment_id: number }>, context?: RequestContext) =>
        request<GetListResponse<CalculationDataRecord>>('post', '/calculation_data/list', payload, {
          ...csrfOmitted,
          signal: context?.signal,
          resolveObjects: context?.resolveObjects ?? true,
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
      save: async (
        payload: Readonly<{
          calculation_id: number
          measurement_id: number
          source_hash: string
          data: CalculationDataOutput
        }>,
        context?: RequestContext,
      ) => {
        calculationDataOutputSchema.parse(payload.data)
        const values = Array.isArray(payload.data.data) ? payload.data.data : [payload.data.data]
        const count = values.length
        let scale = 0
        for (const value of values) scale = Math.max(scale, Math.abs(value))
        let scaledMean = 0
        if (scale) for (const value of values) scaledMean += value / scale / count
        let variance = 0
        if (scale && count > 1) for (const value of values) variance += (value / scale - scaledMean) ** 2 / (count - 1)
        const mean = count ? scale * scaledMean : null
        const std = count ? scale * Math.sqrt(variance) : null
        const data = (await externalizeObjects(
          client,
          { purpose: 'calculation', measurement_id: payload.measurement_id, calculation_id: payload.calculation_id },
          payload.data,
          context?.signal,
        )) as Record<string, unknown>
        if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
          data.summary = {
            kind: 'tensor',
            rank: payload.data.shape.length,
            count,
            mean: mean !== null && Number.isFinite(mean) ? mean : null,
            std: std !== null && Number.isFinite(std) ? std : null,
          }
        }
        return request<CalculationDataSaveResponse>(
          'post',
          '/calculation_data/save',
          { ...payload, data },
          {
            ...csrfOmitted,
            signal: context?.signal,
            validate: parseCalculationDataSaveResponse,
          },
        )
      },
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
}

export const dbTables = createDbTables(browserClient)

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
