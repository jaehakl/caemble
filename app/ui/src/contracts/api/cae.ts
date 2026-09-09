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
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough()

export const caeBatchSchema = z
  .object({
    id: z.string(),
    experiment_id: z.number().int(),
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
    jobs: z.array(caeJobSchema).default([]),
    jobs_total: z.number().int().optional(),
  })
  .passthrough()

export const caeBatchListSchema = z.object({
  items: z.array(caeBatchSchema),
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
export type CaeJob = z.infer<typeof caeJobSchema>
export type CaeEvent = z.infer<typeof caeEventSchema>
export type CaeBatchRequest = Readonly<{
  request_id: string
  experiment_id: number
  experiment_source_hash: string
  mode: 'generate' | 'candidate' | 'measurement'
  catalog_revision: string
  builder_version: '2'
  storage_version?: 1
  items: readonly Readonly<{ index: number; input_hash: string; byte_length: number; measurement_id?: number }>[]
}>
