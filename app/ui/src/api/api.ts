import { z } from 'zod'
import { API_URL, request } from './http'

const getListRequestSchema = z.object({
  scope: z.enum(['visible', 'mine', 'public']).optional(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
  selected_ids: z.array(z.number().int()),
  search_text: z.string().nullable(),
  text_filter: z.record(z.string(), z.array(z.string())),
  filter: z.record(z.string(), z.array(z.unknown())),
  sort: z.tuple([z.string(), z.enum(['asc', 'desc'])]).nullable(),
  random: z.boolean().optional(),
})

const upsertResponseSchema = z.object({
  id: z.number().int(),
  fk_not_found: z.record(z.string(), z.array(z.number().int())).nullable().optional(),
})
const logoutResponseSchema = z.object({ ok: z.literal(true) })
const deleteResponseSchema = z.null()
const authenticatedUserSchema = z.object({
  id: z.string(),
  email: z.string().email().nullable().optional(),
  display_name: z.string().nullable().optional(),
  picture_url: z.string().url().nullable().optional(),
  is_active: z.boolean().nullable().optional(),
  roles: z.array(z.string()),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})
const accessKeyScopeSchema = z.enum(['client', 'launcher'])
const runtimeCrudListRequestSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().nullable(),
  selected_ids: z.array(z.string()),
  search_text: z.string().nullable(),
  text_filter: z.record(z.string(), z.array(z.string())),
  filter: z.record(z.string(), z.array(z.unknown())),
  sort: z.tuple([z.string(), z.enum(['asc', 'desc'])]).nullable(),
})
const accessKeySchema = z.object({
  id: z.string(),
  user_id: z.string(),
  key_type: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  scopes: z.array(z.string()),
  status: z.string(),
  last_used_at: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  revoked_at: z.string().nullable().optional(),
})
const accessKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(128),
  scopes: z.array(accessKeyScopeSchema).min(1).max(2),
  expires_at: z.string().nullable().optional(),
})
const accessKeyCreateResultSchema = z.object({
  access_key: accessKeySchema,
  secret: z.string().min(1),
})
const launcherSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  launcher_name: z.string(),
  ip_address: z.string().nullable().optional(),
  status: z.string(),
  slave_app_ids: z.array(z.string()),
  connected_at: z.string().nullable().optional(),
  last_heartbeat_at: z.string().nullable().optional(),
  disconnected_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})
const launcherRuntimeSchema = z.object({
  launcher_id: z.string(),
  current_job_id: z.string().nullable().optional(),
  loaded_slave_app_id: z.string().nullable().optional(),
  worker_status: z.string().nullable().optional(),
  resetting: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
})
const jobStateSchema = z.enum([
  'queued',
  'assigned',
  'answer_ready',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'killed',
])
const jobSummarySchema = z.object({
  id: z.string(),
  user_id: z.string(),
  handler_type: z.string(),
  slave_app_id: z.string(),
  state: jobStateSchema,
  latest_progress: z
    .object({
      time: z.string(),
      progress: z.unknown(),
    })
    .nullable(),
  launcher_id: z.string().nullable().optional(),
  assigned_at: z.string().nullable().optional(),
  answer_ready_at: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  cancel_requested_at: z.string().nullable().optional(),
  last_error: z.string().nullable().optional(),
  attempt_count: z.number().int().nonnegative(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})
const saveCodeEntityRequestSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().min(1),
  description: z.string().nullable(),
  code: z.string().min(1),
  rawCodeHash: z.string().regex(/^[0-9a-f]{64}$/),
  semanticHash: z.string().regex(/^[0-9a-f]{64}$/),
  semanticHashVersion: z.literal(1),
  baseRawCodeHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  baseSemanticHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
})
const saveExperimentRequestSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().min(1),
  description: z.string().nullable(),
  code: z.string().min(1),
  rawCodeHash: z.string().regex(/^[0-9a-f]{64}$/),
  semanticHash: z.string().regex(/^[0-9a-f]{64}$/),
  semanticHashVersion: z.literal(1),
  baseRawCodeHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  baseSemanticHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  simulationCode: z.string().min(1),
  simulationRawCodeHash: z.string().regex(/^[0-9a-f]{64}$/),
  baseSimulationRawCodeHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
})
const saveCodeEntityResponseSchema = z.object({
  id: z.number().int(),
  action: z.enum(['created', 'updated', 'forked']),
  parentId: z.number().int().nullable(),
})
const measurementContextRequestSchema = z.object({
  structure_id: z.number().int(),
  experiment_id: z.number().int(),
})
const dataSchemaAxisSchema = z
  .object({
    length: z.number().int().positive().optional(),
    name: z.string().min(1).optional(),
    ticks: z
      .array(z.union([z.number().finite(), z.string()]))
      .readonly()
      .optional(),
    unit: z.string().min(1).optional(),
    quantityKind: z.string().min(1).optional(),
  })
  .strict()
const dataSchemaSchema = z
  .object({
    dtype: z.enum([
      'bool',
      'string',
      'int8',
      'int16',
      'int32',
      'int64',
      'uint8',
      'uint16',
      'uint32',
      'uint64',
      'float16',
      'float32',
      'float64',
    ]),
    unit: z.string().min(1).optional(),
    quantityKind: z.string().min(1).optional(),
    basis: z
      .tuple([
        z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).readonly(),
        z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).readonly(),
        z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).readonly(),
      ])
      .readonly()
      .optional(),
    axes: z.array(dataSchemaAxisSchema).min(1).readonly().optional(),
  })
  .strict()
const measurementSaveRequestSchema = z.object({
  sample_id: z.number().int(),
  setup_id: z.number().int(),
  recorded_data: z.array(
    z.object({
      name: z.string().min(1),
      quantity_kind: z.string().min(1).nullable(),
      tensor_order: z.number().int().nonnegative(),
      dtype: z.string().min(1),
      data_schema: dataSchemaSchema,
      data: z.unknown(),
    }),
  ),
})
const measurementSaveResponseSchema = z.object({ id: z.number().int() })

export type GetListRequest = z.infer<typeof getListRequestSchema>
export type UpsertResponse = z.infer<typeof upsertResponseSchema>
export type SaveCodeEntityRequest = z.infer<typeof saveCodeEntityRequestSchema>
export type SaveExperimentRequest = z.infer<typeof saveExperimentRequestSchema>
export type SaveCodeEntityResponse = z.infer<typeof saveCodeEntityResponseSchema>
export type MeasurementSaveRequest = z.infer<typeof measurementSaveRequestSchema>
export type GetListResponse<TItem> = { items: TItem[]; total: number }
export type AccessKeyScope = z.infer<typeof accessKeyScopeSchema>
export type AccessKeyRecord = z.infer<typeof accessKeySchema>
export type LauncherRecord = z.infer<typeof launcherSchema>
export type LauncherRuntime = z.infer<typeof launcherRuntimeSchema>
export type JobState = z.infer<typeof jobStateSchema>
export type JobSummary = z.infer<typeof jobSummarySchema>

function runtimeCrudListRequest(overrides: Partial<z.infer<typeof runtimeCrudListRequestSchema>> = {}) {
  return runtimeCrudListRequestSchema.parse({
    offset: 0,
    limit: 100,
    selected_ids: [],
    search_text: null,
    text_filter: {},
    filter: {},
    sort: null,
    ...overrides,
  })
}

export const dbTables = {
  User: {
    rowSchema: z.object({
      id: z.string(),
      email: z.string().email().nullable().optional(),
      display_name: z.string().nullable().optional(),
      picture_url: z.string().url().nullable().optional(),
      is_active: z.boolean().nullable().optional(),
      roles: z.array(z.string()),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
    }),
    async fetchMe() {
      return authenticatedUserSchema.parse(await request<unknown>('get', '/auth/me'))
    },
    async getAllUsersAdmin(limit: number, offset: number) {
      return z
        .array(this.rowSchema)
        .parse(
          await request<unknown>(
            'get',
            `/user_admin/get_all_users/${encodeURIComponent(String(limit))}/${encodeURIComponent(String(offset))}`,
          ),
        )
    },
    async deleteUserAdmin(id: string) {
      return z.boolean().parse(await request<unknown>('get', `/user_admin/delete/${encodeURIComponent(id)}`))
    },
    async getUserSummaryAdmin(userId: string) {
      return this.rowSchema
        .nullable()
        .parse(await request<unknown>('get', `/user_data/summary/admin/${encodeURIComponent(userId)}`))
    },
    async getUserSummaryUser() {
      return this.rowSchema.nullable().parse(await request<unknown>('get', '/user_data/summary/user'))
    },
  },

  AccessKey: {
    async list() {
      const schema = z.object({ total: z.number().int().nonnegative(), items: z.array(accessKeySchema) })
      return schema.parse(
        await request<unknown>(
          'post',
          '/web/crud/access_keys/list',
          runtimeCrudListRequest({ sort: ['created_at', 'desc'] }),
        ),
      )
    },
    async create(value: z.input<typeof accessKeyCreateSchema>) {
      return accessKeyCreateResultSchema.parse(
        await request<unknown>('post', '/web/users/me/access-tokens', accessKeyCreateSchema.parse(value)),
      )
    },
    async revoke(id: string) {
      return z
        .object({ deleted: z.number().int().nonnegative() })
        .parse(await request<unknown>('post', '/web/crud/access_keys/delete', { ids: [id] }))
    },
  },

  Launcher: {
    async list() {
      const schema = z.object({ total: z.number().int().nonnegative(), items: z.array(launcherSchema) })
      return schema.parse(
        await request<unknown>(
          'post',
          '/web/crud/launchers/list',
          runtimeCrudListRequest({ limit: 200, sort: ['last_heartbeat_at', 'desc'] }),
        ),
      )
    },
    async runtime() {
      return z.array(launcherRuntimeSchema).parse(await request<unknown>('get', '/web/launchers/runtime'))
    },
    async reconcile() {
      return z
        .object({ ok: z.literal(true), launchers: z.number().int().nonnegative() })
        .parse(await request<unknown>('post', '/web/launchers/reconcile-disconnected'))
    },
    async cancelCurrentJob(id: string) {
      return z
        .object({ ok: z.literal(true) })
        .parse(await request<unknown>('post', `/web/launchers/${encodeURIComponent(id)}/cancel-current-job`))
    },
    async resetWorker(id: string) {
      return z
        .object({ ok: z.literal(true) })
        .parse(await request<unknown>('post', `/web/launchers/${encodeURIComponent(id)}/reset-worker`))
    },
  },

  Job: {
    async list(activeOnly = true) {
      const query = new URLSearchParams({ active_only: String(activeOnly), limit: '200' })
      return z.array(jobSummarySchema).parse(await request<unknown>('get', `/web/jobs?${query.toString()}`))
    },
    async kill(id: string) {
      return z
        .object({ ok: z.literal(true) })
        .parse(await request<unknown>('post', `/web/jobs/${encodeURIComponent(id)}/kill`))
    },
  },

  Material: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      inchi: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable()
        .optional(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/material/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/material/upsert', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/material/', payload))
    },
  },

  MaterialName: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      material_id: z.number().int(),
      name: z.string(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/material_name/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/material_name/upsert', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/material_name/', payload))
    },
  },

  MaterialParameter: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      material_id: z.number().int(),
      name: z.string(),
      value: z.unknown().nullable(),
      source: z.string().nullable().optional(),
      version: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      temperature: z.number().nullable().optional(),
      pressure: z.number().nullable().optional(),
      frequency: z.number().nullable().optional(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/material_parameter/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/material_parameter/upsert', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/material_parameter/', payload))
    },
  },

  MaterialParameterQualifier: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      material_parameter_id: z.number().int(),
      name: z.string(),
      value: z.number(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/material_parameter_qualifier/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z
        .array(upsertResponseSchema)
        .parse(await request<unknown>('post', '/material_parameter_qualifier/upsert', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/material_parameter_qualifier/', payload))
    },
  },

  Geometry: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      parent_id: z.number().int().nullable().optional(),
      name: z.string(),
      description: z.string().nullable().optional(),
      code: z.string(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/geometry/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/geometry/upsert', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/geometry/', payload))
    },
  },

  Structure: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      parent_id: z.number().int().nullable().optional(),
      name: z.string(),
      description: z.string().nullable().optional(),
      code: z.string(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/structure/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/structure/upsert', payload))
    },
    async save(item: SaveCodeEntityRequest) {
      const payload = saveCodeEntityRequestSchema.parse(item)
      return saveCodeEntityResponseSchema.parse(await request<unknown>('post', '/structure/save', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/structure/', payload))
    },
  },

  Experiment: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      parent_id: z.number().int().nullable().optional(),
      name: z.string(),
      description: z.string().nullable().optional(),
      code: z.string(),
      simulation_code: z.string().nullable(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/experiment/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/experiment/upsert', payload))
    },
    async save(item: SaveExperimentRequest) {
      const payload = saveExperimentRequestSchema.parse(item)
      return saveCodeEntityResponseSchema.parse(await request<unknown>('post', '/experiment/save', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/experiment/', payload))
    },
  },

  Sample: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      structure_id: z.number().int(),
      vars: z.record(z.string(), z.unknown()),
      material_parameters: z.record(z.string(), z.unknown()),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/sample/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/sample/upsert', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/sample/', payload))
    },
  },

  Setup: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      experiment_id: z.number().int(),
      vars: z.record(z.string(), z.unknown()),
      material_parameters: z.record(z.string(), z.unknown()),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/setup/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/setup/upsert', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/setup/', payload))
    },
  },

  Measurement: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      sample_id: z.number().int(),
      setup_id: z.number().int(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/measurement/list', payload))
    },
    async listContext(structureId: number, experimentId: number) {
      const payload = measurementContextRequestSchema.parse({
        structure_id: structureId,
        experiment_id: experimentId,
      })
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/measurement/context-list', payload))
    },
    async save(item: MeasurementSaveRequest) {
      const payload = measurementSaveRequestSchema.parse(item)
      return measurementSaveResponseSchema.parse(await request<unknown>('post', '/measurement/save', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/measurement/upsert', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/measurement/', payload))
    },
  },

  RecordedData: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      measurement_id: z.number().int(),
      name: z.string(),
      quantity_kind: z.string().nullable(),
      tensor_order: z.number().int(),
      dtype: z.string(),
      data_schema: dataSchemaSchema.nullable().optional(),
      data: z.unknown().nullable().optional(),
      data_url: z.string().nullable().optional(),
      file_size: z.number().int().nullable().optional(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/recorded_data/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/recorded_data/upsert', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/recorded_data/', payload))
    },
  },

  DesignerModel: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      structure_id: z.number().int(),
      experiment_id: z.number().int(),
      model_url: z.string().nullable().optional(),
      file_size: z.number().int().nullable().optional(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/designer_model/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/designer_model/upsert', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/designer_model/', payload))
    },
  },

  PredictorModel: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      structure_id: z.number().int(),
      experiment_id: z.number().int(),
      model_url: z.string().nullable().optional(),
      file_size: z.number().int().nullable().optional(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/predictor_model/list', payload))
    },
    async upsertRow(items: readonly z.infer<(typeof this)['rowSchema']>[]) {
      const payload = z.array(this.rowSchema).parse(items)
      return z.array(upsertResponseSchema).parse(await request<unknown>('post', '/predictor_model/upsert', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/predictor_model/', payload))
    },
  },
} as const

export { API_URL }

export function googleLoginUrl(returnTo = window.location.href) {
  return `${API_URL}/auth/google/start?return_to=${encodeURIComponent(returnTo)}`
}

export function startGoogleLogin(returnTo?: string) {
  window.location.assign(googleLoginUrl(returnTo))
}

export async function logout() {
  return logoutResponseSchema.parse(await request<unknown>('post', '/auth/logout'))
}

export function getListRequest(
  scope: NonNullable<GetListRequest['scope']> = 'visible',
  selectedIds: number[] = [],
): GetListRequest {
  return getListRequestSchema.parse({
    scope,
    offset: 0,
    limit: 24,
    selected_ids: selectedIds,
    search_text: null,
    text_filter: {},
    filter: {},
    sort: ['updated_at', 'desc'],
  })
}

export type DbTableName = {
  [TTable in keyof typeof dbTables]: 'rowSchema' extends keyof (typeof dbTables)[TTable] ? TTable : never
}[keyof typeof dbTables]
export type DbTableRecord<TTable extends DbTableName> = (typeof dbTables)[TTable] extends {
  rowSchema: infer TSchema extends z.ZodType
}
  ? z.infer<TSchema>
  : never
