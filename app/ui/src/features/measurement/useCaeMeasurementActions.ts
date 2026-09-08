import { buildBatchArtifact, type BrowserBatchIntent } from './buildBatchArtifact'
import { submitArtifact } from '@/api/submitArtifact'
import { browserClient } from '@/api/http'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { dbTables } from '@/api'
import { caeBatches } from '@/api/cae'
import { ApiError } from '@/api/http'
import type { CaeBatch } from '@/contracts/api/cae'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import { useCaeBatches } from '@/features/cae/CaeBatchProvider'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { CaeDataSelection } from './useCaeDataSelection'
import type { SavedMeasurement } from '@/features/cae-workbench/types'
import type { CalculationDataActions, CalculationDataRunSummary } from '../calculation/useCalculationDataActions'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { invalidateMeasurementMutation } from './queryInvalidation'

export type SaveAndRunCompletion = Readonly<{
  attemptId: number
  measurementId: number
  recordedDataSaved: true
  calculationSummary: CalculationDataRunSummary
}>

export function useCaeMeasurementActions({
  authenticated,
  calculationDataActions,
  experimentClean,
  experimentDocument,
  experimentId,
  experimentSourceHash,
  onGenerateCandidate,
  selection,
  onActivity,
}: {
  authenticated: boolean
  calculationDataActions: CalculationDataActions
  experimentClean: boolean
  experimentDocument: CadDocumentController
  experimentId: number | null
  experimentSourceHash: string | null
  onGenerateCandidate: () => number | null
  selection: CaeDataSelection
  onActivity?: RuntimeActivityCallback
}) {
  const queryClient = useQueryClient()
  const queryScope = usePrivateQueryScope()
  const { batches, events, inspectBatch, update, readPage, waitForChange } = useCaeBatches()
  const [operation, setOperation] = useState<
    'save' | 'delete' | 'generate-and-run' | 'save-and-run' | 'measurement' | null
  >(null)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [batch, setBatch] = useState<CaeBatch | null>(null)
  const [automaticCalculationData, setAutomaticCalculationData] = useState(false)
  const calculating = useRef(false)
  calculating.current = automaticCalculationData
  const sequence = useRef(0)
  const active = useRef<{
    controller: AbortController
    batchId: string | null
    cancelRequested: boolean
    completed: Set<number>
  } | null>(null)
  const latest = useRef({ experimentId, selection, calculationDataActions, onActivity })
  latest.current = { experimentId, selection, calculationDataActions, onActivity }
  const lastEvent = useRef(0)

  const detach = useCallback(() => {
    if (calculating.current) latest.current.calculationDataActions.cancel()
    active.current?.controller.abort()
    active.current = null
    setOperation(null)
    setStage(null)
    setBatch(null)
    setAutomaticCalculationData(false)
  }, [])
  useEffect(
    () => () => {
      active.current?.controller.abort()
      active.current = null
    },
    [],
  )
  useEffect(() => {
    detach()
  }, [detach, experimentId, experimentSourceHash, experimentClean, authenticated, queryScope])
  useEffect(() => {
    for (const event of events) {
      if (event.id <= lastEvent.current) continue
      lastEvent.current = event.id
      if (event.type === 'job.succeeded' && event.measurement_id && active.current?.batchId === event.batch_id)
        active.current.completed.add(event.measurement_id)
      const selected = latest.current.selection.measurement
      if (event.type === 'job.succeeded' && selected && selected.id === event.measurement_id) {
        void invalidateMeasurementMutation(queryClient, queryScope, selected.experiment_id, [selected.id])
          .then(() => {
            if (latest.current.selection.measurement?.id === selected.id)
              return latest.current.selection.loadMeasurement(selected.id, selected.experiment_id, {
                expectedSelectionId: selected.id,
              })
          })
          .catch(() => {})
      }
    }
  }, [events, queryClient, queryScope])

  const requireExperiment = useCallback(() => {
    if (!authenticated) throw new Error('로그인이 필요합니다.')
    if (!experimentClean || !experimentId || !experimentSourceHash)
      throw new Error('저장되고 편집되지 않은 Experiment가 필요합니다.')
    if (experimentDocument.draftTaskNames.length) throw new Error('Solver가 선택되지 않은 Draft Task가 있습니다.')
    return { experiment_id: experimentId, experiment_source_hash: experimentSourceHash }
  }, [authenticated, experimentClean, experimentId, experimentSourceHash, experimentDocument.draftTaskNames.length])
  const requireCandidate = useCallback(() => {
    const identity = requireExperiment()
    if (
      experimentDocument.status !== 'Ready' ||
      experimentDocument.successfulRevision !== experimentDocument.revision ||
      !experimentDocument.variables ||
      !experimentDocument.materialSnapshot
    )
      throw new Error('Candidate 평가가 완료되지 않았습니다.')
    return {
      ...identity,
      vars: experimentDocument.variables,
      material_snapshot: experimentDocument.materialSnapshot,
    }
  }, [experimentDocument, requireExperiment])

  const submit = useCallback(
    (request: BrowserBatchIntent, nextOperation: 'generate-and-run' | 'save-and-run' | 'measurement') => {
      if (active.current || operation) throw new Error('다른 Measurement 작업이 진행 중입니다.')
      const run = {
        controller: new AbortController(),
        batchId: null as string | null,
        cancelRequested: false,
        completed: new Set<number>(),
      }
      const attemptId = ++sequence.current
      active.current = run
      setOperation(nextOperation)
      setError(null)
      setStage('CAE batch 등록')
      setBatch(null)
      const { signal } = run.controller
      const initialSelectionId = latest.current.selection.measurement?.id ?? null
      const calculated = new Set<number>()
      let completion: SaveAndRunCompletion | null = null
      return (async () => {
        const built = await buildBatchArtifact(request, signal, (completed, total) =>
          setStage(`?? ${completed}/${total}`),
        )
        const registered = await submitArtifact({
          client: browserClient,
          artifact: built.artifact,
          experimentId: request.experiment_id,
          requestId: request.request_id,
          readItem: (item) => built.store.readItem(item),
          signal,
          onRegistered: async (id) => {
            run.batchId = id
            if (run.cancelRequested) await caeBatches.cancel(id)
          },
          onProgress: (completed, total) => setStage(`??? ${completed}/${total}`),
        }).finally(() => built.store.close())
        run.batchId = registered.id
        if (run.cancelRequested) await caeBatches.cancel(registered.id)
        signal.throwIfAborted()
        let snapshot = update(registered)
        while (true) {
          signal.throwIfAborted()
          const jobs = snapshot.jobs
          for (const job of jobs) {
            if (job.state === 'succeeded' && job.measurement_id) run.completed.add(job.measurement_id)
          }
          for (
            let offset = jobs.length;
            snapshot.finished_at && offset < (snapshot.jobs_total ?? snapshot.created_count);
          ) {
            const page = await readPage(snapshot.id, { offset, limit: 100 })
            for (const job of page.jobs) {
              if (job.state === 'succeeded' && job.measurement_id) run.completed.add(job.measurement_id)
            }
            if (!page.jobs.length) break
            offset += page.jobs.length
          }
          signal.throwIfAborted()
          setBatch(snapshot)
          setStage(
            `${snapshot.succeeded + snapshot.failed + snapshot.cancelled}/${snapshot.total} · CAE ${snapshot.state}`,
          )
          for (const measurementId of run.completed) {
            run.completed.delete(measurementId)
            if (calculated.has(measurementId)) continue
            calculated.add(measurementId)
            await invalidateMeasurementMutation(queryClient, queryScope, request.experiment_id, [measurementId])
            signal.throwIfAborted()
            const current = latest.current
            const selectedId = current.selection.measurement?.id ?? null
            if (
              current.experimentId === request.experiment_id &&
              (selectedId === measurementId || (completion === null && selectedId === initialSelectionId))
            )
              await current.selection
                .loadMeasurement(measurementId, request.experiment_id, { expectedSelectionId: selectedId })
                .catch(() => null)
            signal.throwIfAborted()
            setAutomaticCalculationData(true)
            const calculationSummary = await current.calculationDataActions.calculateMeasurement(measurementId, {
              onProgress: (progress) => {
                if (!signal.aborted) setStage(`${progress.stage} · ${progress.completed}/${progress.total}`)
              },
            })
            signal.throwIfAborted()
            setAutomaticCalculationData(false)
            completion = { attemptId, measurementId: measurementId, recordedDataSaved: true, calculationSummary }
            if (calculationSummary.failed) {
              const message = `Measurement #${measurementId}: CalculationData ${calculationSummary.failed}개 실패`
              setError(message)
              latest.current.onActivity?.({ source: 'calculation', level: 'warning', message })
            }
          }
          if (snapshot.finished_at || snapshot.state === 'completed' || snapshot.state === 'cancelled') {
            if (snapshot.state === 'cancelled') throw new DOMException('CAE batch를 취소했습니다.', 'AbortError')
            if (request.mode !== 'generate' && !completion)
              throw new Error(jobs.find((job) => job.last_error)?.last_error ?? 'CAE 작업이 완료되지 않았습니다.')
            return completion
          }
          snapshot = await waitForChange(registered.id, snapshot, signal)
        }
      })()
        .catch(async (cause: unknown) => {
          signal.throwIfAborted()
          if (
            cause instanceof ApiError &&
            cause.status === 409 &&
            typeof cause.body === 'object' &&
            cause.body !== null &&
            'detail' in cause.body
          ) {
            const detail = cause.body.detail
            if (
              typeof detail === 'object' &&
              detail !== null &&
              'batch_id' in detail &&
              typeof detail.batch_id === 'string'
            ) {
              const registered = await readPage(detail.batch_id)
              signal.throwIfAborted()
              update(registered)
              inspectBatch(registered.id)
              throw new Error('이미 등록된 Measurement입니다. CAE 작업에서 상태를 확인하고 실패한 작업을 재시도하세요.')
            }
          }
          throw cause
        })
        .finally(() => {
          if (active.current !== run) return
          active.current = null
          setOperation(null)
          setStage(null)
          setBatch(null)
          setAutomaticCalculationData(false)
        })
    },
    [inspectBatch, operation, queryClient, queryScope, update, readPage, waitForChange],
  )
  const reportFailure = useCallback((cause: unknown) => {
    if ((cause as { name?: string })?.name === 'AbortError') return
    const message = cause instanceof Error ? cause.message : 'CAE 작업을 시작하지 못했습니다.'
    setError(message)
    latest.current.onActivity?.({ source: 'cae', level: 'error', message })
  }, [])
  const saveAndRunCurrentAsync = useCallback(async (): Promise<SaveAndRunCompletion> => {
    const result = await submit(
      {
        ...requireCandidate(),
        request_id: crypto.randomUUID(),
        mode: 'candidate',
        evaluation_timeout_ms: experimentDocument.evaluationTimeoutMs,
      },
      'save-and-run',
    )
    if (!result) throw new Error('CAE 결과를 찾을 수 없습니다.')
    return result
  }, [experimentDocument.evaluationTimeoutMs, requireCandidate, submit])
  const saveAndRunCurrent = useCallback(() => {
    void saveAndRunCurrentAsync().catch(reportFailure)
  }, [reportFailure, saveAndRunCurrentAsync])
  const runSelected = useCallback(() => {
    try {
      const identity = requireExperiment()
      const selected = selection.measurement
      if (!selected || selected.recorded_at || selected.experiment_id !== identity.experiment_id)
        throw new Error('현재 Experiment의 Prepared Measurement를 선택하세요.')
      const registered = batches.find((item) => item.jobs.some((job) => job.measurement_id === selected.id))
      if (registered) {
        inspectBatch(registered.id)
        return null
      }
      const requestId = crypto.randomUUID()
      void submit(
        {
          ...identity,
          request_id: requestId,
          mode: 'measurement',
          measurement_id: selected.id,
          evaluation_timeout_ms: experimentDocument.evaluationTimeoutMs,
        },
        'measurement',
      ).catch(reportFailure)
      return requestId
    } catch (cause) {
      reportFailure(cause)
      return null
    }
  }, [
    batches,
    experimentDocument.evaluationTimeoutMs,
    inspectBatch,
    reportFailure,
    requireExperiment,
    selection.measurement,
    submit,
  ])
  const repeatGenerateAndRun = useCallback(
    (count: number) => {
      try {
        if (!Number.isSafeInteger(count) || count < 1) throw new Error('반복 횟수는 양의 정수여야 합니다.')
        void submit(
          {
            ...requireExperiment(),
            request_id: crypto.randomUUID(),
            mode: 'generate',
            count,
            evaluation_timeout_ms: experimentDocument.evaluationTimeoutMs,
          },
          'generate-and-run',
        ).catch(reportFailure)
        return true
      } catch (cause) {
        reportFailure(cause)
        return false
      }
    },
    [experimentDocument.evaluationTimeoutMs, reportFailure, requireExperiment, submit],
  )
  const generateAndRun = useCallback(() => repeatGenerateAndRun(1), [repeatGenerateAndRun])
  const generateCandidate = useCallback(() => {
    if (operation || experimentDocument.runIsBusy) return
    try {
      if (onGenerateCandidate() === null) throw new Error('Candidate 생성을 시작하지 못했습니다.')
    } catch (cause) {
      reportFailure(cause)
    }
  }, [experimentDocument.runIsBusy, onGenerateCandidate, operation, reportFailure])
  const saveCurrent = useCallback(async () => {
    if (operation || active.current) return null
    setOperation('save')
    setError(null)
    try {
      const candidate = requireCandidate()
      const { id } = await dbTables.Measurement.create(candidate)
      await invalidateMeasurementMutation(queryClient, queryScope, candidate.experiment_id, [id])
      if (latest.current.experimentId === candidate.experiment_id)
        await latest.current.selection.loadMeasurement(id, candidate.experiment_id)
      return id
    } catch (cause) {
      reportFailure(cause)
      return null
    } finally {
      setOperation(null)
    }
  }, [operation, queryClient, queryScope, reportFailure, requireCandidate])
  const deleteMeasurements = useCallback(
    async (rows: readonly SavedMeasurement[]) => {
      if (operation || active.current) return false
      setOperation('delete')
      try {
        const ids = rows.map((row) => row.id)
        await dbTables.Measurement.deleteRows(ids)
        if (selection.measurement && ids.includes(selection.measurement.id)) selection.clearMeasurement()
        await invalidateMeasurementMutation(queryClient, queryScope, experimentId, ids)
        return true
      } catch (cause) {
        reportFailure(cause)
        return false
      } finally {
        setOperation(null)
      }
    },
    [experimentId, operation, queryClient, queryScope, reportFailure, selection],
  )
  const cancel = useCallback(() => {
    const run = active.current
    if (!run) return
    run.cancelRequested = true
    if (run.batchId) void caeBatches.cancel(run.batchId).then(update).catch(reportFailure)
    if (automaticCalculationData) latest.current.calculationDataActions.cancel()
    detach()
  }, [automaticCalculationData, detach, reportFailure, update])
  return {
    automaticCalculationData,
    busy: operation !== null,
    cancel,
    cancelable: operation === 'generate-and-run' || operation === 'save-and-run' || operation === 'measurement',
    deleteMeasurements,
    detach,
    error,
    generateAndRun,
    generateAndRunBatch:
      batch?.mode === 'generate'
        ? {
            attempt: batch.succeeded + batch.failed + batch.cancelled,
            failures: batch.failed,
            repeat: batch.total > 1,
            successes: batch.succeeded,
            total: batch.total,
          }
        : null,
    generateCandidate,
    operation,
    repeatGenerateAndRun,
    runSelected,
    saveAndRunCurrent,
    saveAndRunCurrentAsync,
    saveCurrent,
    stage,
  }
}
