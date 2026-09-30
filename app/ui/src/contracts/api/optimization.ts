import { z } from 'zod'
import { caeJobSchema } from './cae'

export type OptimizationTensor = number | readonly OptimizationTensor[]
const tensorSchema: z.ZodType<OptimizationTensor> = z.lazy(() => z.union([z.number().finite(), z.array(tensorSchema)]))
export const optimizationVarsSchema = z.record(z.string(), tensorSchema)
export const optimizationVariableSchema = z.record(
  z.string(),
  z.object({
    shape: z.array(z.number().int().nonnegative()),
    min: z.number().finite(),
    max: z.number().finite(),
  }),
)
export const optimizationAxisSchema = z.object({
  name: z.string(),
  indices: z.array(z.number().int().nonnegative()),
  min: z.number().finite(),
  max: z.number().finite(),
  fixed: z.boolean(),
})
export type OptimizationAxis = z.infer<typeof optimizationAxisSchema>
export const optimizationResultSchema = z
  .object({
    objective: z.number().finite(),
    feasible: z.boolean(),
    violation: z.number().finite(),
    constraints: z.array(
      z.object({
        key: z.string(),
        value: z.number().finite(),
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        satisfied: z.boolean(),
      }),
    ),
  })
  .passthrough()
const studyErrorSchema = z
  .object({ message: z.string(), stage: z.string().optional(), code: z.string().optional() })
  .passthrough()
const bestTrialSchema = z.object({
  id: z.string(),
  ordinal: z.number().int(),
  variables: optimizationVarsSchema,
  result: optimizationResultSchema,
  measurement_id: z.number().int().nullable(),
})
export const studySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  experiment_id: z.number().int(),
  state: z.string(),
  pause_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
  max_trials: z.number().int(),
  max_parallel: z.number().int(),
  trial_count: z.number().int(),
  retry_count: z.number().int().nonnegative(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  active: z.number().int(),
  executions_active: z.number().int(),
  cleanup_pending: z.boolean(),
  manual_retry_pending: z.boolean(),
  best_trial: bestTrialSchema.nullable(),
})
export const studyDetailSchema = studySummarySchema.extend({
  definition: z
    .object({
      source_bundle: z.object({ files: z.record(z.string(), z.string()) }),
      source_hash: z.string(),
      catalog_revision: z.string(),
      vars_schema: optimizationVariableSchema,
      calculations: z.array(
        z.object({
          key: z.string(),
          calculation_id: z.number().int(),
          source: z.string(),
          source_hash: z.string(),
          source_revision: z.number().int(),
        }),
      ),
      hash: z.string(),
    })
    .passthrough(),
  settings: z.object({
    initial_vars: optimizationVarsSchema,
    axes: z.array(optimizationAxisSchema),
    objective: z.object({ direction: z.enum(['minimize', 'maximize']) }).passthrough(),
    constraints: z.array(z.object({ key: z.string(), minimum: z.number().optional(), maximum: z.number().optional() })),
    max_trials: z.number().int(),
    max_parallel: z.number().int(),
    initial_step: z.number(),
    min_step: z.number(),
  }),
  optimizer_state: z.record(z.string(), z.unknown()),
})
export const studyTrialSchema = z.object({
  id: z.string(),
  study_id: z.string(),
  ordinal: z.number().int(),
  round_index: z.number().int(),
  variables: optimizationVarsSchema,
  fingerprint: z.string(),
  state: z.string(),
  next_stage: z.enum(['build', 'solve', 'calculate', 'complete']),
  measurement_id: z.number().int().nullable(),
  result: optimizationResultSchema.nullable(),
  error: studyErrorSchema.nullable(),
  manual_retry_requested: z.boolean(),
  retry_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  stages: z.array(
    z
      .object({
        id: z.string(),
        stage: z.string(),
        generation: z.number().int(),
        batch_id: z.string().nullable(),
        job_id: z.string().nullable(),
        state: z.string(),
        result: z.unknown().nullable(),
        error: studyErrorSchema.nullable(),
        job: caeJobSchema.nullable(),
      })
      .passthrough(),
  ),
})
export const studyListSchema = z.object({ items: z.array(studySummarySchema), total: z.number().int() })
export const studyTrialListSchema = z.object({ items: z.array(studyTrialSchema), total: z.number().int() })
export type OptimizationStudy = z.infer<typeof studyDetailSchema>
export type OptimizationStudySummary = z.infer<typeof studySummarySchema>
export type OptimizationTrial = z.infer<typeof studyTrialSchema>
export type StudyCreateRequest = Readonly<{
  request_id: string
  experiment_id: number
  source_hash: string
  name?: string
  vars_schema: Readonly<Record<string, Readonly<{ shape: readonly number[]; min: number; max: number }>>>
  initial_vars: Record<string, OptimizationTensor>
  axes?: Readonly<{ name: string; indices?: number[]; min?: number; max?: number; fixed?: boolean }>[]
  objective: { calculation_id: number; direction?: 'minimize' | 'maximize' }
  constraints?: { calculation_id: number; minimum?: number; maximum?: number }[]
  max_trials?: number
  max_parallel?: number
}>
