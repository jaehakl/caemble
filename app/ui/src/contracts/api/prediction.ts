import { z } from 'zod'
import { resourceRequestSchema } from './execution.ts'
import { recordedResultContractsSchema } from '../resultValidators'
export {
  defaultPredictionQualityValidation,
  predictionQualityValidationSchema,
  type PredictionQualityValidation,
} from '@caemble/execution/contracts/prediction'

const id = z.string().uuid()
// Migration 24 stored PostgreSQL UUID values without RFC version/variant bits.
// Preserve those opaque location IDs while still requiring canonical GUID syntax.
export const predictionLocationIdSchema = z.guid()
const revision = z.number().int().nonnegative()
const definition = z.object({ fingerprint: z.string().min(1) }).passthrough()
const measurementIds = z.array(z.number().int().positive())
const excludedMeasurements = z.array(z.object({ measurementId: z.number().int().positive(), reason: z.string() }))
const predictionQualityReportV1Schema = z.object({
  version: z.literal(1),
  evaluation: z.literal('pre-save-holdout'),
  status: z.enum(['complete', 'partial']),
  dataset: z.object({ datasetId: id, revision: z.number().int().positive(), fingerprint: z.string() }),
  definitionFingerprint: z.string(),
  split: z.object({
    version: z.literal(1),
    seed: z.literal(0),
    holdoutFraction: z.literal(0.2),
    fingerprint: z.string(),
    trainingMeasurementIds: measurementIds,
    validationMeasurementIds: measurementIds,
    trainingGroupCount: z.number().int().nonnegative(),
    validationGroupCount: z.number().int().nonnegative(),
    excluded: excludedMeasurements,
  }),
  records: z.array(
    z.object({
      recordId: z.number().int().positive(),
      key: z.string(),
      unit: z.string(),
      status: z.enum(['evaluated', 'unavailable']),
      trainingMeasurementIds: measurementIds,
      evaluatedMeasurementIds: measurementIds,
      evaluatedGroupCount: z.number().int().nonnegative(),
      excluded: excludedMeasurements,
      components: z.array(
        z.object({
          component: z.string(),
          mae: z.number().finite().nonnegative(),
          rmse: z.number().finite().nonnegative(),
          maxAbsoluteError: z.number().finite().nonnegative(),
        }),
      ),
    }),
  ),
})
export const predictionQualityReportSchema = z.discriminatedUnion('version', [
  predictionQualityReportV1Schema,
  predictionQualityReportV1Schema.extend({
    version: z.literal(2),
    split: predictionQualityReportV1Schema.shape.split.extend({
      version: z.literal(2),
      lineageFingerprint: z.string(),
    }),
    lineage: z.object({
      rootSnapshot: predictionQualityReportV1Schema.shape.dataset,
      validationGroups: z.array(z.object({ designFingerprint: z.string(), measurementIds })),
      fingerprint: z.string(),
    }),
  }),
])
export type PredictionQualityReport = z.infer<typeof predictionQualityReportSchema>
export const predictionExecutionMetricsSchema = z
  .object({
    version: z.literal(1),
    scope: z.literal('process-tree'),
    elapsedSeconds: z.number().finite().nonnegative(),
    peakRssBytes: z.number().int().nonnegative().nullable(),
    rssStatus: z.enum(['measured', 'unavailable']),
    peakVramBytes: z.record(z.string(), z.number().int().nonnegative().nullable()),
    gpuStatus: z.enum(['not-requested', 'measured', 'unavailable']),
    rssSamples: z.number().int().nonnegative(),
    gpuSamples: z.number().int().nonnegative(),
    rssIntervalSeconds: z.number().finite().nonnegative(),
    gpuIntervalSeconds: z.number().finite().nonnegative(),
    sampledCpuSeconds: z.number().finite().nonnegative(),
    samplingShutdownSeconds: z.number().finite().nonnegative(),
    warnings: z.array(z.string()),
    phases: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  })
  .passthrough()
export type PredictionExecutionMetrics = z.infer<typeof predictionExecutionMetricsSchema>
const predictionArtifactSchema = z
  .object({
    quality_report: predictionQualityReportSchema.optional(),
    training_metrics: predictionExecutionMetricsSchema.optional(),
    execution_metrics: predictionExecutionMetricsSchema.optional(),
    validation: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown())
export const predictionAlgorithmSchema = z.object({
  kind: z.string().min(1),
  implementationVersion: z.string().min(1),
  preprocessingVersion: z.string().min(1),
  directions: z.array(z.enum(['forward', 'inverse'])),
  representations: z.array(z.string().min(1)),
  supportsCheckpoints: z.boolean().optional(),
  supportsNativeBatch: z.boolean().optional(),
  supportedUpdateModes: z.array(z.enum(['rebuild', 'warm_start', 'incremental'])).optional(),
  resources: z.object({ training: resourceRequestSchema, inference: resourceRequestSchema }),
  cpuFallbackResources: z.object({ training: resourceRequestSchema, inference: resourceRequestSchema }).optional(),
})
export type PredictionAlgorithmDescriptor = z.infer<typeof predictionAlgorithmSchema>
export const predictionTrainingSchema = z.object({
  pinId: id,
  sourceKind: z.enum(['local', 'api']),
  resources: resourceRequestSchema,
  jobId: id.nullable().optional(),
  cleanupPending: z.boolean(),
  grant: z.object({ operation_id: id, token: z.string().min(1), manifest_url: z.string().url() }),
  progress: z.record(z.string(), z.unknown()).optional(),
})
export const predictionReplicaSchema = z.object({
  id: predictionLocationIdSchema,
  storage_id: predictionLocationIdSchema,
  state: z.enum(['unverified', 'present', 'missing', 'corrupt', 'deleting', 'deleted']),
  manifest_sha256: z.string().nullable(),
  artifact: z.record(z.string(), z.unknown()).nullable(),
  checked_at: z.string().nullable(),
  verified_at: z.string().nullable(),
  delete_id: id.nullable(),
  deletion: z
    .object({
      operation_id: id,
      reason: z.enum(['in_use', 'transfer', 'offline', 'interrupted', 'awaiting_confirmation']),
      message: z.string(),
    })
    .optional(),
})
export const predictionStorageSchema = z.object({
  storage_id: predictionLocationIdSchema,
  name: z.string(),
  kind: z.enum(['predictor_local', 'object_backup', 'api_dataset']),
  configured: z.boolean().optional(),
  checked_at: z.string().nullable(),
  accesses: z.array(z.object({ launcher_id: id, connected: z.boolean(), checked_at: z.string().nullable() })),
})
const asset = {
  id,
  name: z.string(),
  experiment_id: z.number().int().positive(),
  state: z.enum(['active', 'deleting', 'deleted']),
  current_revision: revision,
  delete_id: id.nullable(),
}
export const predictionDatasetSourceSchema = z
  .object({
    experimentId: z.number().int().positive(),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    varsSchema: z.record(
      z.string(),
      z.object({
        shape: z.array(z.number().int().positive()),
        min: z.number().finite(),
        max: z.number().finite(),
      }),
    ),
    records: z.array(z.object({ id: z.number().int().positive(), name: z.string() }).passthrough()),
    rules: z.array(z.record(z.string(), z.unknown())),
    resultContracts: recordedResultContractsSchema,
  })
  .passthrough()

export const predictionDatasetSchema = z.object({
  ...asset,
  source_kind: z.enum(['server', 'local']),
  revisions: z.array(
    z
      .object({
        revision,
        fingerprint: z.string(),
        payload_available: z.boolean(),
        api_payload_available: z.boolean().optional(),
        sample_count: z.number().int().nonnegative().optional(),
        source_contracts: predictionDatasetSourceSchema.optional().catch(undefined),
        source_hash: z.string().optional(),
        created_at: z.string().optional(),
        replicas: z.array(predictionReplicaSchema),
      })
      .passthrough(),
  ),
})
export const predictionModelSchema = z.object({
  ...asset,
  direction: z.enum(['forward', 'inverse']),
  support_status: z.enum(['supported', 'retired', 'unsupported']).optional(),
  algorithm: z.string().min(1),
  revisions: z.array(
    z.object({
      revision,
      operation_id: id,
      state: z.string(),
      version_name: z.string().nullable().optional(),
      origin_optimization_id: z.string().nullable().optional(),
      training_update: z.record(z.string(), z.unknown()).nullable().optional(),
      support_status: z.enum(['supported', 'retired', 'unsupported']).optional(),
      dataset_id: id,
      dataset_revision: revision,
      dataset_fingerprint: z.string(),
      definition,
      source_contracts: z.record(z.string(), z.unknown()),
      artifact: predictionArtifactSchema.nullable(),
      replicas: z.array(predictionReplicaSchema),
    }),
  ),
  reserved_revision: revision.optional(),
  operation_id: id.optional(),
  training: predictionTrainingSchema.optional(),
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
export type PredictionReplica = z.infer<typeof predictionReplicaSchema>
export type PredictionStorage = z.infer<typeof predictionStorageSchema>

export const predictionOperationGrantSchema = z.object({
  operation_id: id,
  token: z.string().min(1),
  manifest_url: z.string().url(),
  prepare_url: z.string(),
  complete_url: z.string(),
  register_url: z.string().url(),
  refresh_url: z.string().url(),
  expires_at: z.union([z.string(), z.number()]),
})
export const predictionOperationSchema = z.object({
  id,
  experiment_id: z.number().int().positive().optional(),
  request_id: id,
  kind: z.string(),
  state: z.string(),
  stage: z.string(),
  asset_kind: z.enum(['model', 'dataset']),
  asset_id: id,
  revision: revision.nullable(),
  source_replica_id: predictionLocationIdSchema.nullable(),
  target_storage_id: predictionLocationIdSchema.nullable(),
  target_launcher_id: id.nullable(),
  include_dataset: z.boolean(),
  details: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
  grant: predictionOperationGrantSchema.optional(),
  dataset_grant: predictionGrantSchema.optional(),
  training: predictionTrainingSchema.optional(),
})
export type PredictionOperation = z.infer<typeof predictionOperationSchema>
export type PredictionOperationGrant = z.infer<typeof predictionOperationGrantSchema>
export type PredictionOperationRequest = Readonly<{
  request_id: string
  kind: 'backup' | 'restore' | 'delete_replica' | 'delete_asset' | 'verify'
  asset_kind: 'model' | 'dataset'
  asset_id: string
  revision?: number
  source_replica_id?: string
  source_launcher_id?: string
  target_storage_id?: string
  target_launcher_id?: string
  include_dataset?: boolean
  dataset_source_replica_id?: string
  dataset_source_launcher_id?: string
  replica_id?: string
}>
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
  direction: 'forward'
  dataset_id: string
  dataset_revision: number
  dataset_source?: 'auto' | 'api'
  definition: Readonly<Record<string, unknown>>
  storage_id: string
  launcher_id: string
}>
