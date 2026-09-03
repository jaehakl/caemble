import { z } from 'zod'
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-types'

const finiteNumber = z.number().finite()
const nonnegativeInteger = z.number().int().nonnegative()
const requestId = z.string().min(1)
const progressStage = z.enum([
  'Measurement 조회',
  'Calculation Data 조회',
  '데이터셋 구성',
  '통계 계산',
  '상관 분석',
  'PCA·군집',
])

const columnSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    kind: z.enum(['feature', 'target']),
    source: z.enum(['calculation-data', 'measurement-material', 'measurement-vars']),
    count: nonnegativeInteger,
    distinctCount: nonnegativeInteger,
    missingRatio: finiteNumber,
    eligible: z.boolean(),
    exclusionReason: z.string().optional(),
    unit: z.string().optional(),
    quantityKind: z.string().optional(),
    statistic: z.string().optional(),
    min: finiteNumber.optional(),
    max: finiteNumber.optional(),
    mean: finiteNumber.optional(),
    std: finiteNumber.optional(),
    p05: finiteNumber.optional(),
    p25: finiteNumber.optional(),
    p50: finiteNumber.optional(),
    p75: finiteNumber.optional(),
    p95: finiteNumber.optional(),
    histogram: z
      .array(z.object({ min: finiteNumber, max: finiteNumber, count: nonnegativeInteger }).passthrough())
      .optional(),
  })
  .passthrough()

const profileSchema = z
  .object({
    fingerprint: z.string(),
    experimentId: z.number().int().positive(),
    rowCount: nonnegativeInteger,
    measurementCount: nonnegativeInteger,
    calculationDataCount: nonnegativeInteger,
    calculationCount: nonnegativeInteger,
    columns: z.array(columnSchema),
    warnings: z.array(z.string()),
  })
  .passthrough()

const relationshipPairSchema = z
  .object({
    inputKey: z.string(),
    targetKey: z.string(),
    pearson: finiteNumber,
    spearman: finiteNumber,
    count: nonnegativeInteger,
  })
  .passthrough()

const relationshipsSchema = z.object({ fingerprint: z.string(), pairs: z.array(relationshipPairSchema) }).passthrough()

const relationshipPlotSchema = z
  .object({
    fingerprint: z.string(),
    inputKey: z.string(),
    targetKey: z.string(),
    pearson: finiteNumber.nullable(),
    spearman: finiteNumber.nullable(),
    count: nonnegativeInteger,
    points: z.array(
      z.object({ measurementId: z.number().int().positive(), x: finiteNumber, y: finiteNumber }).passthrough(),
    ),
  })
  .passthrough()

const miningSchema = z
  .object({
    fingerprint: z.string(),
    featureKeys: z.array(z.string()),
    explainedVariance: z.array(finiteNumber),
    loadings: z.array(z.object({ key: z.string(), pc1: finiteNumber, pc2: finiteNumber }).passthrough()),
    points: z.array(
      z
        .object({
          measurementId: z.number().int().positive(),
          inputFingerprint: z.string(),
          pc1: finiteNumber,
          pc2: finiteNumber,
          cluster: nonnegativeInteger,
          anomalyScore: finiteNumber,
          outlier: z.boolean(),
        })
        .passthrough(),
    ),
    clusterCount: nonnegativeInteger,
    silhouette: finiteNumber,
    outlierFraction: finiteNumber,
  })
  .passthrough()

const tablePageSchema = z
  .object({
    fingerprint: z.string(),
    offset: nonnegativeInteger,
    total: nonnegativeInteger,
    columns: z.array(z.string()),
    rows: z.array(
      z
        .object({
          measurementId: z.number().int().positive(),
          inputFingerprint: z.string(),
          values: z.array(finiteNumber.nullable()),
        })
        .passthrough(),
    ),
  })
  .passthrough()

const analysisWorkerRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('load-context'), requestId, experimentId: z.number().int().positive() }).passthrough(),
  z.object({ type: z.literal('check-stale'), requestId }).passthrough(),
  z.object({ type: z.literal('relationships'), requestId }).passthrough(),
  z
    .object({ type: z.literal('relationship-plot'), requestId, inputKey: z.string(), targetKey: z.string() })
    .passthrough(),
  z
    .object({
      type: z.literal('mine'),
      requestId,
      featureKeys: z.array(z.string()),
      outlierFraction: finiteNumber.min(0).max(1),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('table-page'),
      requestId,
      columnKeys: z.array(z.string()),
      offset: nonnegativeInteger,
      limit: z.number().int().positive(),
    })
    .passthrough(),
  z.object({ type: z.literal('export-csv'), requestId, columnKeys: z.array(z.string()) }).passthrough(),
])

const analysisWorkerResponseSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('progress'),
      requestId,
      stage: progressStage,
      completed: nonnegativeInteger.optional(),
      total: nonnegativeInteger.optional(),
    })
    .passthrough(),
  z.object({ type: z.literal('profile'), requestId, profile: profileSchema }).passthrough(),
  z.object({ type: z.literal('stale'), requestId, stale: z.boolean() }).passthrough(),
  z.object({ type: z.literal('relationships'), requestId, result: relationshipsSchema }).passthrough(),
  z.object({ type: z.literal('relationship-plot'), requestId, result: relationshipPlotSchema }).passthrough(),
  z.object({ type: z.literal('mining'), requestId, result: miningSchema }).passthrough(),
  z.object({ type: z.literal('table-page'), requestId, page: tablePageSchema }).passthrough(),
  z.object({ type: z.literal('csv'), requestId, blob: z.instanceof(Blob), filename: z.string().min(1) }).passthrough(),
  z.object({ type: z.literal('error'), requestId, message: z.string() }).passthrough(),
])

export function parseAnalysisWorkerRequest(value: unknown): AnalysisWorkerRequest {
  return analysisWorkerRequestSchema.parse(value) as AnalysisWorkerRequest
}

export function parseAnalysisWorkerResponse(value: unknown): AnalysisWorkerResponse {
  return analysisWorkerResponseSchema.parse(value) as AnalysisWorkerResponse
}
