import { dbTables, getListRequest, type ExperimentRecordedDataRecord, type PersistedCalculationRecord } from '@/api'
import { analyzeCalculationDependencies, calculationSourceHash, runCalculation } from '@/lib/calculation'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { recordedDataTreeSnapshot } from '../measurement/recordedData'
import { buildCalculationRecordedData } from './calculationRecordedData'
import { requiredCalculationRecordedDataRules } from './experimentRecordCatalogModel'

export type CalculationDataPreflightSummary = Readonly<{
  total: number
  completed: number
  succeeded: number
  failed: number
  saveFailed: number
}>

export async function prepareCalculationData({
  calculations,
  experimentId,
  experimentRecords,
  signal,
  onActivity,
  onProgress,
  onStage,
}: {
  calculations: readonly PersistedCalculationRecord[]
  experimentId: number
  experimentRecords: readonly ExperimentRecordedDataRecord[]
  signal: AbortSignal
  onActivity?: RuntimeActivityCallback
  onProgress: (summary: CalculationDataPreflightSummary) => void
  onStage: (stage: string) => void
}) {
  const pending = calculations.filter((row) => row.contract_status !== 'ready')
  let summary: CalculationDataPreflightSummary = {
    total: pending.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    saveFailed: 0,
  }
  const failedCalculationIds = new Set<number>()
  onProgress(summary)
  if (!pending.length) return failedCalculationIds

  onStage('사전 검증용 Measurement 조회')
  const measurements = await dbTables.Measurement.listRows(
    {
      ...getListRequest('visible'),
      filter: { experiment_id: [experimentId, experimentId] },
      null_filter: { recorded_at: 'is_not_null' },
      limit: null,
      sort: [
        ['recorded_at', 'desc'],
        ['id', 'desc'],
      ],
    },
    { signal, resolveObjects: false },
  )
  signal.throwIfAborted()
  const recordsByName = new Map(experimentRecords.map((record) => [record.name, record]))
  const snapshots = new Map<number, Promise<ReturnType<typeof recordedDataTreeSnapshot>>>()

  for (const calculation of pending) {
    signal.throwIfAborted()
    let phase: 'preflight' | 'preflight-save' = 'preflight'
    try {
      onStage(`Calculation #${calculation.id} 사전 검증`)
      const names = analyzeCalculationDependencies(calculation.source_code, [...recordsByName.keys()])
      const recordIds = names.map((name) => recordsByName.get(name)!.id)
      let selected: { id: number; snapshot: ReturnType<typeof recordedDataTreeSnapshot> } | undefined
      for (const measurement of measurements.items) {
        signal.throwIfAborted()
        if (typeof measurement.id !== 'number' || !measurement.recorded_at) continue
        let snapshot = snapshots.get(measurement.id)
        if (!snapshot) {
          const id = measurement.id
          snapshot = dbTables.Measurement.readRecordedData(id, { signal }).then((tree) =>
            recordedDataTreeSnapshot(tree, id),
          )
          snapshots.set(id, snapshot)
        }
        const data = await snapshot
        signal.throwIfAborted()
        if (recordIds.every((id) => data.rows.some((row) => row.experiment_record_id === id && row.data != null))) {
          selected = { id: measurement.id, snapshot: data }
          break
        }
      }
      if (!selected) throw new Error('필수 입력을 갖춘 기록 완료 Measurement가 없습니다.')
      const recorded = buildCalculationRecordedData(
        requiredCalculationRecordedDataRules(selected.snapshot.rules, names),
        selected.snapshot.flatData,
      )
      if (!recorded.input) throw new Error(recorded.error ?? 'Calculation 입력을 만들 수 없습니다.')
      onStage(`Calculation #${calculation.id} · Measurement #${selected.id} 사전 검증`)
      const output = await runCalculation({
        input: recorded.input,
        sourceCode: calculation.source_code,
        signal,
        onLog: (entry) =>
          onActivity?.({
            source: 'calculation',
            level: 'info',
            phase: 'console.log',
            runId: entry.requestId,
            message: `[사전 검증 · Calculation #${calculation.id} · Measurement #${selected.id}] ${entry.message}`,
          }),
      })
      signal.throwIfAborted()
      const sourceHash = await calculationSourceHash(calculation.source_code)
      signal.throwIfAborted()
      phase = 'preflight-save'
      onStage(`Calculation #${calculation.id} 사전 검증 계약 저장`)
      await dbTables.Calculation.upsertRow(
        [
          {
            id: calculation.id,
            experiment_id: experimentId,
            name: calculation.name,
            description: calculation.description,
            source_code: calculation.source_code,
            source_hash: sourceHash,
            base_revision: calculation.revision,
            base_source_revision: calculation.source_revision,
            contract_status: 'ready',
            preflight_measurement_id: selected.id,
            experiment_record_ids: recordIds,
            output_layout: { dtype: output.dtype, shape: output.shape, axes: output.axes },
          },
        ],
        { signal },
      )
      signal.throwIfAborted()
      summary = { ...summary, completed: summary.completed + 1, succeeded: summary.succeeded + 1 }
    } catch (cause) {
      signal.throwIfAborted()
      failedCalculationIds.add(calculation.id)
      summary = {
        ...summary,
        completed: summary.completed + 1,
        failed: summary.failed + (phase === 'preflight' ? 1 : 0),
        saveFailed: summary.saveFailed + (phase === 'preflight-save' ? 1 : 0),
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      onActivity?.({
        source: 'calculation',
        level: 'error',
        phase,
        message: `Calculation #${calculation.id} ${phase === 'preflight' ? '사전 검증 실패' : '검증 계약 저장 실패'}: ${message}`,
      })
    }
    onProgress(summary)
  }
  return failedCalculationIds
}
