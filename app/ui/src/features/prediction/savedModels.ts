import type { PredictionContext } from './predictionContextData'
import type { VarsSchemaEntry } from '@/lib/cad/model'
import type { PredictionSavedContract, SavedPredictionModel } from './execution'
import { predictionFingerprint } from './data'
import { z } from 'zod'

export const savedPredictionReferenceSchema = z.object({
  modelId: z.string().uuid(),
  modelRevision: z.number().int().positive(),
  datasetId: z.string().uuid(),
  datasetRevision: z.number().int().positive(),
  direction: z.enum(['forward', 'inverse']),
  fingerprint: z.string().min(1),
  storageId: z.string().uuid(),
  launcherId: z.string().uuid(),
  manifestChecksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  contract: z.object({
    experimentId: z.number().int().positive(),
    varsSchemaFingerprint: z.string(),
    records: z.record(z.string(), z.string()),
    calculations: z.record(z.string(), z.string()),
  }),
})

const sourceContractsSchema = z.object({
  experimentId: z.number().int().positive(),
  varsSchema: z.record(z.string(), z.unknown()),
  records: z.array(z.object({ id: z.number(), contract_hash: z.string() })),
  calculations: z.array(
    z.object({
      id: z.number(),
      source_hash: z.string().nullable(),
      experiment_record_ids: z.array(z.number()),
      output_layout: z
        .object({
          dtype: z.string(),
          shape: z.array(z.number()),
          axes: z.array(
            z.object({
              name: z.string(),
              unit: z
                .string()
                .nullish()
                .transform((unit) => unit || undefined),
            }),
          ),
        })
        .nullable(),
    }),
  ),
})

export function savedContractFromSource(source: unknown): PredictionSavedContract {
  const parsed = sourceContractsSchema.parse(source)
  return {
    experimentId: parsed.experimentId,
    varsSchemaFingerprint: predictionFingerprint([parsed.varsSchema]),
    records: Object.fromEntries(parsed.records.map((record) => [record.id, record.contract_hash])),
    calculations: Object.fromEntries(
      parsed.calculations.map((calculation) => [
        calculation.id,
        predictionFingerprint([calculation.source_hash, calculation.output_layout, calculation.experiment_record_ids]),
      ]),
    ),
  }
}

export function savedPredictionContract(
  context: PredictionContext,
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>,
): PredictionSavedContract {
  return savedContractFromSource({
    experimentId: context.experimentId,
    varsSchema,
    records: context.experimentRecords,
    calculations: context.calculations,
  })
}

export function assertSavedPredictionCompatible(
  reference: SavedPredictionModel,
  context: PredictionContext,
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>,
  recordIds: readonly number[],
  calculationIds: readonly number[],
) {
  const expected = reference.contract
  const current = savedPredictionContract(context, varsSchema)
  if (
    !expected ||
    expected.experimentId !== current.experimentId ||
    expected.varsSchemaFingerprint !== current.varsSchemaFingerprint
  )
    throw new Error('저장 모델의 Experiment 또는 Vars 계약이 다릅니다. 모델을 갱신하세요.')
  if (
    reference.direction === 'inverse' &&
    predictionFingerprint([Object.keys(expected.calculations).sort()]) !==
      predictionFingerprint([calculationIds.map(String).sort()])
  )
    throw new Error('Inverse 저장 모델의 Calculation 선택과 현재 선택이 다릅니다.')
  for (const id of recordIds) {
    if (!expected.records[id] || expected.records[id] !== current.records[id])
      throw new Error(`Record #${id}의 계약이 저장 모델과 다릅니다. 모델을 갱신하세요.`)
  }
  for (const id of calculationIds) {
    if (!expected.calculations[id] || expected.calculations[id] !== current.calculations[id])
      throw new Error(`Calculation #${id}의 계약이 저장 모델과 다릅니다. 모델을 갱신하세요.`)
  }
}
