import { z } from 'zod'
import { caeJobSchema } from './cae'
import { predictionQualityReportSchema } from './prediction'

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
const optimizationErrorSchema = z
  .object({ message: z.string(), stage: z.string().optional(), code: z.string().optional() })
  .passthrough()
export const optimizationQualityRequirementSchema = z.object({
  recordId: z.number().int().positive(),
  component: z.string().min(1),
  rmseMaximum: z.number().finite().nonnegative(),
})
export const optimizationQualityAssessmentSchema = z.object({
  status: z.enum(['passed', 'failed', 'unassessed']),
  reasonCode: z.string(),
  items: z.array(
    optimizationQualityRequirementSchema.extend({
      status: z.enum(['passed', 'failed', 'unassessed']),
      reasonCode: z.string(),
      rmse: z.number().finite().nonnegative().nullable(),
      unit: z.string().nullable(),
    }),
  ),
})
export type OptimizationQualityAssessment = z.infer<typeof optimizationQualityAssessmentSchema>
const qualityFields = {
  quality_requirements: z.array(optimizationQualityRequirementSchema).min(1).nullable().optional(),
  quality_report: predictionQualityReportSchema.nullable().optional(),
  quality_assessment: optimizationQualityAssessmentSchema.optional(),
}
export const optimizationModelSourceSchema = z
  .object({
    model_id: z.string(),
    model_revision: z.number().int().positive(),
    checksum: z.string().optional(),
    version_name: z.string().nullable().optional(),
    ...qualityFields,
  })
  .passthrough()
const bestTrialSchema = z.object({
  id: z.string(),
  ordinal: z.number().int(),
  variables: optimizationVarsSchema,
  result: optimizationResultSchema,
  measurement_id: z.number().int().nullable(),
  evaluation_id: z.string().optional(),
  source: z.record(z.string(), z.unknown()).optional(),
})
export const optimizationModelUpdateSchema = z.object({
  initial_model: optimizationModelSourceSchema,
  active_model: optimizationModelSourceSchema,
  round_model: optimizationModelSourceSchema.nullable().optional(),
  pending_model: optimizationModelSourceSchema.nullable(),
  updates: z.array(
    z.object({
      request_id: z.string(),
      request_ids: z.array(z.string()).optional(),
      operation_id: z.string(),
      model_id: z.string(),
      revision: z.number().int().positive(),
      version_name: z.string(),
      state: z.string(),
      error: z.union([z.string(), optimizationErrorSchema]).nullable().optional(),
      created_at: z.string().optional(),
      adopted_round: z.number().int().nonnegative().nullable().optional(),
      quality_assessment: optimizationQualityAssessmentSchema.optional(),
    }),
  ),
  waiting: z.boolean(),
})
export const optimizationHybridSchema = z
  .object({
    model_id: z.string(),
    model_revision: z.number().int().nonnegative(),
    replica_id: z.string(),
    launcher_id: z.string(),
    max_solver_runs: z.number().int().positive(),
    ...qualityFields,
  })
  .passthrough()
export type OptimizationHybrid = z.infer<typeof optimizationHybridSchema>
export const optimizationSummarySchema = z.object({
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
  best_predicted_trial: bestTrialSchema.nullable().optional(),
  best_verified_trial: bestTrialSchema.nullable().optional(),
  solver_budget: z
    .object({
      limit: z.number().int().nonnegative(),
      used: z.number().int().nonnegative(),
      reserved: z.number().int().nonnegative(),
      remaining: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
  termination_reason: z.string().nullable().optional(),
  model_update: optimizationModelUpdateSchema.optional(),
})
export const optimizationDetailSchema = optimizationSummarySchema.extend({
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
      hybrid: optimizationHybridSchema.partial({ max_solver_runs: true }).nullable().optional(),
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
    hybrid: optimizationHybridSchema.nullable().optional(),
  }),
  optimizer_state: z.record(z.string(), z.unknown()),
})
const optimizationStageSchema = z
  .object({
    id: z.string(),
    stage: z.string(),
    generation: z.number().int(),
    batch_id: z.string().nullable(),
    job_id: z.string().nullable(),
    state: z.string(),
    result: z.unknown().nullable(),
    error: optimizationErrorSchema.nullable(),
    job: caeJobSchema.nullable(),
  })
  .passthrough()
export const optimizationEvaluationSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['prediction', 'solver']),
    definition_hash: z.string(),
    source: z.record(z.string(), z.unknown()),
    state: z.string(),
    next_stage: z.enum(['predict', 'build', 'solve', 'calculate', 'complete']),
    measurement_id: z.number().int().nullable(),
    result: optimizationResultSchema.nullable(),
    error: optimizationErrorSchema.nullable(),
    manual_retry_requested: z.boolean(),
    retry_count: z.number().int().nonnegative(),
    stages: z.array(optimizationStageSchema),
  })
  .passthrough()
export type OptimizationEvaluation = z.infer<typeof optimizationEvaluationSchema>
export const optimizationTrialSchema = z.object({
  id: z.string(),
  optimization_id: z.string(),
  ordinal: z.number().int(),
  round_index: z.number().int(),
  variables: optimizationVarsSchema,
  fingerprint: z.string(),
  state: z.string(),
  next_stage: z.enum(['predict', 'build', 'solve', 'calculate', 'complete']),
  measurement_id: z.number().int().nullable(),
  result: optimizationResultSchema.nullable(),
  error: optimizationErrorSchema.nullable(),
  manual_retry_requested: z.boolean(),
  retry_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  stages: z.array(optimizationStageSchema),
  evaluations: z.array(optimizationEvaluationSchema).optional(),
})
export const optimizationListSchema = z.object({ items: z.array(optimizationSummarySchema), total: z.number().int() })
export const optimizationTrialListSchema = z.object({
  items: z.array(optimizationTrialSchema),
  total: z.number().int(),
})
export type Optimization = z.infer<typeof optimizationDetailSchema>
export type OptimizationSummary = z.infer<typeof optimizationSummarySchema>
export type OptimizationTrial = z.infer<typeof optimizationTrialSchema>
export type OptimizationCreateRequest = Readonly<{
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
  hybrid?: Pick<
    OptimizationHybrid,
    'model_id' | 'model_revision' | 'replica_id' | 'launcher_id' | 'max_solver_runs' | 'quality_requirements'
  >
}>
