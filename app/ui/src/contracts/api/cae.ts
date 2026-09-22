import { z } from 'zod'

export const caeJobSchema = z
  .object({
    id: z.string(),
    index: z.number().int(),
    attempt_count: z.number().int(),
    state: z.string(),
    measurement_id: z.number().int().nullable(),
    progress: z.record(z.string(), z.unknown()).nullable(),
    last_error: z.string().nullable(),
    cleanup_pending: z.boolean().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough()

export const caeMeasurementExecutionSchema = z.object({
  measurement_id: z.number().int(),
  experiment_id: z.number().int(),
  recorded_at: z.string().nullable(),
  batch_id: z.string().nullable(),
  job: caeJobSchema.nullable(),
})
export type CaeMeasurementExecution = z.infer<typeof caeMeasurementExecutionSchema>

export const caeBatchSummarySchema = z.object({
  id: z.string(),
  experiment_id: z.number().int().nullable(),
  preflight: z.boolean().optional(),
  request_id: z.string().optional(),
  mode: z.enum(['generate', 'candidate', 'measurement']),
  total: z.number().int(),
  uploaded_count: z.number().int().default(0),
  created_count: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  state: z.enum(['uploading', 'queued', 'running', 'completed', 'cancelled']),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
  last_event_id: z.number().int(),
  read_event_id: z.number().int(),
  jobs_total: z.number().int().optional(),
})

export const caeBatchSchema = caeBatchSummarySchema
  .extend({
    jobs: z.array(caeJobSchema),
  })
  .passthrough()

export const caeBatchListSchema = z.object({
  items: z.array(caeBatchSummarySchema),
  total: z.number().int(),
  cursor: z.number().int(),
})

export const caeEventSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  batch_id: z.string(),
  job_id: z.string().nullable().optional(),
  attempt_count: z.number().int().nullable().optional(),
  measurement_id: z.number().int().nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
  created_at: z.string(),
})

export type CaeBatch = z.infer<typeof caeBatchSchema>
export type CaeBatchSummary = z.infer<typeof caeBatchSummarySchema>
export type CaeJob = z.infer<typeof caeJobSchema>
export type CaeEvent = z.infer<typeof caeEventSchema>
export type CaeBatchRequest = Readonly<{
  request_id: string
  experiment_id: number | null
  preflight?: boolean
  source_bundle?: Readonly<{ files: Readonly<Record<string, string>> }>
  experiment_source_hash: string
  mode: 'generate' | 'candidate' | 'measurement'
  catalog_revision: string
  builder_version: '2'
  storage_version?: 1
  items: readonly Readonly<{ index: number; input_hash: string; byte_length: number; measurement_id?: number }>[]
}>
