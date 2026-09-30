import {
  dbTables,
  getListRequest,
  type CalculationDataRecord,
  type ExperimentRecordedDataRecord,
  type PersistedCalculationRecord,
  type PersistedMeasurementRecord,
  type RecordedDataRecord,
} from '@/api'
import type { RecordedResultContracts } from '@/contracts/results'
import type { RecordedDataRule, VarsSchemaEntry } from '@/lib/cad/model'
import type { RecordedDataSchemaTree } from '@/lib/cad/simulation'
import { recordedDataRules } from '@/features/measurement/recordedData'
import type { PredictionTrainingPolicy } from './execution'
import type { PredictionContext } from './predictionContextData'

const representationVersion = 'prediction-raw-input-v1'

export class PredictionTrainingChangedError extends Error {
  override readonly name = 'PredictionTrainingChangedError'

  constructor() {
    super('Prediction 학습 데이터를 준비하는 동안 원본이 변경되었습니다. 다시 준비하세요.')
  }
}

type TrainingSnapshotCommon = Readonly<{
  fingerprint: string
  sourceFingerprint: string
  experimentId: number
  representationVersion: string
  measurements: readonly PersistedMeasurementRecord[]
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
}>

export type TrainingSnapshot = TrainingSnapshotCommon &
  (
    | Readonly<{
        direction: 'forward'
        records: readonly ExperimentRecordedDataRecord[]
        recorded: readonly RecordedDataRecord[]
        rules: readonly RecordedDataRule[]
        resultContracts: RecordedResultContracts
      }>
    | Readonly<{
        direction: 'inverse'
        calculations: readonly PersistedCalculationRecord[]
        calculationData: readonly CalculationDataRecord[]
      }>
  )

export type TrainingSnapshotInput =
  | Omit<Extract<TrainingSnapshot, { direction: 'forward' }>, 'fingerprint' | 'representationVersion'>
  | Omit<Extract<TrainingSnapshot, { direction: 'inverse' }>, 'fingerprint' | 'representationVersion'>

function freezeSnapshotValue<T>(value: T): T {
  if (value && typeof value === 'object') {
    const members = Array.isArray(value) ? value : Object.values(value)
    for (const member of members) freezeSnapshotValue(member)
    Object.freeze(value)
  }
  return value
}

async function contentHash(value: unknown) {
  const serialized = JSON.stringify(value, (_key, member: unknown) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) return member
    const object = member as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, object[key]]),
    )
  })
  const bytes = new TextEncoder().encode(serialized)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function itemHashes(items: readonly unknown[]) {
  const hashes: string[] = []
  // Bound serialization memory to one row; the final identity contains only hashes.
  for (const item of items) hashes.push(await contentHash(item))
  return hashes
}

/**
 * Shared selection metadata is copied before the first await. Fresh API `recorded`
 * and `calculationData` rows transfer ownership here: their arrays and nested values
 * are frozen in place, never copied again for another model preparation.
 * Stored object references retain their content identity; consumers must resolve
 * them through the checksum-verifying object storage boundary.
 */
export async function createTrainingSnapshot(input: TrainingSnapshotInput): Promise<TrainingSnapshot> {
  const common = {
    experimentId: input.experimentId,
    sourceFingerprint: input.sourceFingerprint,
    measurements: freezeSnapshotValue(structuredClone(input.measurements)),
    varsSchema: freezeSnapshotValue(structuredClone(input.varsSchema)),
  }
  const captured =
    input.direction === 'forward'
      ? {
          ...common,
          direction: 'forward' as const,
          ...freezeSnapshotValue(
            structuredClone({ records: input.records, rules: input.rules, resultContracts: input.resultContracts }),
          ),
          recorded: freezeSnapshotValue(input.recorded),
        }
      : {
          ...common,
          direction: 'inverse' as const,
          calculations: freezeSnapshotValue(structuredClone(input.calculations)),
          calculationData: freezeSnapshotValue(input.calculationData),
        }
  return identifyTrainingSnapshot(captured)
}

async function identifyTrainingSnapshot(captured: TrainingSnapshotInput): Promise<TrainingSnapshot> {
  const sharedHashes = [
    await contentHash([representationVersion, captured.experimentId, captured.direction, captured.varsSchema]),
    await itemHashes(captured.measurements),
  ]
  const sourceHashes =
    captured.direction === 'forward'
      ? [
          await itemHashes(captured.records),
          await itemHashes(captured.recorded),
          await itemHashes(captured.rules),
          await contentHash(captured.resultContracts),
        ]
      : [await itemHashes(captured.calculations), await itemHashes(captured.calculationData)]
  const fingerprint = `sha256:${await contentHash([sharedHashes, sourceHashes])}`
  return Object.freeze({ ...captured, representationVersion, fingerprint })
}

export async function loadTrainingSnapshot({
  context,
  experimentId,
  direction,
  varsSchema,
  requiredRecordIds = [],
  calculationIds = [],
  recordedData = {},
  resultContracts = {},
  signal,
  policy,
  checkFreshness,
}: Readonly<{
  context: PredictionContext
  experimentId: number
  direction: TrainingSnapshot['direction']
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  requiredRecordIds?: readonly number[]
  calculationIds?: readonly number[]
  recordedData?: RecordedDataSchemaTree
  resultContracts?: RecordedResultContracts
  signal?: AbortSignal
  policy?: PredictionTrainingPolicy
  checkFreshness?: () => Promise<string>
}>): Promise<TrainingSnapshot> {
  signal?.throwIfAborted()
  if (context.experimentId !== experimentId) throw new Error('Prediction 학습 데이터의 Experiment가 다릅니다.')
  const common = freezeSnapshotValue(
    structuredClone({
      experimentId,
      sourceFingerprint: context.fingerprint,
      measurements: context.measurements,
      varsSchema,
    }),
  )
  let input: TrainingSnapshotInput
  if (direction === 'forward') {
    const records = requiredRecordIds.map((id) => {
      const record = context.experimentRecords.find((candidate) => candidate.id === id)
      if (!record) throw new Error(`ExperimentRecord #${id} 계약을 찾을 수 없습니다.`)
      return record
    })
    const selected = freezeSnapshotValue(
      structuredClone({
        records,
        rules: recordedDataRules(recordedData, 'prediction.forward'),
        resultContracts,
      }),
    )
    const response = await dbTables.RecordedData.listRows(
      {
        ...getListRequest('visible'),
        experiment_id: experimentId,
        experiment_record_ids: selected.records.map((record) => record.id),
        limit: null,
        sort: ['measurement_id', 'asc'],
      },
      { signal, resolveObjects: false },
    )
    signal?.throwIfAborted()
    const measurementIds = new Set(common.measurements.map((measurement) => measurement.id))
    const recordIds = new Set(selected.records.map((record) => record.id))
    const recorded = freezeSnapshotValue(
      response.items.filter((row) => measurementIds.has(row.measurement_id) && recordIds.has(row.experiment_record_id)),
    )
    policy?.checkRecordedData(recorded, common.varsSchema)
    input = { ...common, direction, ...selected, recorded }
  } else {
    const calculations = freezeSnapshotValue(
      structuredClone(
        calculationIds.map((id) => {
          const calculation = context.calculations.find((candidate) => candidate.id === id)
          if (!calculation) throw new Error(`Calculation #${id} 계약을 찾을 수 없습니다.`)
          return calculation
        }),
      ),
    )
    const ids = context.analysis.items
      .filter((item) => calculationIds.includes(item.calculation_id))
      .map((item) => item.calculation_data_id)
    const calculationData: CalculationDataRecord[] = []
    for (let offset = 0; offset < ids.length; offset += 50) {
      signal?.throwIfAborted()
      const selectedIds = ids.slice(offset, offset + 50)
      const response = await dbTables.CalculationData.listRows(
        {
          ...getListRequest('visible', selectedIds),
          experiment_id: experimentId,
          limit: selectedIds.length,
          sort: ['id', 'asc'],
        },
        { signal },
      )
      signal?.throwIfAborted()
      calculationData.push(...freezeSnapshotValue(response.items))
      policy?.checkCalculationData(calculationData)
    }
    input = { ...common, direction, calculations, calculationData: Object.freeze(calculationData) }
  }
  const snapshot = await identifyTrainingSnapshot(input)
  signal?.throwIfAborted()
  if (checkFreshness) {
    const currentFingerprint = await checkFreshness()
    signal?.throwIfAborted()
    if (currentFingerprint !== common.sourceFingerprint) throw new PredictionTrainingChangedError()
  }
  signal?.throwIfAborted()
  return snapshot
}
