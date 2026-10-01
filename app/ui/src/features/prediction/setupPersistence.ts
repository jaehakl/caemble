import { z } from 'zod'
import { predictionLocationIdSchema } from '@/contracts/api/prediction'
import { savedPredictionReferenceSchema } from './savedModels'
import type { PredictionSetup } from './usePredictionModels'

export const predictionExecutionRouteSchema = z.object({
  replicaId: predictionLocationIdSchema.optional(),
  storageId: predictionLocationIdSchema,
  launcherId: z.string().uuid(),
})
const algorithmSchema = z.object({
  kind: z.literal('knn'),
  kMode: z.enum(['auto', 'manual']),
  manualK: z.number().int().positive(),
  weighting: z.enum(['uniform', 'distance']),
  calculationWeights: z.record(z.string(), z.number().finite().nonnegative()),
})
const setupSchema = z.object({
  version: z.literal(2),
  owner: z.string(),
  experimentId: z.number().int().positive(),
  setup: z.object({
    executionId: z.enum(['browser-knn', 'remote-knn']),
    datasetId: z.string().uuid().optional(),
    calculationIds: z.array(z.number().int().positive()),
    algorithm: algorithmSchema,
    models: z
      .object({
        forward: savedPredictionReferenceSchema.optional(),
        inverse: savedPredictionReferenceSchema.optional(),
      })
      .optional(),
    routes: z
      .object({
        forward: predictionExecutionRouteSchema.optional(),
        inverse: predictionExecutionRouteSchema.optional(),
      })
      .optional(),
  }),
})
const legacyModelSchema = savedPredictionReferenceSchema.extend({
  storageId: predictionLocationIdSchema,
  launcherId: z.string().uuid(),
})
const legacySchema = setupSchema.extend({
  version: z.literal(1),
  setup: setupSchema.shape.setup.omit({ routes: true }).extend({
    launcherId: z.string().uuid().optional(),
    models: z.object({ forward: legacyModelSchema.optional(), inverse: legacyModelSchema.optional() }).optional(),
  }),
})

export function restorePredictionSetup(owner: string, experimentId: number): PredictionSetup | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(`caemble.prediction.setup:${owner}:${experimentId}`) ?? 'null')
    const legacy = legacySchema.safeParse(raw)
    const value = legacy.success
      ? setupSchema.parse({
          ...legacy.data,
          version: 2,
          setup: {
            ...legacy.data.setup,
            routes: Object.fromEntries(
              Object.entries(legacy.data.setup.models ?? {}).map(([direction, model]) => [
                direction,
                { storageId: model.storageId, launcherId: model.launcherId },
              ]),
            ),
          },
        })
      : setupSchema.parse(raw)
    if (value.owner !== owner || value.experimentId !== experimentId) return null
    if (
      Object.entries(value.setup.models ?? {}).some(
        ([direction, model]) => model.contract.experimentId !== experimentId || model.direction !== direction,
      )
    )
      return null
    if (legacy.success) persistPredictionSetup(owner, experimentId, value.setup)
    return value.setup
  } catch {
    return null
  }
}

export function persistPredictionSetup(owner: string, experimentId: number, setup: PredictionSetup) {
  try {
    const value = setupSchema.parse({ version: 2, owner, experimentId, setup })
    localStorage.setItem(`caemble.prediction.setup:${owner}:${experimentId}`, JSON.stringify(value))
  } catch {
    /* Storage may be unavailable; persistence never blocks inference. */
  }
}
