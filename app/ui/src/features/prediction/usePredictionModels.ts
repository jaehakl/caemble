import { useCallback } from 'react'
import {
  dbTables,
  getListRequest,
  type CalculationDataOutput,
  type CalculationDataRecord,
  type CalculationOutputLayout,
  type RecordedDataRecord,
} from '@/api'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { runCalculation } from '@/lib/calculation'
import type { Vars, VarsSchemaEntry } from '@/lib/cad/model'
import type { RecordedDataSchemaTree } from '@/lib/cad/simulation'
import { buildCalculationRecordedData } from '../calculation/calculationRecordedData'
import { recordedDataRules } from '../measurement/recordedData'
import {
  calculationOutputSample,
  inverseTrainingRows,
  predictedRecordedData,
  predictionFingerprint,
  predictionRecordedRowSample,
  predictionVarsLayouts,
  predictionVarsSamples,
} from './data'
import { emitPredictionCohortDiagnostics, emitPredictionQueryDiagnostics } from './diagnostics'
import { PREDICTION_NUMERIC_CELL_LIMIT } from './knn'
import type { PredictionNumericDtype, PredictionResult, PredictionTrainingRow, PredictionWeighting } from './knn'
import type { PredictionWorkerModelProfile } from './protocol'
import type { PredictionKMode } from './PredictionPanels'
import { PredictionWorkerRestartError } from './client'
import type { PredictionContext, SavedPredictionCalculation } from './predictionContextData'
import {
  type PredictionForwardModelBundle,
  type PredictionForwardModelEntry,
  type PredictionForwardRecordProfile,
  type PredictionModelCache,
  type PredictionRuntimeController,
} from './usePredictionController'

export type { PredictionContext, SavedPredictionCalculation, SavedPredictionMeasurement } from './predictionContextData'

export type PredictionVarsSchema = Readonly<Record<string, VarsSchemaEntry>>

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

function calculationOutputLayout(output: CalculationDataOutput | CalculationOutputLayout) {
  return Object.freeze({
    dtype: output.dtype,
    shape: Object.freeze([...output.shape]),
    axes: Object.freeze(
      output.axes.map((axis) =>
        Object.freeze({
          name: axis.name,
          ticks: Object.freeze([...axis.ticks]),
          ...(axis.unit ? { unit: axis.unit } : {}),
        }),
      ),
    ),
  })
}

async function rowsInBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>) {
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(run))
  }
}

function assertTrainingCellLimit(rows: readonly PredictionTrainingRow[]) {
  let cells = 0
  rows.forEach((row) => {
    row.inputs.forEach((sample) => (cells += sample.values.length))
    row.outputs.forEach((sample) => (cells += sample.values.length))
  })
  if (!Number.isSafeInteger(cells) || cells > PREDICTION_NUMERIC_CELL_LIMIT) {
    throw new Error(
      `Prediction training data contains ${cells.toLocaleString()} numeric cells; the limit is ${PREDICTION_NUMERIC_CELL_LIMIT.toLocaleString()}.`,
    )
  }
}

function aggregateForwardProfiles(models: readonly PredictionForwardModelEntry[]): PredictionWorkerModelProfile {
  const profiles = models.map((model) => model.profile)
  const excluded = {
    'missing-block': 0,
    'extra-block': 0,
    'invalid-tensor': 0,
    'fixed-layout-mismatch': 0,
    'layout-mismatch': 0,
  }
  profiles.forEach((profile) => {
    ;(Object.keys(excluded) as (keyof typeof excluded)[]).forEach((reason) => {
      excluded[reason] += profile.excluded[reason]
    })
  })
  const diagnostics = profiles.flatMap((profile) => profile.diagnostics)
  return Object.freeze({
    direction: 'forward' as const,
    activeInputBlockCount: profiles[0]?.activeInputBlockCount ?? 0,
    rowCount: Math.min(...profiles.map((profile) => profile.rowCount)),
    k: Math.min(...profiles.map((profile) => profile.k)),
    weighting: profiles[0]?.weighting ?? 'distance',
    inputScaling: 'range' as const,
    inputLayouts: Object.freeze([]),
    inputScales: new Float64Array(),
    inputBlockWeights: profiles[0]?.inputBlockWeights ?? Object.freeze({}),
    inputSize: profiles[0]?.inputSize ?? 0,
    outputSize: profiles.reduce((total, profile) => total + profile.outputSize, 0),
    persistentBytes: profiles.reduce((total, profile) => total + profile.persistentBytes, 0),
    workingSetBytes: profiles.reduce((total, profile) => total + profile.workingSetBytes, 0),
    includedMeasurementIds: Object.freeze(
      [...new Set(profiles.flatMap((profile) => profile.includedMeasurementIds))].sort((left, right) => left - right),
    ),
    warningMeasurementIds: Object.freeze(
      [...new Set(profiles.flatMap((profile) => profile.warningMeasurementIds))].sort((left, right) => left - right),
    ),
    dominantShapeSignature: JSON.stringify(
      Object.fromEntries(models.map((model) => [model.record.name, JSON.parse(model.profile.dominantShapeSignature)])),
    ),
    baselineMeasurementId: Math.min(...profiles.map((profile) => profile.baselineMeasurementId)),
    diagnostics: Object.freeze(diagnostics.slice(0, 500)),
    omittedDiagnosticGroups:
      profiles.reduce((total, profile) => total + profile.omittedDiagnosticGroups, 0) +
      Math.max(0, diagnostics.length - 500),
    excluded: Object.freeze(excluded),
  })
}

export function usePredictionModels({
  clearModelCaches,
  context,
  experimentId,
  onActivity,
  onForwardRecordProfilesChange,
  onProfile,
  recordedData,
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
  runtime: PredictionRuntimeController
  selectedCalculations: readonly SavedPredictionCalculation[]
  setup: PredictionSetup
  varsSchema: PredictionVarsSchema | null
}>) {
  const ensureForwardModel = useCallback(
    async (transaction: number): Promise<PredictionForwardModelBundle> => {
      if (!runtime.transactionIsCurrent(transaction))
        throw new DOMException('Stale Prediction transaction', 'AbortError')
      if (!context || context.experimentId !== experimentId || !varsSchema || !runtime.workerAvailable)
        throw new Error('Forward 모델 context가 준비되지 않았습니다.')
      const requiredRecordIds = Object.freeze(
        [...new Set(selectedCalculations.flatMap((calculation) => calculation.experiment_record_ids))].sort(
          (left, right) => left - right,
        ),
      )
      if (!requiredRecordIds.length) throw new Error('선택한 Calculation이 사용하는 ExperimentRecord가 없습니다.')
      const signal = runtime.transactionSignal()
      const records = requiredRecordIds.map((recordId) => {
        const record = context.experimentRecords.find((candidate) => candidate.id === recordId)
        if (!record) throw new Error(`ExperimentRecord #${recordId} 계약을 찾을 수 없습니다.`)
        return record
      })
      const currentRules = recordedDataRules(recordedData, 'prediction.forward')
      const rulesByName = new Map(currentRules.map((rule) => [rule.label, rule]))
      const fingerprint = predictionFingerprint([
        context.fingerprint,
        'forward-by-experiment-record',
        setup.kMode === 'manual' ? setup.manualK : 'auto',
        setup.weighting,
        predictionVarsLayouts(varsSchema),
        records.map((record) => [record.id, record.contract_hash]),
      ])
      const cached = runtime.cachedForwardModel()
      if (
        cached?.fingerprint === fingerprint &&
        cached.models.every((model) => model.workerEpoch === runtime.workerEpoch)
      ) {
        return cached
      }

      const recordedResponse = await dbTables.RecordedData.listRows(
        {
          ...getListRequest('visible'),
          experiment_id: experimentId,
          experiment_record_ids: requiredRecordIds,
          limit: null,
          sort: ['measurement_id', 'asc'],
        },
        { signal },
      )
      if (!runtime.transactionIsCurrent(transaction))
        throw new DOMException('Stale Prediction transaction', 'AbortError')
      const measurementIds = new Set(context.measurements.map((measurement) => measurement.id))
      const rowsByRecord = new Map<number, Map<number, RecordedDataRecord>>()
      recordedResponse.items.forEach((row) => {
        if (!measurementIds.has(row.measurement_id) || !requiredRecordIds.includes(row.experiment_record_id)) return
        const byMeasurement = rowsByRecord.get(row.experiment_record_id) ?? new Map<number, RecordedDataRecord>()
        byMeasurement.set(row.measurement_id, row)
        rowsByRecord.set(row.experiment_record_id, byMeasurement)
      })

      const models: PredictionForwardModelEntry[] = []
      const errors: Record<number, string> = {}
      for (const record of records) {
        const rule = rulesByName.get(record.name)
        if (!rule) {
          errors[record.id] = `현재 Experiment source에서 ${record.name} Record를 찾을 수 없습니다.`
          continue
        }
        if (rule.result.dtype === 'bool' || rule.result.dtype === 'string') {
          errors[record.id] = `${record.name}의 dtype ${rule.result.dtype}은 numeric Prediction을 지원하지 않습니다.`
          continue
        }
        const byMeasurement = rowsByRecord.get(record.id) ?? new Map<number, RecordedDataRecord>()
        const rows = Object.freeze(
          context.measurements.map((measurement): PredictionTrainingRow => {
            try {
              const inputs = predictionVarsSamples(measurement.vars as Readonly<Vars>, varsSchema)
              const stored = byMeasurement.get(measurement.id)
              if (!stored) return Object.freeze({ measurementId: measurement.id, inputs, outputs: Object.freeze([]) })
              try {
                return Object.freeze({
                  measurementId: measurement.id,
                  inputs,
                  outputs: Object.freeze([predictionRecordedRowSample(stored)]),
                })
              } catch {
                return Object.freeze({
                  measurementId: measurement.id,
                  inputs,
                  outputs: Object.freeze([
                    Object.freeze({
                      layout: Object.freeze({ key: record.name, dtype: 'float64' as const, shape: Object.freeze([]) }),
                      values: Object.freeze([Number.NaN]),
                    }),
                  ]),
                })
              }
            } catch {
              return Object.freeze({
                measurementId: measurement.id,
                inputs: Object.freeze([]),
                outputs: Object.freeze([]),
              })
            }
          }),
        )
        try {
          assertTrainingCellLimit(rows)
          const modelFingerprint = predictionFingerprint([fingerprint, record.id, record.contract_hash])
          const generation = runtime.nextGeneration()
          const profile = await runtime.buildModel(`forward:${record.id}`, generation, modelFingerprint, {
            direction: 'forward',
            fingerprint: modelFingerprint,
            inputKeys: predictionVarsLayouts(varsSchema).map((layout) => layout.key),
            outputKeys: [record.name],
            outputDtypes: Object.freeze({ [record.name]: rule.result.dtype as PredictionNumericDtype }),
            rows,
            diagnoseMetadata: false,
            fixedInputLayouts: predictionVarsLayouts(varsSchema),
            inputScaling: 'range',
            weighting: setup.weighting,
            ...(setup.kMode === 'manual' ? { k: setup.manualK } : {}),
          })
          if (!runtime.transactionIsCurrent(transaction))
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          emitPredictionCohortDiagnostics(profile, modelFingerprint, runtime.emittedDiagnosticFingerprints, onActivity)
          models.push(
            Object.freeze({
              fingerprint: modelFingerprint,
              generation,
              profile,
              record,
              rule,
              workerEpoch: runtime.workerEpoch,
            }),
          )
        } catch (cause: unknown) {
          if ((cause as { name?: string })?.name === 'AbortError' || cause instanceof PredictionWorkerRestartError)
            throw cause
          errors[record.id] = cause instanceof Error ? cause.message : String(cause)
        }
      }
      onForwardRecordProfilesChange(
        Object.freeze(
          records.map((record) => {
            const model = models.find((candidate) => candidate.record.id === record.id)
            return Object.freeze({
              error: errors[record.id] ?? null,
              name: record.name,
              profile: model?.profile ?? null,
              recordId: record.id,
            })
          }),
        ),
      )
      if (!models.length) throw new Error(Object.values(errors)[0] ?? '사용 가능한 ExperimentRecord 모델이 없습니다.')
      const profile = aggregateForwardProfiles(models)
      const next = Object.freeze({
        errors: Object.freeze(errors),
        fingerprint,
        models: Object.freeze(models),
        profile,
        rules: Object.freeze(models.map((model) => model.rule)),
      })
      runtime.cacheForwardModel(next)
      onProfile(profile, fingerprint)
      return next
    },
    [
      context,
      experimentId,
      onActivity,
      onForwardRecordProfilesChange,
      onProfile,
      recordedData,
      runtime,
      selectedCalculations,
      setup.kMode,
      setup.manualK,
      setup.weighting,
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
            predictionFingerprint([calculationOutputLayout(output)]) !==
            predictionFingerprint([calculationOutputLayout(calculation.output_layout)])
          ) {
            throw new Error('Calculation 결과 layout이 저장된 preflight 계약과 다릅니다.')
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
    (vars: Readonly<Vars>, transaction: number) =>
      runtime.runWithWorkerRestartRetry(
        transaction,
        async () => {
          const model = await ensureForwardModel(transaction)
          if (!runtime.transactionIsCurrent(transaction))
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          const query = predictionVarsSamples(vars, varsSchema!)
          const results = await Promise.all(
            model.models.map(async (entry) => {
              const result = await runtime.predict(
                `forward:${entry.record.id}`,
                entry.generation,
                entry.fingerprint,
                query,
              )
              emitPredictionQueryDiagnostics(
                result,
                entry.fingerprint,
                runtime.emittedDiagnosticFingerprints,
                onActivity,
              )
              return result
            }),
          )
          if (!runtime.transactionIsCurrent(transaction))
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          const neighborMap = new Map<number, { distanceSquared: number; weight: number }>()
          results.forEach((result) =>
            result.neighbors.forEach((neighbor) => {
              const current = neighborMap.get(neighbor.measurementId)
              neighborMap.set(neighbor.measurementId, {
                distanceSquared: Math.min(
                  current?.distanceSquared ?? Number.POSITIVE_INFINITY,
                  neighbor.distanceSquared,
                ),
                weight: (current?.weight ?? 0) + neighbor.weight / results.length,
              })
            }),
          )
          const result: PredictionResult = Object.freeze({
            direction: 'forward',
            fingerprint: model.fingerprint,
            output: Object.freeze(results.flatMap((entry) => entry.output)),
            neighbors: Object.freeze(
              [...neighborMap.entries()]
                .map(([measurementId, neighbor]) => Object.freeze({ measurementId, ...neighbor }))
                .sort((left, right) => right.weight - left.weight || left.measurementId - right.measurementId),
            ),
            extrapolatedInputKeys: Object.freeze(
              [...new Set(results.flatMap((entry) => entry.extrapolatedInputKeys))].sort(),
            ),
            constantInputKeysChanged: Object.freeze(
              [...new Set(results.flatMap((entry) => entry.constantInputKeysChanged))].sort(),
            ),
            queryDiagnostics: Object.freeze(results.flatMap((entry) => entry.queryDiagnostics)),
          })
          const recorded = predictedRecordedData(result.output, model.rules, (warning) => {
            const key = `axis-fallback:${model.fingerprint}:${warning.blockKey}:${warning.axisIndex}`
            if (runtime.emittedDiagnosticFingerprints.has(key)) return
            runtime.emittedDiagnosticFingerprints.add(key)
            onActivity?.({
              source: 'prediction',
              level: 'warning',
              phase: 'cohort.forward',
              message: `[Forward output] ${warning.blockKey} axis ${warning.axisIndex}의 ticks를 사용할 수 없어 ${warning.length.toLocaleString()}개 ordinal ticks로 대체했습니다.`,
              details: {
                block: warning.blockKey,
                axisIndex: warning.axisIndex,
                length: warning.length,
                modelFingerprint: model.fingerprint,
              },
            })
          })
          const input = buildCalculationRecordedData(model.rules, recorded)
          if (!input.input)
            throw new Error(input.error ?? '예측 RecordedData를 Calculation input으로 만들 수 없습니다.')
          return { calculated: await executeCalculations(input.input, transaction), model, result }
        },
        clearModelCaches,
      ),
    [clearModelCaches, ensureForwardModel, executeCalculations, onActivity, runtime, varsSchema],
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
