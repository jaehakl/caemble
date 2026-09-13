import { dbTables, getListRequest, type RecordedDataRecord } from '@/api'
import { browserClient } from '@/api/http'
import { resolveObjects } from '@/api/objectStorage'
import { isDataTensor } from '@/lib/cad/model/dataTensor'
import type { Vars, VarsSchemaEntry } from '@/lib/cad/model'
import type { RecordedDataSchemaTree } from '@/lib/cad/simulation'
import type { BoxGridData } from '@/contracts/boxGrid'
import type { RecordedResultContracts } from '@/contracts/results'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { recordedDataRules } from '../measurement/recordedData'
import {
  predictedRecordedData,
  predictionFingerprint,
  predictionRecordedRowSample,
  predictionVarsLayouts,
  predictionVarsSamples,
} from './data'
import { emitPredictionCohortDiagnostics, emitPredictionQueryDiagnostics } from './diagnostics'
import {
  PREDICTION_NUMERIC_CELL_LIMIT,
  type PredictionTrainingRow,
  type PredictionNumericDtype,
  type PredictionResult,
  type PredictionWeighting,
} from './knn'
import type { PredictionWorkerModelProfile } from './protocol'
import { PredictionWorkerRestartError } from './client'
import type { PredictionContext } from './predictionContextData'
import type {
  PredictionForwardModelBundle,
  PredictionForwardModelEntry,
  PredictionForwardRecordProfile,
  PredictionRuntimeController,
} from './usePredictionController'

export type ForwardContext = Pick<
  PredictionContext,
  'experimentId' | 'fingerprint' | 'experimentRecords' | 'measurements'
>
export type ForwardBuildOptions = Readonly<{
  context: ForwardContext | null
  experimentId: number | null
  requiredRecordIds: readonly number[]
  varsSchema: Readonly<Record<string, VarsSchemaEntry>> | null
  runtime: PredictionRuntimeController
  transaction: number
  recordedData: RecordedDataSchemaTree
  resultContracts: RecordedResultContracts
  setup: Readonly<{ kMode: 'auto' | 'manual'; manualK: number; weighting: PredictionWeighting }>
  onActivity?: RuntimeActivityCallback
  onForwardRecordProfilesChange: (profiles: readonly PredictionForwardRecordProfile[]) => void
  onProfile: (profile: PredictionWorkerModelProfile, fingerprint: string) => void
}>

export function assertTrainingCellLimit(rows: readonly PredictionTrainingRow[]) {
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

/** Inspect tensor metadata before object downloads or expansion into JS number arrays. */
export function assertPredictionRecordedMemory(rows: readonly RecordedDataRecord[], inputSize: number) {
  let cells = 0
  for (const row of rows) {
    if (!isDataTensor(row.data)) continue
    const shape = row.data.shape
    const values = shape.reduce((size, length) => size * length, 1)
    cells += values + inputSize + (row.data.boxGrid?.frequencyKind === 'modal' ? (shape[4] ?? 0) : 0)
    if (!Number.isSafeInteger(cells) || cells > PREDICTION_NUMERIC_CELL_LIMIT) {
      throw new Error(
        `Box Grid Prediction 학습 데이터가 ${PREDICTION_NUMERIC_CELL_LIMIT.toLocaleString()}개 수치 값 제한을 초과합니다. Grid 또는 학습 Measurement 수를 줄이세요.`,
      )
    }
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

export async function buildForwardModel({
  context,
  experimentId,
  requiredRecordIds,
  varsSchema,
  runtime,
  transaction,
  recordedData,
  resultContracts,
  setup,
  onActivity,
  onForwardRecordProfilesChange,
  onProfile,
}: ForwardBuildOptions): Promise<PredictionForwardModelBundle> {
  if (!runtime.transactionIsCurrent(transaction)) throw new DOMException('Stale Prediction transaction', 'AbortError')
  if (!context || context.experimentId !== experimentId || !varsSchema || !runtime.workerAvailable)
    throw new Error('Forward 모델 context가 준비되지 않았습니다.')
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
    { signal, resolveObjects: false },
  )
  assertPredictionRecordedMemory(
    recordedResponse.items,
    predictionVarsLayouts(varsSchema).reduce(
      (size, layout) => size + layout.shape.reduce((count, length) => count * length, 1),
      0,
    ),
  )
  const hydratedRows = await resolveObjects(browserClient, recordedResponse.items, signal)
  if (!runtime.transactionIsCurrent(transaction)) throw new DOMException('Stale Prediction transaction', 'AbortError')
  const measurementIds = new Set(context.measurements.map((measurement) => measurement.id))
  const rowsByRecord = new Map<number, Map<number, RecordedDataRecord>>()
  hydratedRows.forEach((row) => {
    if (!measurementIds.has(row.measurement_id) || !requiredRecordIds.includes(row.experiment_record_id)) return
    const byMeasurement = rowsByRecord.get(row.experiment_record_id) ?? new Map<number, RecordedDataRecord>()
    byMeasurement.set(row.measurement_id, row)
    rowsByRecord.set(row.experiment_record_id, byMeasurement)
  })

  const models: PredictionForwardModelEntry[] = []
  const errors: Record<number, string> = {}
  const groups = new Map<string, typeof records>()
  for (const record of records) {
    const rule = rulesByName.get(record.name)
    const contract = Object.entries(resultContracts).find(
      ([name]) => record.name === name || record.name.startsWith(`${name}.`),
    )?.[1]
    const key =
      rule?.result.boxGrid?.frequencyKind === 'modal' && contract ? `modal:${contract.task}` : `record:${record.id}`
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const record = group[0]
    const rule = rulesByName.get(record.name)
    const groupRules = group.flatMap((member) => {
      const current = rulesByName.get(member.name)
      return current ? [current] : []
    })
    if (!rule || groupRules.length !== group.length || groupRules.some((member) => !member.result.boxGrid)) {
      group.forEach((member) => {
        errors[member.id] = `현재 Experiment source에서 ${member.name} Box Grid Output을 찾을 수 없습니다.`
      })
      continue
    }
    if (rule.result.dtype === 'bool' || rule.result.dtype === 'string') {
      errors[record.id] = `${record.name}의 dtype ${rule.result.dtype}은 numeric Prediction을 지원하지 않습니다.`
      continue
    }
    const modal = rule.result.boxGrid?.frequencyKind === 'modal'
    const rows = Object.freeze(
      context.measurements.map((measurement): PredictionTrainingRow => {
        try {
          const inputs = predictionVarsSamples(measurement.vars as Readonly<Vars>, varsSchema)
          const stored = group.map((member) => rowsByRecord.get(member.id)?.get(measurement.id))
          if (stored.some((member) => !member))
            return Object.freeze({ measurementId: measurement.id, inputs, outputs: Object.freeze([]) })
          try {
            return Object.freeze({
              measurementId: measurement.id,
              inputs,
              outputs: Object.freeze(stored.map((member) => predictionRecordedRowSample(member!))),
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
      const modelFingerprint = predictionFingerprint([
        fingerprint,
        group.map((member) => [member.id, member.contract_hash]),
      ])
      const generation = runtime.nextGeneration()
      const profile = await runtime.buildModel(`forward:${record.id}`, generation, modelFingerprint, {
        direction: 'forward',
        fingerprint: modelFingerprint,
        inputKeys: predictionVarsLayouts(varsSchema).map((layout) => layout.key),
        outputKeys: group.map((member) => member.name),
        outputDtypes: Object.freeze(
          Object.fromEntries(groupRules.map((member) => [member.label, member.result.dtype as PredictionNumericDtype])),
        ),
        rows,
        diagnoseMetadata: false,
        fixedInputLayouts: predictionVarsLayouts(varsSchema),
        inputScaling: 'range',
        weighting: setup.weighting,
        ...(modal ? { k: 1, nearestOnly: true } : setup.kMode === 'manual' ? { k: setup.manualK } : {}),
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
          records: group,
          rules: groupRules,
          workerEpoch: runtime.workerEpoch,
        }),
      )
    } catch (cause: unknown) {
      if ((cause as { name?: string })?.name === 'AbortError' || cause instanceof PredictionWorkerRestartError)
        throw cause
      group.forEach((member) => {
        errors[member.id] = cause instanceof Error ? cause.message : String(cause)
      })
    }
  }
  onForwardRecordProfilesChange(
    Object.freeze(
      records.map((record) => {
        const model = models.find((candidate) => candidate.records?.some((member) => member.id === record.id))
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
    rules: Object.freeze(models.flatMap((model) => model.rules ?? [model.rule])),
  })
  runtime.cacheForwardModel(next)
  onProfile(profile, fingerprint)
  return next
}

/** Inference only: never builds, refreshes, or restarts a model. */
export async function predictForwardRecorded({
  model,
  runtime,
  transaction,
  vars,
  varsSchema,
  candidateBoxGrids,
  onActivity,
}: Readonly<{
  model: PredictionForwardModelBundle
  runtime: PredictionRuntimeController
  transaction: number
  vars: Readonly<Vars>
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  candidateBoxGrids: Readonly<Record<string, BoxGridData>>
  onActivity?: RuntimeActivityCallback
}>) {
  const query = predictionVarsSamples(vars, varsSchema)
  const results = await Promise.all(
    model.models.map(async (entry) => {
      const result = await runtime.predict(`forward:${entry.record.id}`, entry.generation, entry.fingerprint, query)
      emitPredictionQueryDiagnostics(result, entry.fingerprint, runtime.emittedDiagnosticFingerprints, onActivity)
      return result
    }),
  )
  if (!runtime.transactionIsCurrent(transaction)) throw new DOMException('Stale Prediction transaction', 'AbortError')
  const neighborMap = new Map<number, { distanceSquared: number; weight: number }>()
  results.forEach((result) =>
    result.neighbors.forEach((neighbor) => {
      const current = neighborMap.get(neighbor.measurementId)
      neighborMap.set(neighbor.measurementId, {
        distanceSquared: Math.min(current?.distanceSquared ?? Number.POSITIVE_INFINITY, neighbor.distanceSquared),
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
    extrapolatedInputKeys: Object.freeze([...new Set(results.flatMap((entry) => entry.extrapolatedInputKeys))].sort()),
    constantInputKeysChanged: Object.freeze(
      [...new Set(results.flatMap((entry) => entry.constantInputKeysChanged))].sort(),
    ),
    queryDiagnostics: Object.freeze(results.flatMap((entry) => entry.queryDiagnostics)),
  })
  model.rules.forEach((rule) => {
    if (!candidateBoxGrids[rule.label]) throw new Error(`${rule.label} Candidate Box Grid가 없습니다.`)
  })
  const recorded = predictedRecordedData(
    result.output,
    model.rules,
    (warning) => {
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
    },
    candidateBoxGrids,
  )

  return { recorded, result, model }
}
