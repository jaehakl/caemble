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
    ticks: z.array(z.union([z.number().finite(), z.string()])).readonly().optional(),
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
      data: z.unknown().nullable().optional(),
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
      return this.rowSchema.parse(await request<unknown>('get', '/auth/me'))
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

export type DbTableName = keyof typeof dbTables
export type DbTableRecord<TTable extends DbTableName> = z.infer<(typeof dbTables)[TTable]['rowSchema']>
