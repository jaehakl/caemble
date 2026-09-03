import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { CalculationExecutionError, runCalculation, type CalculationInput } from '@/lib/calculation'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import type { CalculationPreviewState } from './CalculationOutputChart'
import type { buildCalculationRecordedData } from './calculationRecordedData'
import type { CalculationDraft } from './calculationEditingState'

export function useCalculationPreview({
  calculationDataBusy,
  contextPending,
  dependencyError,
  draft,
  experimentId,
  experimentRecordsPending,
  measurementId,
  measurementLoading,
  onActivity,
  recordedSnapshot,
  selectedCalculationId,
}: {
  calculationDataBusy: boolean
  contextPending: boolean
  dependencyError: Error | null
  draft: CalculationDraft
  experimentId: number | null
  experimentRecordsPending: boolean
  measurementId: number | null
  measurementLoading: boolean
  onActivity: RuntimeActivityCallback
  recordedSnapshot: ReturnType<typeof buildCalculationRecordedData>
  selectedCalculationId: number | null
}) {
  const [preview, setPreview] = useState<CalculationPreviewState>({
    status: 'idle',
    message: 'Recorded Measurement와 Calculation source를 선택하세요.',
  })
  const sequenceRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const invalidatePreview = useCallback((message: string) => {
    sequenceRef.current += 1
    abortRef.current?.abort()
    setPreview({ status: 'loading', message })
  }, [])

  useLayoutEffect(() => {
    const sequence = ++sequenceRef.current
    const controller = new AbortController()
    abortRef.current = controller
    const cancel = () => {
      controller.abort()
      if (abortRef.current === controller) abortRef.current = null
    }
    if (contextPending) {
      setPreview({ status: 'loading', message: 'Calculation context를 바꾸는 중…' })
      return cancel
    }
    if (selectedCalculationId !== draft.id) {
      setPreview({ status: 'loading', message: 'Calculation source를 불러오는 중…' })
      return cancel
    }
    if (measurementLoading) {
      setPreview({ status: 'loading', message: 'Measurement RecordedData를 불러오는 중…' })
      return cancel
    }
    if (calculationDataBusy) {
      setPreview({ status: 'loading', message: 'CalculationData 일괄 계산이 진행 중…' })
      return cancel
    }
    if (experimentRecordsPending) {
      setPreview({ status: 'loading', message: 'ExperimentRecord 계약을 불러오는 중…' })
      return cancel
    }
    if (dependencyError) {
      setPreview({
        code: dependencyError instanceof CalculationExecutionError ? dependencyError.code : 'policy',
        diagnostic: dependencyError instanceof CalculationExecutionError ? dependencyError.diagnostic : undefined,
        message: dependencyError.message,
        status: 'error',
      })
      return cancel
    }
    if (measurementId === null) {
      setPreview({ status: 'idle', message: 'Recorded Measurement를 선택하면 Output을 자동 계산합니다.' })
      return cancel
    }
    if (!recordedSnapshot.input) {
      onActivity({
        source: 'calculation',
        level: 'error',
        phase: recordedSnapshot.errorCode ?? 'input',
        message: recordedSnapshot.error ?? 'RecordedData 입력을 만들지 못했습니다.',
      })
      setPreview({
        code: recordedSnapshot.errorCode ?? 'input',
        message: recordedSnapshot.error ?? 'RecordedData 입력을 만들지 못했습니다.',
        status: 'error',
      })
      return cancel
    }
    setPreview({ status: 'loading', message: 'Source 변경을 기다리는 중…' })
    const timeout = window.setTimeout(() => {
      if (sequence !== sequenceRef.current) return
      setPreview({ status: 'loading', message: '격리된 Worker에서 계산 중…' })
      void runCalculation({
        input: recordedSnapshot.input as CalculationInput,
        onLog: (entry) => {
          if (sequence !== sequenceRef.current || controller.signal.aborted) return
          onActivity({
            source: 'calculation',
            level: 'info',
            phase: 'console.log',
            message: entry.message,
            runId: entry.requestId,
          })
        },
        signal: controller.signal,
        sourceCode: draft.sourceCode,
      })
        .then((output) => {
          if (sequence === sequenceRef.current && !controller.signal.aborted) {
            setPreview({ output, status: 'success' })
          }
        })
        .catch((cause: unknown) => {
          if (sequence !== sequenceRef.current || controller.signal.aborted) return
          const error =
            cause instanceof CalculationExecutionError
              ? { code: cause.code, diagnostic: cause.diagnostic, message: cause.message }
              : {
                  code: 'runtime' as const,
                  diagnostic: undefined,
                  message: cause instanceof Error ? cause.message : String(cause),
                }
          if (error.code === 'cancelled') return
          const activityMessage = error.diagnostic
            ? [
                `calculation.js:${error.diagnostic.range.startLineNumber}:${error.diagnostic.range.startColumn} ${error.message}`,
                error.diagnostic.sourceLine,
                `${' '.repeat(Math.max(0, error.diagnostic.range.startColumn - 1))}${'^'.repeat(
                  Math.max(1, error.diagnostic.range.endColumn - error.diagnostic.range.startColumn),
                )}`,
              ].join('\n')
            : error.message
          onActivity({
            source: 'calculation',
            level: 'error',
            phase: error.code,
            message: activityMessage,
          })
          setPreview({ ...error, status: 'error' })
        })
    }, 500)
    return () => {
      window.clearTimeout(timeout)
      cancel()
    }
  }, [
    contextPending,
    calculationDataBusy,
    dependencyError,
    draft.id,
    draft.sourceCode,
    experimentId,
    experimentRecordsPending,
    measurementId,
    measurementLoading,
    onActivity,
    recordedSnapshot,
    selectedCalculationId,
  ])

  return { invalidatePreview, preview }
}
