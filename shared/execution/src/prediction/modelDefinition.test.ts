// @vitest-environment node
import { expect, it } from 'vitest'
import {
  buildPredictionModelDefinition,
  defaultKnnAlgorithm,
  defaultMlpAlgorithm,
  defaultPredictionQualityValidation,
  predictionAlgorithmSchema,
  predictionQualityValidationSchema,
} from './modelDefinition'

const sourceContracts = {
  experimentId: 3,
  varsSchema: { width: { shape: [], min: 0, max: 10 } },
  records: [{ id: 5, contract_hash: 'record-contract' }],
}
const input = {
  snapshotFingerprint: 'snapshot',
  algorithm: defaultKnnAlgorithm,
  descriptor: {
    kind: 'knn',
    directions: ['forward'],
    implementationVersion: 'knn-v1',
    preprocessingVersion: 'box-relative-v2',
  },
  sourceContracts,
  recordIds: [5],
}

it('preserves the pre-MLP kNN definition fingerprint exactly', async () => {
  const definition = await buildPredictionModelDefinition(input)
  expect(definition.fingerprint).toBe('sha256:71e25a71d0c20f16795a52f2e41864eeac07033f67f817ca9e840317fd85d1a9')
  expect(definition.algorithm).toEqual(defaultKnnAlgorithm)
  expect(definition).not.toHaveProperty('qualityValidation')
  expect(await buildPredictionModelDefinition({ ...input, recordIds: [5, 5] })).toEqual(definition)
})

it('uses quality v2 for new models and retains distinct v1 definition identity for stored models', async () => {
  expect(defaultPredictionQualityValidation.version).toBe(2)
  const legacy = { ...defaultPredictionQualityValidation, version: 1 as const }
  expect(predictionQualityValidationSchema.parse(legacy)).toEqual(legacy)
  const previous = await buildPredictionModelDefinition({ ...input, qualityValidation: legacy })
  const current = await buildPredictionModelDefinition({
    ...input,
    qualityValidation: defaultPredictionQualityValidation,
  })
  expect(previous.fingerprint).not.toBe(current.fingerprint)
  expect(predictionQualityValidationSchema.safeParse({ ...legacy, version: 3 }).success).toBe(false)
})

it('freezes every MLP setting and the same held-out quality policy in model identity', async () => {
  const mlp = {
    ...input,
    algorithm: defaultMlpAlgorithm,
    descriptor: { ...input.descriptor, kind: 'mlp', implementationVersion: 'mlp-v1' },
  }
  const definition = await buildPredictionModelDefinition(mlp)
  expect(definition.algorithm).toEqual(defaultMlpAlgorithm)
  expect(await buildPredictionModelDefinition({ ...mlp, algorithm: { kind: 'mlp' } })).toEqual(definition)
  for (const algorithm of [
    { ...defaultMlpAlgorithm, hiddenLayers: [16, 32] },
    { ...defaultMlpAlgorithm, epochs: 600 },
    { ...defaultMlpAlgorithm, batchSize: 16 },
    { ...defaultMlpAlgorithm, learningRate: 0.002 },
    { ...defaultMlpAlgorithm, seed: 1 },
  ])
    expect((await buildPredictionModelDefinition({ ...mlp, algorithm })).fingerprint).not.toBe(definition.fingerprint)
  const evaluated = await buildPredictionModelDefinition({
    ...mlp,
    qualityValidation: defaultPredictionQualityValidation,
  })
  expect(evaluated.qualityValidation).toEqual(defaultPredictionQualityValidation)
  expect(evaluated.fingerprint).not.toBe(definition.fingerprint)
})

it.each([
  { hiddenLayers: [] },
  { hiddenLayers: [0] },
  { hiddenLayers: [257] },
  { hiddenLayers: [1, 1, 1, 1, 1] },
  { epochs: 0 },
  { epochs: 10_001 },
  { batchSize: 4097 },
  { learningRate: 0 },
  { learningRate: 1.01 },
  { seed: -1 },
  { seed: 2_147_483_648 },
  { device: 'cuda' },
])('rejects unsupported MLP bounds: %j', (invalid) => {
  expect(predictionAlgorithmSchema.safeParse({ ...defaultMlpAlgorithm, ...invalid }).success).toBe(false)
})

it('rejects another algorithm or a Record outside the frozen Dataset', async () => {
  await expect(buildPredictionModelDefinition({ ...input, algorithm: defaultMlpAlgorithm })).rejects.toThrow(
    'algorithm',
  )
  await expect(buildPredictionModelDefinition({ ...input, recordIds: [6] })).rejects.toThrow('Records')
})
