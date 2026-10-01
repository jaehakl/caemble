import { buildForwardModel, predictForwardRecorded } from './forwardModel'
import { useCallback } from 'react'
import type { CalculationDataOutput } from '@/api'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { runCalculation } from '@/lib/calculation'
import type { BoxGridData } from '@/contracts/boxGrid'
import type { RecordedResultContracts } from '@/contracts/results'
import type { Vars, VarsSchemaEntry, RecordedData, RecordedDataRule } from '@/lib/cad/model'
import type { RecordedDataSchemaTree } from '@/lib/cad/simulation'
import { buildCalculationRecordedData } from '../calculation/calculationRecordedData'
import { predictionFingerprint } from './data'
import { emitPredictionQueryDiagnostics } from './diagnostics'
import { calculationOutputContract } from './metrics'
import type {
  PredictionAlgorithm,
  PredictionExecutionResult,
  PredictionModelProfile,
  SavedPredictionModel,
} from './execution'
import { assertSavedPredictionCompatible } from './savedModels'
import { loadTrainingSnapshot } from './trainingSnapshot'
import type { PredictionContext, SavedPredictionCalculation } from './predictionContextData'
import {
  type PredictionForwardModelBundle,
  type PredictionForwardRecordProfile,
  type PredictionModelCache,
  type PredictionRuntimeController,
} from './usePredictionController'

export type { PredictionContext, SavedPredictionCalculation, SavedPredictionMeasurement } from './predictionContextData'

export type PredictionVarsSchema = Readonly<Record<string, VarsSchemaEntry>>

/** Recorded predictions are ready before downstream Calculations run. */
export type PredictionRecordedPreview = Readonly<{
  recorded: RecordedData
  rules: readonly RecordedDataRule[]
  resultContracts: RecordedResultContracts
  modelFingerprint: string
}>

export type PredictionSetup = Readonly<{
  calculationIds: readonly number[]
  algorithm: PredictionAlgorithm
  executionId: string
  launcherId?: string
  datasetId?: string
  models?: Readonly<Partial<Record<'forward' | 'inverse', SavedPredictionModel>>>
}>

export const defaultPredictionSetup: PredictionSetup = Object.freeze({
  calculationIds: Object.freeze([]),
  algorithm: Object.freeze({
    kind: 'knn',
    calculationWeights: Object.freeze({}),
    kMode: 'auto',
    manualK: 1,
    weighting: 'distance',
  }),
  executionId: 'browser-knn',
})

async function rowsInBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>) {
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(run))
  }
}

export function usePredictionModels({
  clearModelCaches,
  context,
  checkFreshness,
  experimentId,
  onActivity,
  onForwardRecordProfilesChange,
  onProfile,
  recordedData,
  candidateBoxGrids,
  candidateReady = true,
  resultContracts = {},
  runtime,
  selectedCalculations,
  setup,
  varsSchema,
}: Readonly<{
  clearModelCaches: () => void
  context: PredictionContext | null
  checkFreshness?: () => Promise<string>
  experimentId: number | null
  onActivity?: RuntimeActivityCallback
  onForwardRecordProfilesChange: (profiles: readonly PredictionForwardRecordProfile[]) => void
  onProfile: (profile: PredictionModelProfile, fingerprint: string) => void
  recordedData: RecordedDataSchemaTree
  candidateBoxGrids?: Readonly<Record<string, BoxGridData>>
  candidateReady?: boolean
  resultContracts?: RecordedResultContracts
  runtime: PredictionRuntimeController
  selectedCalculations: readonly SavedPredictionCalculation[]
  setup: PredictionSetup
  varsSchema: PredictionVarsSchema | null
}>) {
  const ensureForwardModel = useCallback(
    async (transaction: number): Promise<PredictionForwardModelBundle> => {
      return buildForwardModel({
        context,
        checkFreshness,
        experimentId,
        requiredRecordIds: [
          ...new Set(selectedCalculations.flatMap((calculation) => calculation.experiment_record_ids)),
        ].sort((a, b) => a - b),
        varsSchema,
        runtime,
        transaction,
        recordedData,
        resultContracts,
        setup,
        onActivity,
        onForwardRecordProfilesChange,
        onProfile,
      })
    },
    [
      context,
      checkFreshness,
      experimentId,
      onActivity,
      onForwardRecordProfilesChange,
      onProfile,
      recordedData,
      resultContracts,
      runtime,
      selectedCalculations,
      setup,
      varsSchema,
    ],
  )

  const ensureInverseModel = useCallback(
    async (transaction: number) => {
      if (!runtime.transactionIsCurrent(transaction))
        throw new DOMException('Stale Prediction transaction', 'AbortError')
      if (!context || context.experimentId !== experimentId || !varsSchema || !runtime.executionAvailable)
        throw new Error('Inverse 모델 context가 준비되지 않았습니다.')
      if (!setup.calculationIds.length) throw new Error('Inverse에 사용할 Calculation을 선택하세요.')
      if (setup.executionId === 'remote-knn') {
        const reference = setup.models?.inverse
        if (!reference) throw new Error('Inverse 저장 모델을 선택하거나 만드세요.')
        assertSavedPredictionCompatible(reference, context, varsSchema, [], setup.calculationIds)
        const model = await runtime.loadModel(reference, transaction)
        onProfile(model.profile, model.fingerprint)
        return model
      }
      const key = predictionFingerprint([context.fingerprint, setup.calculationIds, varsSchema])
      const snapshot = await runtime.trainingSnapshot(
        'inverse',
        key,
        () =>
          loadTrainingSnapshot({
            context,
            experimentId,
            direction: 'inverse',
            varsSchema,
            calculationIds: setup.calculationIds,
            signal: runtime.transactionSignal(),
            policy: runtime.trainingPolicy,
            checkFreshness,
          }),
        transaction,
      )
      const model = await runtime.prepareModel(snapshot, setup.algorithm, transaction, setup.executionId)
      if (!runtime.transactionIsCurrent(transaction))
        throw new DOMException('Stale Prediction transaction', 'AbortError')
      onProfile(model.profile, model.fingerprint)
      return model
    },
    [context, experimentId, checkFreshness, onProfile, runtime, setup, varsSchema],
  )
  const executeCalculations = useCallback(
    async (input: NonNullable<ReturnType<typeof buildCalculationRecordedData>['input']>, transaction: number) => {
      const controller = runtime.beginCalculation()
      const values: Record<number, CalculationDataOutput> = {}
      const errors: Record<number, string> = {}
      await rowsInBatches(selectedCalculations, 2, async (calculation) => {
        try {
          if (calculation.contract_status !== 'ready' || !calculation.output_layout) {
            throw new Error('Calculation preflight 계약이 준비되지 않았습니다.')
          }
          const requiredNames = calculation.experiment_record_ids.map((recordId) => {
            const name = context?.experimentRecords.find((record) => record.id === recordId)?.name
            if (!name) throw new Error(`ExperimentRecord #${recordId} 계약을 찾을 수 없습니다.`)
            return name
          })
          const calculationInput = Object.freeze(
            Object.fromEntries(
              requiredNames.map((name) => {
                const value = input[name]
                if (!value) throw new Error(`예측할 수 있는 ${name} RecordedData가 없습니다.`)
                return [name, value]
              }),
            ),
          )
          const output = await runCalculation({
            input: calculationInput,
            sourceCode: calculation.source_code,
            signal: controller.signal,
            onLog: (entry) =>
              onActivity?.({
                source: 'calculation',
                level: 'info',
                phase: 'prediction',
                message: `[Prediction · Calculation #${calculation.id}] ${entry.message}`,
                runId: entry.requestId,
              }),
          })
          if (
            predictionFingerprint([calculationOutputContract(output)]) !==
            predictionFingerprint([calculationOutputContract(calculation.output_layout)])
          ) {
            throw new Error('Calculation 결과의 dtype, shape, axis 이름 또는 unit이 저장된 preflight 계약과 다릅니다.')
          }
          values[calculation.id] = output
        } catch (cause: unknown) {
          if (!controller.signal.aborted)
            errors[calculation.id] = cause instanceof Error ? cause.message : String(cause)
        }
      })
      if (!runtime.transactionIsCurrent(transaction))
        throw new DOMException('Stale Prediction transaction', 'AbortError')
      return Object.freeze({ values: Object.freeze(values), errors: Object.freeze(errors) })
    },
    [context?.experimentRecords, onActivity, runtime, selectedCalculations],
  )

  const forwardOutputs = useCallback(
    (vars: Readonly<Vars>, transaction: number, onRecorded?: (preview: PredictionRecordedPreview) => void) =>
      runtime.runWithExecutionRetry(
        transaction,
        async () => {
          if (!candidateReady || !candidateBoxGrids)
            throw new Error('현재 Candidate의 Box Grid 평가가 완료되지 않았습니다.')
          const model = await ensureForwardModel(transaction)
          if (!runtime.transactionIsCurrent(transaction))
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          const { recorded, result } = await predictForwardRecorded({
            model,
            runtime,
            transaction,
            vars,
            candidateBoxGrids,
            onActivity,
          })
          if (!runtime.transactionIsCurrent(transaction))
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          onRecorded?.({ recorded, rules: model.rules, resultContracts, modelFingerprint: model.fingerprint })
          const input = buildCalculationRecordedData(model.rules, recorded)
          if (!input.input)
            throw new Error(input.error ?? '예측 RecordedData를 Calculation input으로 만들 수 없습니다.')
          return { calculated: await executeCalculations(input.input, transaction), model, result }
        },
        clearModelCaches,
      ),
    [
      candidateBoxGrids,
      candidateReady,
      clearModelCaches,
      ensureForwardModel,
      executeCalculations,
      resultContracts,
      onActivity,
      runtime,
    ],
  )

  const predictInverse = useCallback(
    (targets: Readonly<Record<number, CalculationDataOutput>>, transaction: number) => {
      return runtime.runWithExecutionRetry(
        transaction,
        async (): Promise<Readonly<{ model: PredictionModelCache; result: PredictionExecutionResult }>> => {
          const model = await ensureInverseModel(transaction)
          if (!runtime.transactionIsCurrent(transaction))
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          const result = await runtime.predict(model, { direction: 'inverse', targets }, transaction)
          if (!runtime.transactionIsCurrent(transaction))
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          emitPredictionQueryDiagnostics(result, model.fingerprint, runtime.emittedDiagnosticFingerprints, onActivity)
          return Object.freeze({ model, result })
        },
        clearModelCaches,
      )
    },
    [clearModelCaches, ensureInverseModel, onActivity, runtime],
  )

  return { forwardOutputs, predictInverse } as const
}
