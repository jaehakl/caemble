import { z } from 'zod'
import {
  predictionAlgorithmSchema,
  predictionQualityValidationSchema,
  type PredictionQualityValidation,
} from '../contracts/prediction'
export {
  predictionKnnAlgorithmSchema,
  predictionMlpAlgorithmSchema,
  predictionAlgorithmSchema,
  defaultKnnAlgorithm,
  defaultMlpAlgorithm,
  defaultPredictionQualityValidation,
  predictionQualityValidationSchema,
  type PredictionAlgorithm,
  type PredictionQualityValidation,
} from '../contracts/prediction'

/** Stable serialization shared by saved definitions and UI selection fingerprints. */
export function predictionFingerprint(parts: readonly unknown[]) {
  return JSON.stringify(parts, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const record = value as Readonly<Record<string, unknown>>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    )
  })
}

const sourceContractsSchema = z.object({
  experimentId: z.number().int().positive(),
  varsSchema: z.record(z.string(), z.unknown()),
  records: z.array(z.object({ id: z.number().int().positive(), contract_hash: z.string() })),
})

export function savedContractFromSource(source: unknown) {
  const parsed = sourceContractsSchema.parse(source)
  return {
    experimentId: parsed.experimentId,
    varsSchemaFingerprint: predictionFingerprint([parsed.varsSchema]),
    records: Object.fromEntries(parsed.records.map((record) => [record.id, record.contract_hash])),
  }
}

export type PredictionDefinitionInput = Readonly<{
  snapshotFingerprint: string
  algorithm: z.input<typeof predictionAlgorithmSchema>
  descriptor: Readonly<{
    kind: string
    implementationVersion: string
    preprocessingVersion: string
    directions: readonly string[]
  }>
  sourceContracts: unknown
  recordIds: readonly number[]
  qualityValidation?: PredictionQualityValidation
}>

/** Freeze training meaning once; transport, storage routing and resources are separate. */
export async function buildPredictionModelDefinition(input: PredictionDefinitionInput) {
  const algorithm = predictionAlgorithmSchema.parse(input.algorithm)
  if (input.descriptor.kind !== algorithm.kind || !input.descriptor.directions.includes('forward'))
    throw new Error('The selected Predictor does not support this Forward algorithm.')
  const requiredRecordIds = [...new Set(z.array(z.number().int().positive()).min(1).parse(input.recordIds))].sort(
    (a, b) => a - b,
  )
  const frozen = savedContractFromSource(input.sourceContracts)
  if (requiredRecordIds.some((id) => !frozen.records[id]))
    throw new Error('Selected BoxGrid Records do not belong to the Dataset revision.')
  const meaning = {
    snapshotFingerprint: z.string().min(1).parse(input.snapshotFingerprint),
    algorithm,
    implementationId: 'remote-predictor' as const,
    implementationVersion: input.descriptor.implementationVersion,
    preprocessingVersion: input.descriptor.preprocessingVersion,
    contract: { ...frozen, records: Object.fromEntries(requiredRecordIds.map((id) => [id, frozen.records[id]])) },
    direction: 'forward' as const,
    requiredRecordIds,
    ...(input.qualityValidation
      ? { qualityValidation: predictionQualityValidationSchema.parse(input.qualityValidation) }
      : {}),
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(predictionFingerprint([meaning])))
  const fingerprint = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  return { ...meaning, fingerprint }
}
