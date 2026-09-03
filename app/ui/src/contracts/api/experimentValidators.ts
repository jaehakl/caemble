import { z } from 'zod'
import type {
  AvailableExperimentRecord,
  AvailableExperimentsResponse,
  ExperimentUsageResponse,
  ExperimentRecordedDataRecord,
  SaveExperimentResponse,
  SavedExperimentRecord,
} from './experiment'
import { databaseIdSchema, parseGetListResponse } from './validators'

export const experimentSourceBundleSchema = z
  .object({
    files: z.record(z.string(), z.string()),
  })
  .passthrough()

const experimentDerivedCountsSchema = z
  .object({
    measurements: z.number().int().nonnegative(),
    recordedData: z.number().int().nonnegative(),
    calculations: z.number().int().nonnegative(),
  })
  .passthrough()

export const savedExperimentRecordSchema = z
  .object({
    id: databaseIdSchema,
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    user_id: z.string().nullable().optional(),
    namespace: z.string(),
    repository_slug: z.string(),
    experiment_key: z.string(),
    version_major: z.number().int().nonnegative(),
    version_minor: z.number().int().nonnegative(),
    version_patch: z.number().int().nonnegative(),
    name: z.string(),
    description: z.string().nullable().optional(),
    source_bundle: experimentSourceBundleSchema,
    source_hash: z.string(),
    repository: z.string().optional(),
    key: z.string().optional(),
    version: z.string().optional(),
    coordinate: z.string().optional(),
    bundleHash: z.string().optional(),
    sourceLocked: z.boolean().optional(),
    derivedCounts: experimentDerivedCountsSchema.optional(),
    isDemo: z.boolean().optional(),
    demoOrder: z.number().int().nonnegative().nullable().optional(),
    demoDefault: z.boolean().optional(),
  })
  .passthrough()

const saveExperimentResponseSchema = z
  .object({
    id: databaseIdSchema,
    action: z.enum(['create', 'overwrite', 'new_version']),
    namespace: z.string(),
    repository: z.string(),
    key: z.string(),
    version: z.string(),
    coordinate: z.string(),
    bundleHash: z.string(),
    sourceLocked: z.boolean(),
    derivedCounts: experimentDerivedCountsSchema,
  })
  .passthrough()

const experimentUsageResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          experimentId: databaseIdSchema,
          sourceLocked: z.boolean(),
          derivedCounts: experimentDerivedCountsSchema,
        })
        .passthrough(),
    ),
  })
  .passthrough()

export const availableExperimentRecordSchema = savedExperimentRecordSchema.extend({
  predictionReady: z.boolean(),
  predictionCounts: z
    .object({
      recordedMeasurements: z.number().int().nonnegative(),
      readyCalculations: z.number().int().nonnegative(),
      calculationData: z.number().int().nonnegative(),
    })
    .passthrough(),
  demoOrder: z.number().int().nonnegative().nullable(),
  demoDefault: z.boolean(),
})

export const experimentRecordedDataRecordSchema = z
  .object({
    id: databaseIdSchema,
    experiment_id: databaseIdSchema,
    name: z.string(),
    quantity_kind: z.string().nullable(),
    tensor_order: z.number().int().nonnegative(),
    dtype: z.string(),
    contract_hash: z.string(),
  })
  .passthrough()

const availableExperimentsResponseSchema = z
  .object({
    mine: z.array(availableExperimentRecordSchema),
    demos: z.array(availableExperimentRecordSchema),
  })
  .passthrough()

const demoCandidatesResponseSchema = z
  .object({
    items: z.array(availableExperimentRecordSchema),
  })
  .passthrough()

export function parseExperimentListResponse(value: unknown) {
  return parseGetListResponse<SavedExperimentRecord>(value, savedExperimentRecordSchema)
}

export function parseExperimentRecordListResponse(value: unknown) {
  return parseGetListResponse<ExperimentRecordedDataRecord>(value, experimentRecordedDataRecordSchema)
}

export function parseAvailableExperimentsResponse(value: unknown): AvailableExperimentsResponse {
  return availableExperimentsResponseSchema.parse(value) as AvailableExperimentsResponse
}

export function parseDemoCandidatesResponse(value: unknown): Readonly<{ items: AvailableExperimentRecord[] }> {
  return demoCandidatesResponseSchema.parse(value) as Readonly<{ items: AvailableExperimentRecord[] }>
}

export function parseSaveExperimentResponse(value: unknown): SaveExperimentResponse {
  return saveExperimentResponseSchema.parse(value) as SaveExperimentResponse
}

export function parseExperimentUsageResponse(value: unknown): ExperimentUsageResponse {
  return experimentUsageResponseSchema.parse(value) as ExperimentUsageResponse
}
