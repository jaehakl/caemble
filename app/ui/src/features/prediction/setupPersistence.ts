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
})
const setupSchema = z.object({
  version: z.literal(3),
  owner: z.string(),
  experimentId: z.number().int().positive(),
  setup: z.object({
    executionId: z.literal('remote-knn'),
    datasetId: z.string().uuid().optional(),
    recordIds: z.array(z.number().int().positive()),
    calculationIds: z.array(z.number().int().positive()),
    algorithm: algorithmSchema,
    models: z.object({ forward: savedPredictionReferenceSchema.optional() }).optional(),
    routes: z.object({ forward: predictionExecutionRouteSchema.optional() }).optional(),
  }),
})
const legacySchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  owner: z.string(),
  experimentId: z.number().int().positive(),
  setup: z.object({
    executionId: z.enum(['browser-knn', 'remote-knn']),
    datasetId: z.string().uuid().optional(),
    calculationIds: z.array(z.number().int().positive()),
    algorithm: algorithmSchema,
    models: z
      .object({
        forward: savedPredictionReferenceSchema
          .extend({
            storageId: predictionLocationIdSchema.optional(),
            launcherId: z.string().uuid().optional(),
          })
          .optional(),
      })
      .optional(),
    routes: z.object({ forward: predictionExecutionRouteSchema.optional() }).optional(),
  }),
})

export function restorePredictionSetup(owner: string, experimentId: number): PredictionSetup | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(`caemble.prediction.setup:${owner}:${experimentId}`) ?? 'null')
    const legacy = legacySchema.safeParse(raw)
    const forward = legacy.success ? legacy.data.setup.models?.forward : undefined
    const value = setupSchema.parse(
      legacy.success
        ? {
            ...legacy.data,
            version: 3,
            setup: {
              ...legacy.data.setup,
              executionId: 'remote-knn',
              recordIds: Object.keys(forward?.contract.records ?? {}).map(Number),
              routes:
                legacy.data.version === 1 && forward?.storageId && forward.launcherId
                  ? { forward: { storageId: forward.storageId, launcherId: forward.launcherId } }
                  : legacy.data.setup.routes,
            },
          }
        : raw,
    )
    if (value.owner !== owner || value.experimentId !== experimentId) return null
    if (
      value.setup.models?.forward?.contract.experimentId !== undefined &&
      value.setup.models.forward.contract.experimentId !== experimentId
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
    const value = setupSchema.parse({ version: 3, owner, experimentId, setup })
    localStorage.setItem(`caemble.prediction.setup:${owner}:${experimentId}`, JSON.stringify(value))
  } catch {
    /* Storage may be unavailable; persistence never blocks inference. */
  }
}
