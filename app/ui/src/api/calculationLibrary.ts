import { z } from 'zod'
import { browserClient, type RequestContext } from './http'

const referenceSchema = z.object({
  kind: z.enum(['catalog', 'saved', 'source']),
  coordinate: z.string().nullable(),
  name: z.string().nullable(),
  source_id: z.number().int().positive().nullable().optional(),
  calculation_id: z.number().int().positive().nullable(),
})
const solverSchema = z.object({ name: z.string(), version: z.string() })
const itemSchema = z.object({
  source_hash: z.string().optional(),
  reference: referenceSchema,
  name: z.string(),
  description: z.string().nullable(),
  experiment_name: z.string(),
  experiment_coordinate: z.string(),
  sources: z.array(z.enum(['catalog', 'mine', 'demo'])),
  solvers: z.array(solverSchema),
  concepts: z.array(z.string()),
})
const pageSchema = z.object({
  items: z.array(itemSchema),
  total: z.number().int().nonnegative(),
  facets: z.object({
    solvers: z.array(solverSchema),
    concepts: z.array(z.string()),
  }),
})
const detailSchema = itemSchema.extend({
  source_revision: z.number().int().positive().nullable().optional(),
  source_id: z.number().int().positive().nullable(),
  source_code: z.string(),
  inputs_verified: z.boolean(),
  inputs: z.array(
    z.object({
      name: z.string(),
      dtype: z.string(),
      tensor_order: z.number().int(),
      quantity_kind: z.string().nullable(),
      data_schema: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
  output_layout: z
    .object({
      dtype: z.string(),
      shape: z.array(z.number().int().nonnegative()),
      axes: z.array(z.object({ name: z.string(), ticks: z.array(z.number()), unit: z.string().nullish() })),
    })
    .nullable(),
  preflight_measurement_id: z.number().int().nullable(),
  contract_status: z.enum(['ready', 'needs_preflight', 'unknown']),
})
export type CalculationLibraryReference = z.infer<typeof referenceSchema>
export type CalculationLibraryDetail = z.infer<typeof detailSchema>
export type CalculationLibraryQuery = Readonly<{
  source: 'all' | 'catalog' | 'mine' | 'demo'
  query: string
  solver_names: readonly string[]
  solver_name: string
  solver_version: string
  concept: string
  unclassified: boolean
  offset: number
  limit: number
}>
export const calculationLibraryApi = {
  updateMetadata: (id: number, body: { name: string; description: string | null; base_source_revision: number }) =>
    browserClient.request('patch', `/calculation/${id}/metadata`, body, {
      validate: (value) => z.object({ id: z.number(), revision: z.number(), source_revision: z.number() }).parse(value),
    }),
  list: (query: CalculationLibraryQuery, context: RequestContext) =>
    browserClient.request('post', '/calculation/library/list', query, {
      ...context,
      validate: (body) => pageSchema.parse(body),
    }),
  detail: (reference: CalculationLibraryReference, context: RequestContext) =>
    browserClient.request('post', '/calculation/library/detail', reference, {
      ...context,
      resolveObjects: true,
      validate: (body) => detailSchema.parse(body),
    }),
}
