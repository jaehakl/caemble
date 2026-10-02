import type { CalculationDataOutput } from '@/api'
import type { RecordedResultContracts } from '@caemble/execution/contracts/results'
import type { BoxGridData } from '@caemble/execution/contracts/boxGrid'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { runCalculation } from '@/lib/calculation'
import {
  varsFingerprint,
  type RecordedData,
  type RecordedDataRule,
  type Vars,
  type VarsSchemaEntry,
} from '@caemble/execution/cad/model'
import { buildCalculationRecordedData } from '../calculation/calculationRecordedData'
import { predictionFingerprint } from './data'
import type {
  PredictionAlgorithm,
  PredictionExecutionResult,
  PredictionExecutionRoute,
  PredictionProvenance,
  SavedPredictionModel,
} from './execution'
import { calculationOutputContract } from './metrics'
import type { PredictionContext, SavedPredictionCalculation } from './predictionContextData'
import { buildForwardModel, predictForwardRecorded } from './forwardModel'
import type { PredictionRuntimeController } from './predictionRuntime'

export type { PredictionContext, SavedPredictionCalculation } from './predictionContextData'
export type PredictionVarsSchema = Readonly<Record<string, VarsSchemaEntry>>

export type PredictionSetup = Readonly<{
  executionId: 'remote-predictor'
  recordIds: readonly number[]
  calculationIds: readonly number[]
  algorithm: PredictionAlgorithm
  models?: Readonly<{ forward?: SavedPredictionModel }>
  routes?: Readonly<{ forward?: PredictionExecutionRoute }>
  datasetId?: string
}>

export const defaultPredictionSetup: PredictionSetup = Object.freeze({
  executionId: 'remote-predictor',
  recordIds: Object.freeze([]),
  calculationIds: Object.freeze([]),
  algorithm: Object.freeze({ kind: 'knn', kMode: 'auto', manualK: 1, weighting: 'distance' }),
})

/** Only the immutable model and selected outputs change prediction meaning. */
export function predictionSetupFingerprint(setup: PredictionSetup) {
  return predictionFingerprint([setup.models?.forward, [...setup.recordIds].sort((a, b) => a - b)])
}

export type PredictionSource = Readonly<{
  kind: 'prediction'
  candidate: Readonly<{ fingerprint: string; sourceHash: string; vars: Readonly<Vars> }>
  model: PredictionProvenance
  modelFingerprint: string
  recordIds: readonly number[]
}>

/** This ephemeral result is never a persisted Measurement or a training observation. */
export type PredictionRecordedPreview = Readonly<{
  recorded: RecordedData
  rules: readonly RecordedDataRule[]
  resultContracts: RecordedResultContracts
  modelFingerprint: string
  source: PredictionSource
  result: PredictionExecutionResult
}>

export type PredictionCalculations = Readonly<{
  values: Readonly<Record<number, CalculationDataOutput>>
  errors: Readonly<Record<number, string>>
  source: PredictionSource
}>

/** Shared by the workbench and future evaluation consumers; no React/UI state. */
export async function predictCandidate({
  runtime,
  transaction,
  setup,
  context,
  varsSchema,
  vars,
  sourceHash,
  candidateBoxGrids,
  resultContracts,
  onActivity,
}: Readonly<{
  runtime: PredictionRuntimeController
  transaction: number
  setup: PredictionSetup
  context: PredictionContext
  varsSchema: PredictionVarsSchema
  vars: Readonly<Vars>
  sourceHash: string
  candidateBoxGrids: Readonly<Record<string, BoxGridData>>
  resultContracts: RecordedResultContracts
  onActivity?: RuntimeActivityCallback
}>): Promise<PredictionRecordedPreview> {
  const capturedVars = structuredClone(vars)
  const capturedBoxGrids = structuredClone(candidateBoxGrids)
  const pending: unknown[] = [capturedVars, capturedBoxGrids]
  while (pending.length) {
    const value = pending.pop()
    if (value !== null && typeof value === 'object') {
      pending.push(...Object.values(value))
      Object.freeze(value)
    }
  }
  const model = await buildForwardModel({ context, varsSchema, runtime, transaction, setup })
  const names = setup.recordIds.map((id) => context.experimentRecords.find((record) => record.id === id)!.name)
  const { recorded, result, rules } = await predictForwardRecorded({
    model,
    runtime,
    transaction,
    vars: capturedVars,
    candidateBoxGrids: capturedBoxGrids,
    names,
    onActivity,
  })
  const provenance = result.provenance
  if (!provenance) throw new Error('원격 예측 결과에 모델 출처가 없습니다.')
  return Object.freeze({
    recorded,
    rules,
    resultContracts: Object.freeze(
      Object.fromEntries(Object.entries(resultContracts).filter(([name]) => names.includes(name))),
    ),
    modelFingerprint: model.fingerprint,
    result,
    source: Object.freeze({
      kind: 'prediction',
      candidate: Object.freeze({ fingerprint: varsFingerprint(capturedVars), sourceHash, vars: capturedVars }),
      model: Object.freeze({ ...provenance }),
      modelFingerprint: model.fingerprint,
      recordIds: Object.freeze([...setup.recordIds]),
    }),
  })
}

/** Optional postprocessing reuses the normal Calculation runtime and the frozen prediction. */
export async function calculatePrediction(
  preview: PredictionRecordedPreview,
  calculations: readonly SavedPredictionCalculation[],
  context: PredictionContext,
  signal: AbortSignal,
  onActivity?: RuntimeActivityCallback,
): Promise<PredictionCalculations> {
  const values: Record<number, CalculationDataOutput> = {}
  const errors: Record<number, string> = {}
  for (const calculation of calculations) {
    signal.throwIfAborted()
    try {
      if (calculation.contract_status !== 'ready' || !calculation.output_layout)
        throw new Error('Calculation preflight 계약이 준비되지 않았습니다.')
      const names = calculation.experiment_record_ids.map((id) => {
        const record = context.experimentRecords.find((item) => item.id === id)
        if (!record) throw new Error(`ExperimentRecord #${id} 계약을 찾을 수 없습니다.`)
        if (!preview.recorded[record.name]) throw new Error(`${record.name} BoxGrid를 선택하고 예측하세요.`)
        return record.name
      })
      const rules = preview.rules.filter((rule) => names.includes(rule.label))
      const prepared = buildCalculationRecordedData(
        rules,
        Object.fromEntries(names.map((name) => [name, preview.recorded[name]])),
      )
      if (!prepared.input) throw new Error(prepared.error ?? '예측 BoxGrid를 Calculation 입력으로 만들 수 없습니다.')
      const output = await runCalculation({
        input: prepared.input,
        sourceCode: calculation.source_code,
        signal,
        onLog: (entry) =>
          onActivity?.({
            source: 'calculation',
            level: 'info',
            phase: 'prediction',
            message: `[Prediction · Calculation #${calculation.id}] ${entry.message}`,
            runId: entry.requestId,
          }),
      })
      signal.throwIfAborted()
      if (
        predictionFingerprint([calculationOutputContract(output)]) !==
        predictionFingerprint([calculationOutputContract(calculation.output_layout)])
      )
        throw new Error('Calculation 결과가 저장된 preflight 계약과 다릅니다.')
      values[calculation.id] = output
    } catch (cause) {
      signal.throwIfAborted()
      errors[calculation.id] = cause instanceof Error ? cause.message : String(cause)
    }
  }
  return Object.freeze({ values: Object.freeze(values), errors: Object.freeze(errors), source: preview.source })
}
