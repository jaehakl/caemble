import { assertTrainingCellLimit, buildForwardModel, predictForwardRecorded } from './forwardModel'
export { assertPredictionRecordedMemory } from './forwardModel'
import { useCallback } from 'react'
import { dbTables, getListRequest, type CalculationDataOutput, type CalculationDataRecord } from '@/api'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { runCalculation } from '@/lib/calculation'
import type { BoxGridData } from '@/contracts/boxGrid'
import type { RecordedResultContracts } from '@/contracts/results'
import type { Vars, VarsSchemaEntry, RecordedData, RecordedDataRule } from '@/lib/cad/model'
import type { RecordedDataSchemaTree } from '@/lib/cad/simulation'
import { buildCalculationRecordedData } from '../calculation/calculationRecordedData'
import { calculationOutputSample, inverseTrainingRows, predictionFingerprint, predictionVarsLayouts } from './data'
import { emitPredictionQueryDiagnostics } from './diagnostics'
import { PREDICTION_NUMERIC_CELL_LIMIT } from './knn'
import { calculationOutputContract } from './metrics'
import type { PredictionNumericDtype, PredictionResult, PredictionWeighting } from './knn'
import type { PredictionWorkerModelProfile } from './protocol'
import type { PredictionKMode } from './PredictionPanels'
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
  calculationWeights: Readonly<Record<number, number>>
  kMode: PredictionKMode
  manualK: number
  weighting: PredictionWeighting
}>

export const defaultPredictionSetup: PredictionSetup = Object.freeze({
  calculationIds: Object.freeze([]),
  calculationWeights: Object.freeze({}),
  kMode: 'auto',
  manualK: 1,
  weighting: 'distance',
})

async function rowsInBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>) {
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(run))
  }
}

export function usePredictionModels({
  clearModelCaches,
  context,
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
  experimentId: number | null
  onActivity?: RuntimeActivityCallback
  onForwardRecordProfilesChange: (profiles: readonly PredictionForwardRecordProfile[]) => void
  onProfile: (profile: PredictionWorkerModelProfile, fingerprint: string) => void
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

  const fetchSelectedCalculationData = useCallback(
    async (transaction?: number) => {
      if (!context || experimentId === null || context.experimentId !== experimentId)
        throw new Error('CalculationData context가 없습니다.')
      const signal = runtime.transactionSignal()
      const ids = context.analysis.items
        .filter((item) => setup.calculationIds.includes(item.calculation_id))
        .map((item) => item.calculation_data_id)
      const records: CalculationDataRecord[] = []
      let numericCells = 0
      for (let offset = 0; offset < ids.length; offset += 50) {
        if (transaction !== undefined && !runtime.transactionIsCurrent(transaction))
          throw new DOMException('Stale Prediction transaction', 'AbortError')
        const selectedIds = ids.slice(offset, offset + 50)
        if (!selectedIds.length) continue
        const response = await dbTables.CalculationData.listRows(
          {
            ...getListRequest('visible', selectedIds),
            experiment_id: experimentId,
            limit: selectedIds.length,
            sort: ['id', 'asc'],
          },
          { signal },
        )
        if (transaction !== undefined && !runtime.transactionIsCurrent(transaction))
          throw new DOMException('Stale Prediction transaction', 'AbortError')
        response.items.forEach((record) => {
          numericCells += record.data.shape.length === 0 ? 1 : (record.data.data as readonly number[]).length
        })
        if (!Number.isSafeInteger(numericCells) || numericCells > PREDICTION_NUMERIC_CELL_LIMIT)
          throw new Error(
            `Prediction CalculationData contains more than ${PREDICTION_NUMERIC_CELL_LIMIT.toLocaleString()} numeric cells.`,
          )
        records.push(...response.items)
      }
      return Object.freeze(records)
    },
    [context, experimentId, runtime, setup.calculationIds],
  )

  const ensureInverseModel = useCallback(
    async (transaction: number) => {
      if (!runtime.transactionIsCurrent(transaction))
        throw new DOMException('Stale Prediction transaction', 'AbortError')
      if (!context || context.experimentId !== experimentId || !varsSchema || !runtime.workerAvailable)
        throw new Error('Inverse 모델 context가 준비되지 않았습니다.')
      if (!setup.calculationIds.length) throw new Error('Inverse에 사용할 Calculation을 선택하세요.')
      const fingerprint = predictionFingerprint([
        context.fingerprint,
        'inverse',
        setup.calculationIds,
        setup.calculationWeights,
        setup.kMode === 'manual' ? setup.manualK : 'auto',
        setup.weighting,
        predictionVarsLayouts(varsSchema),
      ])
      const cached = runtime.cachedModel('inverse')
      if (cached?.fingerprint === fingerprint && cached.workerEpoch === runtime.workerEpoch) return cached
      const rowsKey = predictionFingerprint([
        context.fingerprint,
        setup.calculationIds,
        predictionVarsLayouts(varsSchema),
      ])
      let rows = runtime.cachedInverseRows(rowsKey)
      if (!rows) {
        const records = await fetchSelectedCalculationData(transaction)
        rows = inverseTrainingRows(context.measurements, records, setup.calculationIds, varsSchema)
        if (!runtime.transactionIsCurrent(transaction))
          throw new DOMException('Stale Prediction transaction', 'AbortError')
        runtime.cacheInverseRows(rowsKey, rows)
      }
      assertTrainingCellLimit(rows)
      if (!runtime.transactionIsCurrent(transaction))
        throw new DOMException('Stale Prediction transaction', 'AbortError')
      const generation = runtime.nextGeneration()
      const inputBlockWeights = Object.freeze(
        Object.fromEntries(setup.calculationIds.map((id) => [`calculation:${id}`, setup.calculationWeights[id] ?? 1])),
      )
      const fixedInputLayouts = Object.freeze(
        setup.calculationIds.map((id) => {
          const calculation = selectedCalculations.find((candidate) => candidate.id === id)
          if (!calculation?.output_layout) throw new Error(`Calculation #${id}의 Output 계약이 없습니다.`)
          return Object.freeze({
            key: `calculation:${id}`,
            dtype: calculation.output_layout.dtype as PredictionNumericDtype,
            shape: Object.freeze([...calculation.output_layout.shape]),
            axes: Object.freeze(
              calculation.output_layout.axes.map((axis) =>
                Object.freeze({
                  name: axis.name,
                  ticks: Object.freeze([...axis.ticks]),
                  ...(axis.unit ? { unit: axis.unit } : {}),
                }),
              ),
            ),
          })
        }),
      )
      const profile = await runtime
        .buildModel('inverse', generation, fingerprint, {
          direction: 'inverse',
          fingerprint,
          inputKeys: setup.calculationIds.map((id) => `calculation:${id}`),
          outputKeys: predictionVarsLayouts(varsSchema).map((layout) => layout.key),
          rows,
          fixedInputLayouts,
          fixedOutputLayouts: predictionVarsLayouts(varsSchema),
          inputBlockWeights,
          inputScaling: 'standard-deviation',
          weighting: setup.weighting,
          ...(setup.kMode === 'manual' ? { k: setup.manualK } : {}),
        })
        .finally(() => runtime.releaseInverseRows(rows))
      if (!runtime.transactionIsCurrent(transaction))
        throw new DOMException('Stale Prediction transaction', 'AbortError')
      const next: PredictionModelCache = Object.freeze({
        fingerprint,
        generation,
        profile,
        workerEpoch: runtime.workerEpoch,
      })
      onProfile(profile, fingerprint)
      runtime.cacheModel('inverse', next)
      return next
    },
    [context, experimentId, fetchSelectedCalculationData, onProfile, runtime, selectedCalculations, setup, varsSchema],
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
      runtime.runWithWorkerRestartRetry(
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
            varsSchema: varsSchema!,
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
      varsSchema,
    ],
  )

  const predictInverse = useCallback(
    (targets: Readonly<Record<number, CalculationDataOutput>>, transaction: number) => {
      const query = setup.calculationIds.map((id) => calculationOutputSample(id, targets[id]))
      return runtime.runWithWorkerRestartRetry(
        transaction,
        async (): Promise<Readonly<{ model: PredictionModelCache; result: PredictionResult }>> => {
          const model = await ensureInverseModel(transaction)
          if (!runtime.transactionIsCurrent(transaction))
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          const result = await runtime.predict('inverse', model.generation, model.fingerprint, query)
          if (!runtime.transactionIsCurrent(transaction))
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          emitPredictionQueryDiagnostics(result, model.fingerprint, runtime.emittedDiagnosticFingerprints, onActivity)
          return Object.freeze({ model, result })
        },
        clearModelCaches,
      )
    },
    [clearModelCaches, ensureInverseModel, onActivity, runtime, setup.calculationIds],
  )

  return { forwardOutputs, predictInverse } as const
}
