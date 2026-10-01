import { z } from 'zod'
import { savedPredictionReferenceSchema } from './savedModels'
import type { PredictionSetup } from './usePredictionModels'

const setupSchema = z.object({
  version: z.literal(1),
  owner: z.string(),
  experimentId: z.number().int().positive(),
  setup: z.object({
    executionId: z.enum(['browser-knn', 'remote-knn']),
    launcherId: z.string().uuid().optional(),
    datasetId: z.string().uuid().optional(),
    calculationIds: z.array(z.number().int().positive()),
    algorithm: z.object({
      kind: z.literal('knn'),
      kMode: z.enum(['auto', 'manual']),
      manualK: z.number().int().positive(),
      weighting: z.enum(['uniform', 'distance']),
      calculationWeights: z.record(z.string(), z.number().finite().nonnegative()),
    }),
    models: z
      .object({
        forward: savedPredictionReferenceSchema.optional(),
        inverse: savedPredictionReferenceSchema.optional(),
      })
      .optional(),
  }),
})

export function restorePredictionSetup(owner: string, experimentId: number): PredictionSetup | null {
  try {
    const value = setupSchema.parse(
      JSON.parse(localStorage.getItem(`caemble.prediction.setup:${owner}:${experimentId}`) ?? 'null'),
    )
    if (value.owner !== owner || value.experimentId !== experimentId) return null
    if (
      Object.values(value.setup.models ?? {}).some(
        (model) => model.launcherId !== value.setup.launcherId || model.contract.experimentId !== experimentId,
      )
    )
      return null
    return value.setup
  } catch {
    return null
  }
}

export function persistPredictionSetup(owner: string, experimentId: number, setup: PredictionSetup) {
  try {
    const value = setupSchema.parse({ version: 1, owner, experimentId, setup })
    localStorage.setItem(`caemble.prediction.setup:${owner}:${experimentId}`, JSON.stringify(value))
  } catch {
    /* Storage may be unavailable; persistence never blocks inference. */
  }
}
