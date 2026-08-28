import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, getListRequest, type CalculationDataMissingRequest, type CalculationRecord } from '@/api'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { calculationSourceHash, runCalculation } from '@/lib/calculation'
import { buildCalculationRecordedData } from './calculationRecordedData'
import { recordedDataTreeSnapshot } from '../measurement/recordedData'
import { executeCalculationDataBatch, type CalculationDataBatchSummary } from './calculationDataBatch'

type SavedCalculation = CalculationRecord & { id: number }

export type CalculationDataRunSummary = CalculationDataBatchSummary

export type CalculationDataProgress = CalculationDataRunSummary &
  Readonly<{
    running: boolean
    stage: string
  }>

type RunOptions = Readonly<{
  announce?: boolean
  label: string
  onProgress?: (progress: CalculationDataProgress) => void
}>

const emptySummary: CalculationDataRunSummary = Object.freeze({
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  cancelled: false,
})

export function useCalculationDataActions({
  authenticated,
  experimentId,
  onActivity,
}: {
  authenticated: boolean
  experimentId: number | null
  onActivity?: RuntimeActivityCallback
}) {
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<CalculationDataProgress | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [experimentId])

  const runMissing = useCallback(
    async (selectors: Omit<CalculationDataMissingRequest, 'experiment_id'>, options: RunOptions) => {
      if (!authenticated || experimentId === null) {
        const message = '저장된 Experiment에 로그인한 뒤 CalculationData를 계산하세요.'
        if (options.announce) toast.error(message)
        return { ...emptySummary, failed: 1 }
      }
      if (controllerRef.current) {
        if (options.announce) toast.error('다른 CalculationData 작업이 진행 중입니다.')
        return { ...emptySummary, failed: 1 }
      }

      const controller = new AbortController()
      controllerRef.current = controller
      let state: CalculationDataProgress = {
        ...emptySummary,
        running: true,
        stage: `${options.label} 대상 확인`,
      }
      const update = (next: Partial<CalculationDataProgress>) => {
        state = { ...state, ...next }
        setProgress(state)
        options.onProgress?.(state)
      }
      update({})

      try {
        const calculationRequest = {
          ...getListRequest('visible'),
          limit: null,
          filter: { experiment_id: [experimentId, experimentId] },
          sort: ['updated_at', 'desc'] as const,
        }
        const [missing, calculationList] = await Promise.all([
          dbTables.CalculationData.missing({ experiment_id: experimentId, ...selectors }),
          dbTables.Calculation.listRows(calculationRequest),
        ])
        const calculations = new Map(
          calculationList.items
            .filter((row): row is SavedCalculation => typeof row.id === 'number')
            .map((row) => [row.id, row]),
        )
        const sourceHashes = new Map<number, Promise<string>>()
        update({ total: missing.total, stage: missing.total ? `${options.label} 준비` : `${options.label} 완료` })

        const summary = await executeCalculationDataBatch({
          targets: missing.items,
          signal: controller.signal,
          loadMeasurement: (measurementId) =>
            dbTables.Measurement.readRecordedData(measurementId).then((tree) => {
              const snapshot = recordedDataTreeSnapshot(tree, measurementId)
              const recorded = buildCalculationRecordedData(snapshot.rules, snapshot.flatData)
              if (!recorded.input) throw new Error(recorded.error ?? 'Calculation 입력을 만들 수 없습니다.')
              return recorded.input
            }),
          execute: async (target, input) => {
            const calculation = calculations.get(target.calculation_id)
            if (!calculation) throw new Error('저장된 Calculation source를 찾을 수 없습니다.')
            const output = await runCalculation({
              input,
              sourceCode: calculation.source_code,
              signal: controller.signal,
              onLog: (entry) =>
                onActivity?.({
                  source: 'calculation',
                  level: 'info',
                  phase: 'console.log',
                  message: `[Measurement #${target.measurement_id} · Calculation #${target.calculation_id}] ${entry.message}`,
                  runId: entry.requestId,
                }),
            })
            let sourceHash = sourceHashes.get(calculation.id)
            if (!sourceHash) {
              sourceHash = calculationSourceHash(calculation.source_code)
              sourceHashes.set(calculation.id, sourceHash)
            }
            await dbTables.CalculationData.save({
              calculation_id: calculation.id,
              measurement_id: target.measurement_id,
              source_hash: await sourceHash,
              data: output,
            })
          },
          onTarget: (target) =>
            update({ stage: `Measurement #${target.measurement_id} · Calculation #${target.calculation_id}` }),
          onFailure: (target, cause) => {
            const message = cause instanceof Error ? cause.message : String(cause)
            onActivity?.({
              source: 'calculation',
              level: 'error',
              phase: 'calculation-data',
              message: `Measurement #${target.measurement_id} · Calculation #${target.calculation_id}: ${message}`,
            })
          },
          onProgress: (next) => update(next),
        })

        update({
          ...summary,
          running: false,
          stage: summary.cancelled ? `${options.label} 취소됨` : `${options.label} 완료`,
        })
        if (options.announce) {
          const message = `${options.label}: 성공 ${state.succeeded.toLocaleString()}개, 실패 ${state.failed.toLocaleString()}개`
          if (summary.cancelled) toast.warning(`${message}, 취소됨`)
          else if (state.failed) toast.warning(message)
          else toast.success(message)
        }
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause)
        const cancelled = controller.signal.aborted
        onActivity?.({ source: 'calculation', level: 'error', phase: 'calculation-data', message })
        update({
          cancelled,
          failed: cancelled ? state.failed : Math.max(1, state.failed),
          running: false,
          stage: cancelled ? `${options.label} 취소됨` : `${options.label} 실패`,
        })
        if (options.announce && !cancelled) toast.error(message)
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null
        await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'calculation-data'] })
        await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'measurements'] })
      }
      return {
        total: state.total,
        completed: state.completed,
        succeeded: state.succeeded,
        failed: state.failed,
        cancelled: state.cancelled,
      }
    },
    [authenticated, experimentId, onActivity, queryClient],
  )

  const cancel = useCallback(() => controllerRef.current?.abort(), [])
  const calculateAll = useCallback(() => runMissing({}, { announce: true, label: 'All Missing' }), [runMissing])
  const calculateMeasurement = useCallback(
    (measurementId: number, options: Omit<RunOptions, 'label'> = {}) =>
      runMissing(
        { measurement_id: measurementId },
        { label: `Measurement #${measurementId} CalculationData`, ...options },
      ),
    [runMissing],
  )
  const calculateSelected = useCallback(
    (calculationId: number) =>
      runMissing(
        { calculation_id: calculationId },
        { announce: true, label: `Calculation #${calculationId} Measurements` },
      ),
    [runMissing],
  )

  return {
    busy: progress?.running ?? false,
    cancel,
    calculateAll,
    calculateMeasurement,
    calculateSelected,
    progress,
  }
}

export type CalculationDataActions = ReturnType<typeof useCalculationDataActions>
