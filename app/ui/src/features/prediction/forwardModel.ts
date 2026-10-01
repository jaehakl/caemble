import type { Vars } from '@/lib/cad/model'
import type { BoxGridData } from '@/contracts/boxGrid'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { predictedRecordedData } from './data'
import { emitPredictionQueryDiagnostics } from './diagnostics'
import { assertSavedPredictionCompatible } from './savedModels'
import type { PredictionContext } from './predictionContextData'
import type { PreparedPredictionModel } from './execution'
import type { PredictionRuntimeController } from './predictionRuntime'
import type { PredictionSetup, PredictionVarsSchema } from './usePredictionModels'

export async function buildForwardModel({
  context,
  varsSchema,
  runtime,
  transaction,
  setup,
}: Readonly<{
  context: PredictionContext
  varsSchema: PredictionVarsSchema
  runtime: PredictionRuntimeController
  transaction: number
  setup: PredictionSetup
}>): Promise<PreparedPredictionModel> {
  if (!setup.recordIds.length) throw new Error('예측할 BoxGrid를 하나 이상 선택하세요.')
  const reference = setup.models?.forward
  if (!reference) throw new Error('저장 모델을 선택하거나 만드세요.')
  assertSavedPredictionCompatible(reference, context, varsSchema, setup.recordIds)
  return runtime.loadModel(reference, transaction, setup.routes?.forward)
}

export async function predictForwardRecorded({
  model,
  runtime,
  transaction,
  vars,
  candidateBoxGrids,
  names,
  onActivity,
}: Readonly<{
  model: PreparedPredictionModel
  runtime: PredictionRuntimeController
  transaction: number
  vars: Readonly<Vars>
  candidateBoxGrids: Readonly<Record<string, BoxGridData>>
  names: readonly string[]
  onActivity?: RuntimeActivityCallback
}>) {
  const rules = model.rules
    .filter((rule) => names.includes(rule.label))
    .map((rule) => {
      const grid = candidateBoxGrids[rule.label]
      return Object.freeze({
        ...rule,
        result: Object.freeze({
          ...rule.result,
          axes: rule.result.axes?.map((axis, index) =>
            index < 3
              ? Object.freeze({
                  ...axis,
                  ticks: undefined,
                  unit: grid?.lengthUnit,
                  quantityKind: axis.quantityKind ?? 'Length',
                })
              : axis,
          ),
        }),
      })
    })
  for (const name of names) {
    if (!rules.some((rule) => rule.label === name)) throw new Error(`${name}은 선택한 모델의 출력이 아닙니다.`)
    if (!candidateBoxGrids[name]) throw new Error(`${name} Candidate BoxGrid가 없습니다.`)
  }
  const result = await runtime.predict(model, { direction: 'forward', vars }, transaction)
  emitPredictionQueryDiagnostics(result, model.fingerprint, runtime.emittedDiagnosticFingerprints, onActivity)
  const recorded = predictedRecordedData(
    result.output.filter((sample) => names.includes(sample.layout.key)),
    rules,
    undefined,
    candidateBoxGrids,
  )
  return { recorded, result, rules }
}
