import { z } from 'zod'
import { API_URL, request } from './http'

type ApiGeometryCoordinate = `caemble:geometry/${string}/${string}/${string}@${number}.${number}.${number}`

const getListRequestSchema = z.object({
  scope: z.enum(['visible', 'mine', 'public']).optional(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
  selected_ids: z.array(z.number().int()),
  search_text: z.string().nullable(),
  text_filter: z.record(z.string(), z.array(z.string())),
  filter: z.record(z.string(), z.array(z.unknown())),
  null_filter: z
    .record(z.string(), z.enum(['is_null', 'is_not_null']))
    .optional()
    .default({}),
  sort: z
    .union([
      z.tuple([z.string(), z.enum(['asc', 'desc'])]),
      z.array(z.tuple([z.string(), z.enum(['asc', 'desc'])])).min(1),
    ])
    .nullable(),
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
  geometry_namespace: z.string().nullable(),
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
const geometryHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const geometryCoordinateSchema = z
  .string()
  .regex(
    /^caemble:geometry\/[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\/[a-z0-9](?:(?:[a-z0-9-]{0,62})[a-z0-9])?\/[a-z0-9](?:(?:[a-z0-9-]{0,62})[a-z0-9])?@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  )
  .refine(
    (value) =>
      value
        .split('@')[1]
        .split('.')
        .every((component) => Number(component) <= 2_147_483_647),
    'Geometry SemVer components must not exceed 2147483647',
  )
  .transform((value) => value as ApiGeometryCoordinate)
const geometryComponentNameSchema = z.string().regex(/^[A-Z][A-Za-z0-9_]*$/)
const geometryLocalCoordinateSchema = z
  .string()
  .regex(
    /^caemble:geometry\/[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\/[a-z0-9](?:(?:[a-z0-9-]{0,62})[a-z0-9])?\/[a-z0-9](?:(?:[a-z0-9-]{0,62})[a-z0-9])?@local$/,
  )
const geometrySnapshotImportSchema = z
  .object({
    exportName: geometryComponentNameSchema,
    alias: geometryComponentNameSchema,
    geometryVersionId: z.number().int().positive(),
    coordinate: geometryCoordinateSchema,
    moduleHash: geometryHashSchema,
  })
  .strict()
  .readonly()
const geometrySnapshotModuleSchema = z
  .object({
    geometryVersionId: z.number().int().positive(),
    coordinate: geometryCoordinateSchema,
    moduleFormatVersion: z.literal(4),
    cadApiVersion: z.literal(6),
    description: z.string().nullable(),
    source: z.string().min(1),
    sourceHash: geometryHashSchema,
    moduleHash: geometryHashSchema,
    imports: z.array(geometrySnapshotImportSchema).readonly(),
  })
  .strict()
  .readonly()
export const geometrySnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    entryImports: z.array(geometrySnapshotImportSchema).max(64).readonly(),
    modules: z.array(geometrySnapshotModuleSchema).max(256).readonly(),
  })
  .strict()
  .readonly()
export const experimentSourceBundleSchema = z
  .object({
    formatVersion: z.literal(5),
    files: z.record(z.string(), z.string()),
    geometrySnapshot: geometrySnapshotSchema,
  })
  .strict()
const saveExperimentRequestSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().min(1),
  description: z.string().nullable(),
  sourceBundle: experimentSourceBundleSchema,
  bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
  baseBundleHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
})
const saveCodeEntityResponseSchema = z.object({
  id: z.number().int(),
  action: z.enum(['created', 'updated', 'forked']),
  parentId: z.number().int().nullable(),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
})
const codeEntityHistoryItemSchema = z.object({
  id: z.number().int().positive(),
  parent_id: z.number().int().positive().nullable(),
  user_id: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
})
const codeEntityHistoryResponseSchema = z.object({
  selected_id: z.number().int().positive(),
  root_id: z.number().int().positive(),
  items: z.array(codeEntityHistoryItemSchema),
})
const geometryRepositorySchema = z.object({
  id: z.number().int().positive(),
  userId: z.string().nullable(),
  namespace: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
const geometryRepositoryRowSchema = z.object({
  id: z.number().int().positive(),
  user_id: z.string().nullable(),
  namespace: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
})
const geometryPackageRowSchema = z.object({
  id: z.number().int().positive(),
  repository_id: z.number().int().positive(),
  name: z.string(),
  user_id: z.string().nullable(),
  namespace: z.string(),
  repository: z.string(),
  repository_archived_at: z.string().nullable(),
  version_count: z.number().int().nonnegative(),
  latest_version: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
})
const geometryVersionRowSchema = z.object({
  id: z.number().int().positive(),
  package_id: z.number().int().positive(),
  version_major: z.number().int().nonnegative(),
  version_minor: z.number().int().nonnegative(),
  version_patch: z.number().int().nonnegative(),
  description: z.string().nullable(),
  source: z.string(),
  source_hash: geometryHashSchema,
  module_hash: geometryHashSchema,
  module_format_version: z.literal(4),
  cad_api_version: z.literal(6),
  archived_at: z.string().nullable(),
  repository_id: z.number().int().positive(),
  namespace: z.string(),
  repository: z.string(),
  package_name: z.string(),
  coordinate: geometryCoordinateSchema,
  version: z.string(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
})
const geometryExperimentReferenceSchema = z.object({
  id: z.number().int().positive(),
  user_id: z.string().nullable(),
  parent_id: z.number().int().positive().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  entry_alias: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
})
const geometryVersionSummarySchema = z.object({
  id: z.number().int().positive(),
  packageId: z.number().int().positive(),
  coordinate: geometryCoordinateSchema,
  version: z.string(),
  description: z.string().nullable(),
  sourceHash: geometryHashSchema,
  moduleHash: geometryHashSchema,
  moduleFormatVersion: z.literal(4),
  cadApiVersion: z.literal(6),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
})
const geometryResolvedVersionSchema = z.object({
  schemaVersion: z.literal(2),
  root: z.object({
    geometryVersionId: z.number().int().positive(),
    coordinate: geometryCoordinateSchema,
    moduleHash: geometryHashSchema,
    exports: z.array(geometryComponentNameSchema),
  }),
  modules: z.array(geometrySnapshotModuleSchema),
})
const geometryPublishDraftSchema = z.object({
  draftId: z.string().min(1),
  baseGeometryVersionId: z.number().int().positive().nullable().optional(),
  repositoryId: z.number().int().positive().nullable().optional(),
  repository: z.string().min(1),
  package: z.string().min(1),
  bump: z.enum(['patch', 'minor', 'major']).optional(),
  version: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  source: z.string(),
})
const geometryPublishRequestSchema = z.object({
  targetDraftId: z.string().min(1),
  drafts: z.array(geometryPublishDraftSchema).min(1),
})
const geometryPlanImportSchema = z.object({
  exportName: geometryComponentNameSchema,
  alias: geometryComponentNameSchema,
  geometryVersionId: z.number().int().positive().optional(),
  draftId: z.string().optional(),
  coordinate: geometryCoordinateSchema,
  moduleHash: geometryHashSchema,
})
const geometryPublishPlanSchema = z.object({
  planHash: geometryHashSchema,
  steps: z.array(
    z.object({
      draftId: z.string(),
      baseGeometryVersionId: z.number().int().positive().nullable(),
      repositoryId: z.number().int().positive().nullable(),
      repository: z.string(),
      package: z.string(),
      version: z.string(),
      coordinate: geometryCoordinateSchema,
      localCoordinate: geometryLocalCoordinateSchema,
      description: z.string().nullable(),
      source: z.string(),
      sourceHash: geometryHashSchema,
      moduleHash: geometryHashSchema,
      exports: z.array(geometryComponentNameSchema),
      imports: z.array(geometryPlanImportSchema),
    }),
  ),
  replacements: z.array(
    z.object({
      draftId: z.string(),
      localCoordinate: geometryLocalCoordinateSchema,
      coordinate: geometryCoordinateSchema,
    }),
  ),
})
const geometryPublishResponseSchema = z.object({
  planHash: geometryHashSchema,
  published: z.array(geometryVersionSummarySchema),
  replacements: geometryPublishPlanSchema.shape.replacements,
})
const geometryPublishConflictSchema = z.object({
  code: z.literal('geometry_version_conflict'),
  draftId: z.string(),
  coordinate: geometryCoordinateSchema,
  suggestedVersion: z.string(),
  revisedPlan: geometryPublishPlanSchema.nullable(),
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
const frozenMaterialParametersSchema = z
  .object({
    schemaVersion: z.literal(1),
    materials: z.record(z.string(), z.record(z.string(), z.unknown())),
    materialColors: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
const measurementMaterialParametersSchema = z
  .object({
    schemaVersion: z.literal(2),
    experiment: frozenMaterialParametersSchema,
    tasks: z.record(z.string(), frozenMaterialParametersSchema),
  })
  .strict()
const measurementCreateRequestSchema = z
  .object({
    experiment_id: z.number().int().positive(),
    experiment_source_hash: z.string().regex(/^[0-9a-f]{64}$/),
    vars: z.record(z.string(), z.unknown()),
    material_parameters: measurementMaterialParametersSchema,
  })
  .strict()
const measurementRecordRequestSchema = z
  .object({
    recorded_data: z.array(
      z
        .object({
          name: z.string().min(1),
          quantity_kind: z.string().min(1).nullable(),
          tensor_order: z.number().int().nonnegative(),
          dtype: z.string().min(1),
          data_schema: dataSchemaSchema,
          data: z.unknown(),
        })
        .strict(),
    ),
  })
  .strict()
const measurementMutationResponseSchema = z.object({ id: z.number().int().positive() })

export type GetListRequest = z.infer<typeof getListRequestSchema>
export type UpsertResponse = z.infer<typeof upsertResponseSchema>
export type SaveExperimentRequest = z.infer<typeof saveExperimentRequestSchema>
export type SaveCodeEntityResponse = z.infer<typeof saveCodeEntityResponseSchema>
export type MeasurementCreateRequest = z.input<typeof measurementCreateRequestSchema>
export type MeasurementRecordRequest = z.input<typeof measurementRecordRequestSchema>
export type CodeEntityHistoryItem = z.infer<typeof codeEntityHistoryItemSchema>
export type CodeEntityHistoryResponse = z.infer<typeof codeEntityHistoryResponseSchema>
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
      geometry_namespace: z.string().nullable(),
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

  GeometryRepository: {
    rowSchema: geometryRepositoryRowSchema,
    async listRows(listRequest: GetListRequest = getListRequest('mine')) {
      const payload = getListRequestSchema.parse(listRequest)
      return z
        .object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
        .parse(await request<unknown>('post', '/geometry/repositories/list', payload))
    },
  },

  GeometryPackage: {
    rowSchema: geometryPackageRowSchema,
    async listRows(listRequest: GetListRequest = getListRequest('mine')) {
      const payload = getListRequestSchema.parse(listRequest)
      return z
        .object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
        .parse(await request<unknown>('post', '/geometry/packages/list', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int().positive()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/geometry/packages/', payload))
    },
  },

  GeometryVersion: {
    rowSchema: geometryVersionRowSchema,
    async listRows(listRequest: GetListRequest = getListRequest('mine')) {
      const payload = getListRequestSchema.parse(listRequest)
      return z
        .object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
        .parse(await request<unknown>('post', '/geometry/versions/list', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int().positive()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/geometry/versions/', payload))
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
      source_bundle: experimentSourceBundleSchema,
      source_hash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/experiment/list', payload))
    },
    async save(item: SaveExperimentRequest) {
      const payload = saveExperimentRequestSchema.parse(item)
      return saveCodeEntityResponseSchema.parse(await request<unknown>('post', '/experiment/save', payload))
    },
    async history(id: number) {
      const payload = z.object({ id: z.number().int().positive() }).parse({ id })
      return codeEntityHistoryResponseSchema.parse(await request<unknown>('post', '/experiment/history', payload))
    },
    async deleteRows(ids: readonly number[]) {
      const payload = z.array(z.number().int()).parse(ids)
      deleteResponseSchema.parse(await request<unknown>('delete', '/experiment/', payload))
    },
  },

  Measurement: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
      experiment_id: z.number().int().positive(),
      vars: z.record(z.string(), z.unknown()),
      material_parameters: measurementMaterialParametersSchema,
      recorded_at: z.string().nullable(),
    }),
    async listRows(listRequest: GetListRequest = getListRequest()) {
      const payload = getListRequestSchema.parse(listRequest)
      const listResponseSchema = z.object({ total: z.number().int().nonnegative(), items: z.array(this.rowSchema) })
      return listResponseSchema.parse(await request<unknown>('post', '/measurement/list', payload))
    },
    async create(item: MeasurementCreateRequest) {
      const payload = measurementCreateRequestSchema.parse(item)
      return measurementMutationResponseSchema.parse(await request<unknown>('post', '/measurement/create', payload))
    },
    async record(id: number, item: MeasurementRecordRequest) {
      const measurementId = z.number().int().positive().parse(id)
      const payload = measurementRecordRequestSchema.parse(item)
      return measurementMutationResponseSchema.parse(
        await request<unknown>('post', `/measurement/${measurementId}/record`, payload),
      )
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
  },

  DesignerModel: {
    rowSchema: z.object({
      id: z.number().int().optional(),
      created_at: z.string().nullable().optional(),
      updated_at: z.string().nullable().optional(),
      user_id: z.string().nullable().optional(),
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

export const geometryApi = {
  parsePublishConflict(value: unknown) {
    return geometryPublishConflictSchema.safeParse(value)
  },
  async setNamespace(namespace: string) {
    return authenticatedUserSchema.parse(
      await request<unknown>('put', '/auth/geometry-namespace', {
        namespace: z.string().trim().min(1).parse(namespace),
      }),
    )
  },
  async createRepository(value: { slug: string; description?: string | null }) {
    return geometryRepositorySchema.parse(
      await request<unknown>('post', '/geometry/repositories', {
        slug: z.string().trim().min(1).parse(value.slug),
        description: value.description?.trim() || null,
      }),
    )
  },
  async archiveRepository(id: number) {
    return geometryRepositorySchema.parse(
      await request<unknown>('post', `/geometry/repositories/${z.number().int().positive().parse(id)}/archive`),
    )
  },
  async updateRepositoryDescription(id: number, description: string | null) {
    return geometryRepositorySchema.parse(
      await request<unknown>('put', `/geometry/repositories/${z.number().int().positive().parse(id)}`, {
        description: description?.trim() || null,
      }),
    )
  },
  async resolveVersion(versionId: number) {
    return geometryResolvedVersionSchema.parse(
      await request<unknown>('get', `/geometry/versions/${z.number().int().positive().parse(versionId)}/resolve`),
    )
  },
  async archiveVersion(versionId: number) {
    return geometryVersionSummarySchema.parse(
      await request<unknown>('post', `/geometry/versions/${z.number().int().positive().parse(versionId)}/archive`),
    )
  },
  async listDependents(versionId: number, listRequest: GetListRequest = getListRequest('mine')) {
    const payload = getListRequestSchema.parse(listRequest)
    return z
      .object({ total: z.number().int().nonnegative(), items: z.array(geometryVersionRowSchema) })
      .parse(
        await request<unknown>(
          'post',
          `/geometry/versions/${z.number().int().positive().parse(versionId)}/dependents/list`,
          payload,
        ),
      )
  },
  async listReferencingExperiments(versionId: number, listRequest: GetListRequest = getListRequest('mine')) {
    const payload = getListRequestSchema.parse(listRequest)
    return z
      .object({ total: z.number().int().nonnegative(), items: z.array(geometryExperimentReferenceSchema) })
      .parse(
        await request<unknown>(
          'post',
          `/geometry/versions/${z.number().int().positive().parse(versionId)}/experiments/list`,
          payload,
        ),
      )
  },
  async versionUsage(versionIds: readonly number[]) {
    const payload = z.array(z.number().int().positive()).max(256).parse(versionIds)
    return z
      .object({
        items: z.array(
          z.object({
            versionId: z.number().int().positive(),
            dependentVersionIds: z.array(z.number().int().positive()),
            dependentVersionCount: z.number().int().nonnegative(),
            experimentCount: z.number().int().nonnegative(),
            deletable: z.boolean(),
          }),
        ),
      })
      .parse(await request<unknown>('post', '/geometry/versions/usage', { versionIds: payload }))
  },
  async planPublish(value: z.input<typeof geometryPublishRequestSchema>) {
    return geometryPublishPlanSchema.parse(
      await request<unknown>('post', '/geometry/publish/plan', geometryPublishRequestSchema.parse(value)),
    )
  },
  async publish(value: z.input<typeof geometryPublishRequestSchema> & { planHash: string }) {
    const requestValue = geometryPublishRequestSchema.extend({ planHash: geometryHashSchema }).parse(value)
    return geometryPublishResponseSchema.parse(await request<unknown>('post', '/geometry/publish', requestValue))
  },
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
    null_filter: {},
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
