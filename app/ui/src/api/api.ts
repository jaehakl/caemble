import { API_URL, request } from './http'

export type GetListRequest = Readonly<{
  scope?: 'visible' | 'mine' | 'public'
  offset: number
  limit: number | null
  selected_ids: readonly number[]
  search_text: string | null
  text_filter: Readonly<Record<string, readonly string[]>>
  filter: Readonly<Record<string, readonly unknown[]>>
  null_filter?: Readonly<Record<string, 'is_null' | 'is_not_null'>>
  sort: readonly [string, 'asc' | 'desc'] | readonly (readonly [string, 'asc' | 'desc'])[] | null
  random?: boolean
  include_system?: boolean
}>

export type UpsertResponse = Readonly<{
  id: number
  fk_not_found?: Readonly<Record<string, readonly number[]>> | null
}>

export type AccessKeyScope = 'client' | 'launcher'
export type AccessKeyRecord = Readonly<{
  id: string
  user_id: string
  key_type: string
  name: string
  key_prefix: string
  scopes: readonly string[]
  status: string
  last_used_at?: string | null
  expires_at?: string | null
  created_at?: string | null
  revoked_at?: string | null
}>

export type LauncherRecord = Readonly<{
  id: string
  user_id: string
  launcher_name: string
  ip_address?: string | null
  status: string
  slave_app_ids: readonly string[]
  connected_at?: string | null
  last_heartbeat_at?: string | null
  disconnected_at?: string | null
  created_at?: string | null
  updated_at?: string | null
}>

export type LauncherRuntime = Readonly<{
  launcher_id: string
  current_job_id?: string | null
  loaded_slave_app_id?: string | null
  worker_status?: string | null
  resetting: boolean
  metadata: Readonly<Record<string, unknown>>
}>

export type JobState =
  'queued' | 'assigned' | 'answer_ready' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'killed'
export type JobSummary = Readonly<{
  id: string
  user_id: string
  handler_type: string
  slave_app_id: string
  state: JobState
  latest_progress: Readonly<{ time: string; progress: unknown }> | null
  launcher_id?: string | null
  assigned_at?: string | null
  answer_ready_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  cancel_requested_at?: string | null
  last_error?: string | null
  attempt_count: number
  created_at?: string | null
  updated_at?: string | null
}>

export type ExperimentSourceBundle = Readonly<{ files: Readonly<Record<string, string>> }>
type ExperimentDerivedCounts = Readonly<{
  measurements: number
  recordedData: number
  calculations: number
}>
type ExperimentMetadata = Readonly<{
  namespace: string
  repository: string
  key: string
  name: string
  description: string | null
  sourceBundle: ExperimentSourceBundle
  bundleHash: string
}>
export type SaveExperimentRequest = ExperimentMetadata &
  (
    | Readonly<{ mode: 'create'; initialVersion?: '0.1.0' }>
    | Readonly<{ mode: 'overwrite'; experimentId: number; baseBundleHash: string }>
    | Readonly<{ mode: 'new_version'; experimentId: number; baseBundleHash: string; bump: 'patch' | 'minor' | 'major' }>
  )
export type SaveExperimentResponse = Readonly<{
  id: number
  action: 'create' | 'overwrite' | 'new_version'
  namespace: string
  repository: string
  key: string
  version: string
  coordinate: string
  bundleHash: string
  sourceLocked: boolean
  derivedCounts: ExperimentDerivedCounts
}>

type MaterialSnapshot = Readonly<{
  materials: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  materialColors?: Readonly<Record<string, unknown>>
}>
type MeasurementMaterialParameters = Readonly<{
  experiment: MaterialSnapshot
  tasks: Readonly<Record<string, MaterialSnapshot>>
}>
type PersistedDataTensor = Readonly<{
  shape: readonly number[]
  axes?: readonly Readonly<{ ticks?: readonly (number | string)[]; implicitOrdinal?: true }>[]
  storage: Readonly<{ kind: 'inline'; value: unknown }> | Readonly<{ kind: 'base64'; data: string; byteLength: number }>
}>
type DataSchema = Readonly<Record<string, unknown>>

export type RecordedDataSaveLeaf = Readonly<{
  quantity_kind: string | null
  tensor_order: number
  dtype: string
  data_schema: DataSchema
  data: PersistedDataTensor
}>
export interface RecordedDataSaveGroup extends Readonly<Record<string, RecordedDataSaveNode>> {}
export type RecordedDataSaveNode = RecordedDataSaveLeaf | RecordedDataSaveGroup
export interface MeasurementRecordedData extends Readonly<Record<string, RecordedDataSaveNode>> {}
export type MeasurementCreateRequest = Readonly<{
  experiment_id: number
  experiment_source_hash: string
  vars: Readonly<Record<string, unknown>>
  material_parameters: MeasurementMaterialParameters
}>
export type MeasurementRecordRequest = Readonly<{ recorded_data: MeasurementRecordedData }>
export type GetListResponse<TItem> = { items: TItem[]; total: number }

type UserRecord = Readonly<{
  id: string
  email?: string | null
  display_name?: string | null
  picture_url?: string | null
  is_active?: boolean | null
  roles: readonly string[]
  created_at?: string | null
  updated_at?: string | null
  experiment_namespaces: readonly string[]
}>
type MaterialRecord = Readonly<{
  id?: number
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  inchi?: string | null
  description?: string | null
  color?: string | null
}>
type MaterialNameRecord = Readonly<{
  id?: number
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  material_id: number
  name: string
}>
type MaterialParameterRecord = Readonly<{
  id?: number
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  material_id: number
  name: string
  value: unknown | null
  source?: string | null
  version?: string | null
  description?: string | null
  temperature?: number | null
  pressure?: number | null
  frequency?: number | null
}>
type MaterialParameterQualifierRecord = Readonly<{
  id?: number
  created_at?: string | null
  updated_at?: string | null
  material_parameter_id: number
  name: string
  value: number
}>
type ExperimentRecord = Readonly<{
  id: number
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  namespace: string
  repository_slug: string
  experiment_key: string
  version_major: number
  version_minor: number
  version_patch: number
  name: string
  description?: string | null
  source_bundle: ExperimentSourceBundle
  source_hash: string
  repository?: string
  key?: string
  version?: string
  coordinate?: string
  bundleHash?: string
  sourceLocked?: boolean
  derivedCounts?: ExperimentDerivedCounts
}>
type MeasurementRecord = Readonly<{
  id?: number
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  experiment_id: number
  vars: Readonly<Record<string, unknown>>
  material_parameters: MeasurementMaterialParameters
  recorded_at: string | null
}>
type RecordedDataRecord = Readonly<{
  id?: number
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  measurement_id: number
  name: string
  quantity_kind: string | null
  tensor_order: number
  dtype: string
  data_schema?: DataSchema | null
  data?: unknown | null
  data_url?: string | null
  file_size?: number | null
}>
type CalculationRecord = Readonly<{
  id?: number
  created_at?: string | null
  updated_at?: string | null
  experiment_id: number
  name: string
  description?: string | null
  source_code: string
}>

export type CalculationDataOutput = Readonly<{
  dtype: 'float32' | 'float64' | 'int8' | 'int16' | 'int32' | 'uint8' | 'uint16' | 'uint32'
  shape: readonly number[]
  data: number | readonly number[]
  axes: readonly Readonly<{ name: string; ticks: readonly number[]; unit?: string }>[]
}>
export type CalculationDataTarget = Readonly<{ calculation_id: number; measurement_id: number }>
export type CalculationDataMissingRequest = Readonly<{
  experiment_id: number
  calculation_id?: number
  measurement_id?: number
}>
export type CalculationDataScalar = Readonly<{ measurement_id: number; value: number }>

type RuntimeCrudListRequest = Readonly<{
  offset: number
  limit: number | null
  selected_ids: readonly string[]
  search_text: string | null
  text_filter: Readonly<Record<string, readonly string[]>>
  filter: Readonly<Record<string, readonly unknown[]>>
  sort: readonly [string, 'asc' | 'desc'] | null
}>

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
    fetchMe: () => request<UserRecord>('get', '/auth/me'),
    getAllUsersAdmin: (limit: number, offset: number) =>
      request<UserRecord[]>(
        'get',
        `/user_admin/get_all_users/${encodeURIComponent(String(limit))}/${encodeURIComponent(String(offset))}`,
      ),
    deleteUserAdmin: (id: string) => request<boolean>('get', `/user_admin/delete/${encodeURIComponent(id)}`),
    getUserSummaryAdmin: (userId: string) =>
      request<UserRecord | null>('get', `/user_data/summary/admin/${encodeURIComponent(userId)}`),
    getUserSummaryUser: () => request<UserRecord | null>('get', '/user_data/summary/user'),
  },
  AccessKey: {
    list: () =>
      request<{ total: number; items: AccessKeyRecord[] }>(
        'post',
        '/web/crud/access_keys/list',
        runtimeCrudListRequest({ sort: ['created_at', 'desc'] }),
      ),
    create: (value: Readonly<{ name: string; scopes: readonly AccessKeyScope[]; expires_at?: string | null }>) =>
      request<{ access_key: AccessKeyRecord; secret: string }>('post', '/web/users/me/access-tokens', value),
    revoke: (id: string) => request<{ deleted: number }>('post', '/web/crud/access_keys/delete', { ids: [id] }),
  },
  Launcher: {
    list: () =>
      request<{ total: number; items: LauncherRecord[] }>(
        'post',
        '/web/crud/launchers/list',
        runtimeCrudListRequest({ limit: 200, sort: ['last_heartbeat_at', 'desc'] }),
      ),
    runtime: () => request<LauncherRuntime[]>('get', '/web/launchers/runtime'),
    reconcile: () => request<{ ok: true; launchers: number }>('post', '/web/launchers/reconcile-disconnected'),
    cancelCurrentJob: (id: string) =>
      request<{ ok: true }>('post', `/web/launchers/${encodeURIComponent(id)}/cancel-current-job`),
    resetWorker: (id: string) => request<{ ok: true }>('post', `/web/launchers/${encodeURIComponent(id)}/reset-worker`),
  },
  Job: {
    list: (activeOnly = true) =>
      request<JobSummary[]>(
        'get',
        `/web/jobs?${new URLSearchParams({ active_only: String(activeOnly), limit: '200' })}`,
      ),
    kill: (id: string) => request<{ ok: true }>('post', `/web/jobs/${encodeURIComponent(id)}/kill`),
  },
  Material: {
    recordType: undefined as unknown as MaterialRecord,
    listRows: (payload: GetListRequest = getListRequest()) =>
      request<GetListResponse<MaterialRecord>>('post', '/material/list', payload),
    upsertRow: (payload: readonly MaterialRecord[]) => request<UpsertResponse[]>('post', '/material/upsert', payload),
    deleteRows: (ids: readonly number[]) => request<null>('delete', '/material/', ids),
  },
  MaterialName: {
    recordType: undefined as unknown as MaterialNameRecord,
    listRows: (payload: GetListRequest = getListRequest()) =>
      request<GetListResponse<MaterialNameRecord>>('post', '/material_name/list', payload),
    upsertRow: (payload: readonly MaterialNameRecord[]) =>
      request<UpsertResponse[]>('post', '/material_name/upsert', payload),
    deleteRows: (ids: readonly number[]) => request<null>('delete', '/material_name/', ids),
  },
  MaterialParameter: {
    recordType: undefined as unknown as MaterialParameterRecord,
    listRows: (payload: GetListRequest = getListRequest()) =>
      request<GetListResponse<MaterialParameterRecord>>('post', '/material_parameter/list', payload),
    upsertRow: (payload: readonly MaterialParameterRecord[]) =>
      request<UpsertResponse[]>('post', '/material_parameter/upsert', payload),
    deleteRows: (ids: readonly number[]) => request<null>('delete', '/material_parameter/', ids),
  },
  MaterialParameterQualifier: {
    recordType: undefined as unknown as MaterialParameterQualifierRecord,
    listRows: (payload: GetListRequest = getListRequest()) =>
      request<GetListResponse<MaterialParameterQualifierRecord>>('post', '/material_parameter_qualifier/list', payload),
    upsertRow: (payload: readonly MaterialParameterQualifierRecord[]) =>
      request<UpsertResponse[]>('post', '/material_parameter_qualifier/upsert', payload),
    deleteRows: (ids: readonly number[]) => request<null>('delete', '/material_parameter_qualifier/', ids),
  },
  Experiment: {
    recordType: undefined as unknown as ExperimentRecord,
    listRows: (payload: GetListRequest = getListRequest()) =>
      request<GetListResponse<ExperimentRecord>>('post', '/experiment/list', payload),
    save: (payload: SaveExperimentRequest) => request<SaveExperimentResponse>('post', '/experiment/save', payload),
    deleteRows: (ids: readonly number[]) => request<null>('delete', '/experiment/', ids),
    usage: (experimentIds: readonly number[]) =>
      request<{ items: { experimentId: number; sourceLocked: boolean; derivedCounts: ExperimentDerivedCounts }[] }>(
        'post',
        '/experiment/usage',
        { experimentIds },
      ),
  },
  Measurement: {
    recordType: undefined as unknown as MeasurementRecord,
    listRows: (payload: GetListRequest = getListRequest()) =>
      request<GetListResponse<MeasurementRecord>>('post', '/measurement/list', payload),
    create: (payload: MeasurementCreateRequest) => request<{ id: number }>('post', '/measurement/create', payload),
    record: (id: number, payload: MeasurementRecordRequest) =>
      request<{ id: number }>('post', `/measurement/${id}/record`, payload),
    readRecordedData: async (id: number) =>
      (await request<MeasurementRecordRequest>('get', `/measurement/${id}/recorded-data`)).recorded_data,
    deleteRows: (ids: readonly number[]) => request<null>('delete', '/measurement/', ids),
  },
  RecordedData: {
    recordType: undefined as unknown as RecordedDataRecord,
    listRows: (payload: GetListRequest = getListRequest()) =>
      request<GetListResponse<RecordedDataRecord>>('post', '/recorded_data/list', payload),
  },
  Calculation: {
    recordType: undefined as unknown as CalculationRecord,
    listRows: (payload: GetListRequest) =>
      request<GetListResponse<CalculationRecord>>('post', '/calculation/list', payload),
    upsertRow: (payload: readonly CalculationRecord[]) =>
      request<UpsertResponse[]>('post', '/calculation/upsert', payload),
    deleteRows: (ids: readonly number[]) => request<null>('delete', '/calculation/', ids),
  },
  CalculationData: {
    missing: (payload: CalculationDataMissingRequest) =>
      request<{ total: number; items: CalculationDataTarget[] }>('post', '/calculation_data/missing', payload),
    save: (
      payload: Readonly<{
        calculation_id: number
        measurement_id: number
        source_hash: string
        data: CalculationDataOutput
      }>,
    ) => request<{ id: number; created: boolean }>('post', '/calculation_data/save', payload),
    scalars: (payload: Readonly<{ calculation_id: number; exclude_measurement_id?: number }>) =>
      request<{ total: number; items: CalculationDataScalar[] }>('post', '/calculation_data/scalars', payload),
  },
} as const

export { API_URL }

export function googleLoginUrl(returnTo = window.location.href) {
  return `${API_URL}/auth/google/start?return_to=${encodeURIComponent(returnTo)}`
}

export function startGoogleLogin(returnTo?: string) {
  window.location.assign(googleLoginUrl(returnTo))
}

export function logout() {
  return request<{ ok: true }>('post', '/auth/logout')
}

export function getListRequest(
  scope: NonNullable<GetListRequest['scope']> = 'visible',
  selectedIds: number[] = [],
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

export type DbTableName = {
  [TTable in keyof typeof dbTables]: 'recordType' extends keyof (typeof dbTables)[TTable] ? TTable : never
}[keyof typeof dbTables]
export type DbTableRecord<TTable extends DbTableName> = (typeof dbTables)[TTable] extends {
  recordType: infer TRecord
}
  ? TRecord
  : never
