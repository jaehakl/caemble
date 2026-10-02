import type { PredictionContext } from './predictionContextData'
import type { VarsSchemaEntry } from '@caemble/execution/cad/model'
import type { PredictionSavedContract, SavedPredictionModel } from './execution'
import { savedContractFromSource } from '@caemble/execution/prediction/modelDefinition'
export { savedContractFromSource } from '@caemble/execution/prediction/modelDefinition'
import { z } from 'zod'

export const savedPredictionReferenceSchema = z.object({
  modelId: z.string().uuid(),
  modelRevision: z.number().int().positive(),
  datasetId: z.string().uuid(),
  datasetRevision: z.number().int().positive(),
  direction: z.literal('forward'),
  fingerprint: z.string().min(1),
  manifestChecksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  contract: z.object({
    experimentId: z.number().int().positive(),
    varsSchemaFingerprint: z.string(),
    records: z.record(z.string(), z.string()),
  }),
})

export function savedPredictionContract(
  context: PredictionContext,
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>,
): PredictionSavedContract {
  return savedContractFromSource({
    experimentId: context.experimentId,
    varsSchema,
    records: context.experimentRecords,
  })
}

export function assertSavedPredictionCompatible(
  reference: SavedPredictionModel,
  context: PredictionContext,
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>,
  recordIds: readonly number[],
) {
  const expected = reference.contract
  const current = savedPredictionContract(context, varsSchema)
  if (
    !expected ||
    expected.experimentId !== current.experimentId ||
    expected.varsSchemaFingerprint !== current.varsSchemaFingerprint
  )
    throw new Error('저장 모델의 Experiment 또는 Vars 계약이 다릅니다. 모델을 갱신하세요.')
  for (const id of recordIds) {
    if (!expected.records[id] || expected.records[id] !== current.records[id])
      throw new Error(`Record #${id}의 계약이 저장 모델과 다릅니다. 모델을 갱신하세요.`)
  }
}
