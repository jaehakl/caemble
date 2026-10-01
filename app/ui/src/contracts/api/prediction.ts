import { z } from 'zod'

const id = z.string().uuid()
const revision = z.number().int().nonnegative()
const definition = z.object({ fingerprint: z.string().min(1) }).passthrough()
const asset = {
  id,
  name: z.string(),
  experiment_id: z.number().int().positive(),
  state: z.enum(['active', 'deleting', 'deleted']),
  current_revision: revision,
  storage_id: id.nullable(),
  launcher_id: id.nullable(),
  delete_id: id.nullable(),
}
export const predictionDatasetSchema = z.object({
  ...asset,
  source_kind: z.enum(['server', 'local']),
  revisions: z.array(
    z
      .object({
        revision,
        fingerprint: z.string(),
        payload_available: z.boolean(),
        sample_count: z.number().int().nonnegative().optional(),
      })
      .passthrough(),
  ),
})
export const predictionModelSchema = z.object({
  ...asset,
  direction: z.enum(['forward', 'inverse']),
  algorithm: z.literal('knn'),
  revisions: z.array(
    z.object({
      revision,
      operation_id: id,
      state: z.string(),
      dataset_id: id,
      dataset_revision: revision,
      dataset_fingerprint: z.string(),
      definition,
      source_contracts: z.record(z.string(), z.unknown()),
      artifact: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
  reserved_revision: revision.optional(),
  operation_id: id.optional(),
})
export const predictionGrantSchema = z
  .object({
    grant_id: id,
    manifest_url: z.string().url(),
    refresh_url: z.string().url().optional(),
    object_url_template: z.string(),
    token: z.string().min(1),
    expires_at: z.union([z.string(), z.number()]),
    dataset_id: id,
    revision,
    fingerprint: z.string(),
    manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .passthrough()
export type PredictionDatasetRecord = z.infer<typeof predictionDatasetSchema>
export type PredictionModelRecord = z.infer<typeof predictionModelSchema>
export type PredictionDatasetGrant = z.infer<typeof predictionGrantSchema>
export type PredictionDatasetSelection = Readonly<{
  request_id: string
  name: string
  experiment_id: number
  source_hash: string
  vars_schema: Readonly<Record<string, unknown>>
  record_ids: readonly number[]
  calculation_ids: readonly number[]
  rules: readonly unknown[]
  result_contracts: Readonly<Record<string, unknown>>
  expected_revision?: number
}>
export type PredictionModelReservation = Readonly<{
  request_id: string
  model_id?: string
  expected_revision?: number
  name: string
  direction: 'forward' | 'inverse'
  dataset_id: string
  dataset_revision: number
  definition: Readonly<Record<string, unknown>>
  storage_id: string
  launcher_id: string
}>
