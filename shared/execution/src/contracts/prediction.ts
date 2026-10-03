import { z } from 'zod'

export const predictionKnnAlgorithmSchema = z.object({
  kind: z.literal('knn'),
  kMode: z.enum(['auto', 'manual']),
  manualK: z.number().int().positive(),
  weighting: z.enum(['uniform', 'distance']),
})
export const predictionMlpAlgorithmSchema = z.strictObject({
  kind: z.literal('mlp'),
  hiddenLayers: z.array(z.number().int().min(1).max(256)).min(1).max(4).default([32, 32]),
  epochs: z.number().int().min(1).max(10_000).default(500),
  batchSize: z.number().int().min(1).max(4096).default(32),
  learningRate: z.number().finite().positive().max(1).default(0.001),
  seed: z.number().int().min(0).max(2_147_483_647).default(0),
})
export const predictionAlgorithmSchema = z.discriminatedUnion('kind', [
  predictionKnnAlgorithmSchema,
  predictionMlpAlgorithmSchema,
])
export type PredictionAlgorithm = Readonly<z.infer<typeof predictionAlgorithmSchema>>
export const defaultKnnAlgorithm = Object.freeze(
  predictionKnnAlgorithmSchema.parse({
    kind: 'knn',
    kMode: 'auto',
    manualK: 1,
    weighting: 'distance',
  }),
)
export const defaultMlpAlgorithm = Object.freeze(
  predictionMlpAlgorithmSchema.parse({
    kind: 'mlp',
    hiddenLayers: [32, 32],
    epochs: 500,
    batchSize: 32,
    learningRate: 0.001,
    seed: 0,
  }),
)

export const predictionQualityValidationSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  split: z.literal('design-point'),
  holdoutFraction: z.literal(0.2),
  seed: z.literal(0),
  minimumGroups: z.literal(5),
})
export type PredictionQualityValidation = z.infer<typeof predictionQualityValidationSchema>
export const defaultPredictionQualityValidation: PredictionQualityValidation = Object.freeze({
  version: 2,
  split: 'design-point',
  holdoutFraction: 0.2,
  seed: 0,
  minimumGroups: 5,
})
