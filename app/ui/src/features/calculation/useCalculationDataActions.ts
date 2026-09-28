import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, getListRequest, type CalculationDataMissingRequest } from '@/api'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { calculationSourceHash, runCalculation } from '@/lib/calculation'
import { buildCalculationRecordedData } from './calculationRecordedData'
import { recordedDataTreeSnapshot } from '../measurement/recordedData'
import { invalidateCalculationDataMutation, invalidateCalculationMutation } from './queryInvalidation'
import { executeCalculationDataBatch, type CalculationDataBatchSummary } from './calculationDataBatch'
import { prepareCalculationData, type CalculationDataPreflightSummary } from './calculationDataPreflight'
import { requiredCalculationRecordedDataRules } from './experimentRecordCatalogModel'

export type CalculationDataRunSummary = CalculationDataBatchSummary &
  Readonly<{
    preflight?: CalculationDataPreflightSummary
  }>

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
  const queryScope = usePrivateQueryScope()
  const [progress, setProgress] = useState<CalculationDataProgress | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [experimentId])

  const runMissing = useCallback(
    async (selectors: Omit<CalculationDataMissingRequest, 'experiment_id'>, options: RunOptions, prepare = false) => {
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
      let preflightAttempted = false

      try {
        const calculationRequest = {
          ...getListRequest('visible'),
          limit: null,
          filter: { experiment_id: [experimentId, experimentId] },
          sort: ['updated_at', 'desc'] as const,
        }
        const [initialCalculationList, experimentRecordList] = await Promise.all([
          dbTables.Calculation.listRows(calculationRequest, { signal: controller.signal }),
          dbTables.ExperimentRecord.listRows(
            {
              ...getListRequest('visible'),
              experiment_id: experimentId,
              filter: { experiment_id: [experimentId, experimentId] },
              limit: null,
              sort: ['name', 'asc'],
            },
            { signal: controller.signal },
          ),
        ])
        let calculationList = initialCalculationList
        controller.signal.throwIfAborted()
        let failedCalculationIds = new Set<number>()
        if (prepare && calculationList.items.some((row) => row.contract_status !== 'ready')) {
          preflightAttempted = true
          failedCalculationIds = await prepareCalculationData({
            calculations: calculationList.items,
            experimentId,
            experimentRecords: experimentRecordList.items,
            signal: controller.signal,
            onActivity,
            onStage: (stage) => update({ stage }),
            onProgress: (preflight) => update({ preflight }),
          })
          controller.signal.throwIfAborted()
          calculationList = await dbTables.Calculation.listRows(calculationRequest, { signal: controller.signal })
        }
        controller.signal.throwIfAborted()
        const missing = await dbTables.CalculationData.missing(
          { experiment_id: experimentId, ...selectors },
          { signal: controller.signal },
        )
        controller.signal.throwIfAborted()
        const calculations = new Map(
          calculationList.items.filter((row) => typeof row.id === 'number').map((row) => [row.id, row]),
        )
        const selectedCalculations = calculationList.items.filter(
          (row) => selectors.calculation_id === undefined || row.id === selectors.calculation_id,
        )
        const preflightCount = prepare
          ? 0
          : selectedCalculations.filter((row) => row.contract_status !== 'ready').length
        const preparationFailed = (state.preflight?.failed ?? 0) + (state.preflight?.saveFailed ?? 0)
        const preflightNotice = preflightCount
          ? `Calculation ${preflightCount.toLocaleString()}개는 사전 검증이 필요해 제외했습니다. 해당 Calculation의 미리보기 성공 후 저장하세요.`
          : state.preflight
            ? `Calculation 사전 검증·저장 성공 ${state.preflight.succeeded}개, 사전 검증 실패 ${state.preflight.failed}개, 검증 계약 저장 실패 ${state.preflight.saveFailed}개`
            : ''
        const emptyMessage = !selectedCalculations.length
          ? '저장된 Calculation이 없습니다. Calculation을 먼저 저장하세요.'
          : preflightCount || state.preflight
            ? `계산 대상이 없습니다. ${preflightNotice}`
            : '계산 대상이 없습니다. 아직 결과가 없고 필수 입력을 갖춘 기록 완료 Measurement가 필요합니다.'
        const sourceHashes = new Map<number, Promise<string>>()
        const recordNames = new Map(experimentRecordList.items.map((record) => [record.id, record.name]))
        update({ total: missing.total, stage: missing.total ? `${options.label} 준비` : `${options.label} 완료` })

        const summary = await executeCalculationDataBatch({
          targets: missing.items.filter((target) => !failedCalculationIds.has(target.calculation_id)),
          signal: controller.signal,
          loadMeasurement: (measurementId) =>
            dbTables.Measurement.readRecordedData(measurementId, { signal: controller.signal }).then((tree) =>
              recordedDataTreeSnapshot(tree, measurementId),
            ),
          execute: async (target, snapshot) => {
            controller.signal.throwIfAborted()
            const calculation = calculations.get(target.calculation_id)
            if (!calculation) throw new Error('저장된 Calculation source를 찾을 수 없습니다.')
            if (calculation.contract_status !== 'ready')
              throw new Error('Calculation preflight 계약이 준비되지 않았습니다.')
            const names = calculation.experiment_record_ids.map((recordId) => {
              const name = recordNames.get(recordId)
              if (!name || !(name in snapshot.flatData))
                throw new Error(`필수 ExperimentRecord #${recordId}가 없습니다.`)
              return name
            })
            const recorded = buildCalculationRecordedData(
              requiredCalculationRecordedDataRules(snapshot.rules, names),
              snapshot.flatData,
            )
            if (!recorded.input) throw new Error(recorded.error ?? 'Calculation 입력을 만들 수 없습니다.')
            const output = await runCalculation({
              input: recorded.input,
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
            controller.signal.throwIfAborted()
            let sourceHash = sourceHashes.get(calculation.id)
            if (!sourceHash) {
              sourceHash = calculationSourceHash(calculation.source_code)
              sourceHashes.set(calculation.id, sourceHash)
            }
            const resolvedSourceHash = await sourceHash
            controller.signal.throwIfAborted()
            await dbTables.CalculationData.save(
              {
                calculation_id: calculation.id,
                measurement_id: target.measurement_id,
                source_hash: resolvedSourceHash,
                source_revision: calculation.source_revision,
                data: output,
              },
              { signal: controller.signal },
            )
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
          stage: summary.cancelled
            ? `${options.label} 취소됨`
            : summary.total === 0
              ? emptyMessage
              : `${options.label} 완료${preflightNotice ? ` · ${preflightNotice}` : ''}`,
        })
        if (options.announce) {
          const message = `${options.label}: 성공 ${state.succeeded.toLocaleString()}개, 실패 ${state.failed.toLocaleString()}개${preflightNotice ? ` · ${preflightNotice}` : ''}`
          if (summary.cancelled) toast.warning(`${message}, 취소됨`)
          else if (summary.total === 0) {
            if (preflightCount || preparationFailed) toast.warning(emptyMessage)
            else toast.info(emptyMessage)
          } else if (state.failed || preflightCount || preparationFailed) toast.warning(message)
          else toast.success(message)
        }
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause)
        const cancelled = controller.signal.aborted
        if (!cancelled) onActivity?.({ source: 'calculation', level: 'error', phase: 'calculation-data', message })
        update({
          cancelled,
          failed: cancelled ? state.failed : Math.max(1, state.failed),
          running: false,
          stage: cancelled ? `${options.label} 취소됨` : `${options.label} 실패`,
        })
        if (options.announce && !cancelled) toast.error(message)
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null
        if (preflightAttempted) await invalidateCalculationMutation(queryClient, queryScope, experimentId)
        else await invalidateCalculationDataMutation(queryClient, queryScope, experimentId)
      }
      return {
        total: state.total,
        completed: state.completed,
        succeeded: state.succeeded,
        failed: state.failed,
        cancelled: state.cancelled,
        ...(state.preflight ? { preflight: state.preflight } : {}),
      }
    },
    [authenticated, experimentId, onActivity, queryClient, queryScope],
  )

  const cancel = useCallback(() => controllerRef.current?.abort(), [])
  const calculateAll = useCallback(() => runMissing({}, { announce: true, label: '일괄 계산' }, true), [runMissing])
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
