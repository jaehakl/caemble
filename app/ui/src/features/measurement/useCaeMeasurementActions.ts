import { buildBatchArtifact, type BrowserBatchIntent, type BrowserBatchCandidates } from './buildBatchArtifact'
import { generateRandomVars } from '@/lib/cad/model/vars'
import { submitArtifact } from '@/api/submitArtifact'
import { browserClient } from '@/api/http'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { dbTables } from '@/api'
import { caeBatches } from '@/api/cae'
import { ApiError } from '@/api/http'
import type { CaeBatch, CaeMeasurementExecution } from '@/contracts/api/cae'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import { useCaeBatches } from '@/features/cae/CaeBatchProvider'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { CaeDataSelection } from './useCaeDataSelection'
import type { SavedMeasurement } from '@/features/cae-workbench/types'
import type { CalculationDataActions, CalculationDataRunSummary } from '../calculation/useCalculationDataActions'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { invalidateMeasurementMutation } from './queryInvalidation'
import type { Vars } from '@/lib/cad/model/types'
import type { MeasurementMaterialSnapshot } from '@/contracts/api/measurement'

export type ReviewedMeasurementInput = Readonly<{
  candidateId: string
  vars: Readonly<Vars>
  materialSnapshot?: MeasurementMaterialSnapshot
  measurementId?: number
}>

export type ReviewedMeasurementProgress = Readonly<{
  measurementId: number | null
  state: string
  error: string | null
}>

export type SaveAndRunCompletion = Readonly<{
  attemptId: number
  measurementId: number
  recordedDataSaved: true
  calculationSummary: CalculationDataRunSummary
}>

export type CandidateBatchProgress = Readonly<{
  batchId: string
  total: number
  succeeded: number
  failed: number
  cancelled: number
  calculationFailed: number
  calculated: number
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
  const { events, update, readPage, waitForChange } = useCaeBatches()
  const [operation, setOperation] = useState<
    'save' | 'delete' | 'generate-and-run' | 'save-and-run' | 'measurement' | null
  >(null)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [batch, setBatch] = useState<CaeBatch | null>(null)
  const [samplingTotal, setSamplingTotal] = useState<number | null>(null)
  const [automaticCalculationData, setAutomaticCalculationData] = useState(false)
  const candidatePreparation = useRef<AbortController | null>(null)
  const calculating = useRef(false)
  calculating.current = automaticCalculationData
  const sequence = useRef(0)
  const active = useRef<{
    controller: AbortController
    batchId: string | null
    jobId: string | null
    jobAttempt: number | null
    cancelRequested: boolean
    completed: Set<number>
  } | null>(null)
  const latest = useRef({ experimentId, selection, calculationDataActions, onActivity })
  latest.current = { experimentId, selection, calculationDataActions, onActivity }
  const lastEvent = useRef(0)

  const detach = useCallback(() => {
    if (calculating.current) latest.current.calculationDataActions.cancel()
    candidatePreparation.current?.abort()
    active.current?.controller.abort()
    active.current = null
    setOperation(null)
    setStage(null)
    setBatch(null)
    setAutomaticCalculationData(false)
  }, [])
  useEffect(
    () => () => {
      candidatePreparation.current?.abort()
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
      const run = active.current
      const matchesAttempt = !run?.jobId || (event.job_id === run.jobId && event.attempt_count === run.jobAttempt)
      if (event.type === 'job.succeeded' && event.measurement_id && run?.batchId === event.batch_id && matchesAttempt)
        run.completed.add(event.measurement_id)
      const selected = latest.current.selection.measurement
      if (event.type === 'job.succeeded' && selected && selected.id === event.measurement_id && matchesAttempt) {
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

  const prepareCandidate = useCallback(async () => {
    const identity = requireExperiment()
    candidatePreparation.current?.abort()
    const abort = new AbortController()
    candidatePreparation.current = abort
    setOperation('save-and-run')
    setStage('Candidate 평가 준비')
    try {
      const prepared = await experimentDocument.ensureFullEvaluation!(abort.signal)
      abort.signal.throwIfAborted()
      return { ...identity, vars: prepared.variables, material_snapshot: prepared.materialSnapshot }
    } catch (cause) {
      setOperation(null)
      setStage(null)
      throw cause
    } finally {
      if (candidatePreparation.current === abort) candidatePreparation.current = null
    }
  }, [experimentDocument, requireExperiment])

  const submit = useCallback(
    (
      request: BrowserBatchIntent,
      nextOperation: 'generate-and-run' | 'save-and-run' | 'measurement',
      onBatchProgress?: (progress: CandidateBatchProgress) => void,
      onBatchState?: (batch: CaeBatch) => void,
      onRecorded?: (measurementId: number) => void,
    ) => {
      if (active.current || operation === 'save' || operation === 'delete')
        throw new Error('다른 Measurement 작업이 진행 중입니다.')
      const run = {
        controller: new AbortController(),
        batchId: null as string | null,
        jobId: null as string | null,
        jobAttempt: null as number | null,
        cancelRequested: false,
        completed: new Set<number>(),
      }
      const attemptId = ++sequence.current
      active.current = run
      setOperation(nextOperation)
      setSamplingTotal(request.candidates?.algorithm === 'monte-carlo' ? request.candidates.count : null)
      setError(null)
      setStage('CAE batch 등록')
      setBatch(null)
      const { signal } = run.controller
      const initialSelectionId = latest.current.selection.measurement?.id ?? null
      const calculated = new Set<number>()
      let calculationFailed = 0
      let calculationCompleted = 0
      let completion: SaveAndRunCompletion | null = null
      return (async () => {
        const resume = async (execution: CaeMeasurementExecution, allowRetry: boolean) => {
          const job = execution.job
          if (!job || !execution.batch_id || execution.experiment_id !== request.experiment_id)
            throw new Error('Measurement의 기존 CAE 작업을 찾을 수 없습니다.')
          run.batchId = execution.batch_id
          run.jobId = job.id
          run.jobAttempt = job.attempt_count
          if (allowRetry && ['failed', 'cancelled'].includes(job.state)) {
            if (job.cleanup_pending) throw new Error('worker 정리 대기 중입니다. 정리가 끝난 후 다시 실행하세요.')
            setStage('선택 작업 재시도')
            try {
              update(await caeBatches.retry(execution.batch_id, [job.id]))
            } catch (cause) {
              // Another tab may have retried first. Join its attempt, never create another job.
              if (!(cause instanceof ApiError) || cause.status !== 409) throw cause
              const current = await caeBatches.execution(execution.measurement_id, { signal })
              if (!current.job || current.job.id !== job.id || current.job.attempt_count <= job.attempt_count)
                throw cause
            }
            if (run.cancelRequested) await caeBatches.cancel(execution.batch_id, [job.id])
            signal.throwIfAborted()
            const current = await caeBatches.execution(execution.measurement_id, { signal })
            if (!current.job || current.job.id !== job.id) throw new Error('Measurement의 실행 연결이 변경됐습니다.')
            run.jobAttempt = current.job.attempt_count
          }
          return readPage(execution.batch_id, {}, true)
        }
        let registered: CaeBatch | undefined
        if (request.measurement_id) {
          const execution = await caeBatches.execution(request.measurement_id, { signal })
          signal.throwIfAborted()
          if (execution.recorded_at) throw new Error('이미 기록이 완료된 Measurement입니다.')
          if (execution.job) registered = await resume(execution, true)
        }
        if (!registered) {
          const built = await buildBatchArtifact(request, signal, (completed, total) =>
            setStage(`입력 준비 ${completed}/${total}`),
          )
          try {
            registered = await submitArtifact({
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
              onProgress: (completed, total) => setStage(`업로드 ${completed}/${total}`),
            })
          } catch (cause) {
            const detail =
              cause instanceof ApiError
                ? (cause.body as { detail?: { batch_id?: string; job_id?: string } })?.detail
                : undefined
            if (
              !request.measurement_id ||
              !(cause instanceof ApiError) ||
              cause.status !== 409 ||
              !detail?.batch_id ||
              !detail.job_id
            )
              throw cause
            // A competing submission won the commit. Release this staged upload, then observe the winner.
            if (run.batchId && run.batchId !== detail.batch_id) await caeBatches.cancel(run.batchId)
            signal.throwIfAborted()
            const execution = await caeBatches.execution(request.measurement_id, { signal })
            registered = await resume(execution, false)
          } finally {
            built.store.close()
          }
        }
        run.batchId = registered.id
        if (run.cancelRequested) await caeBatches.cancel(registered.id, run.jobId ? [run.jobId] : undefined)
        signal.throwIfAborted()
        let observed = update(registered)
        let detail = registered
        while (true) {
          signal.throwIfAborted()
          let snapshot: CaeBatch
          if (run.jobId && request.measurement_id) {
            const execution = await caeBatches.execution(request.measurement_id, { signal })
            signal.throwIfAborted()
            const job = execution.job
            if (!job || job.id !== run.jobId || job.attempt_count !== run.jobAttempt)
              throw new Error('선택 작업의 실행 시도가 변경됐습니다. 현재 상태를 확인하세요.')
            const terminal = ['succeeded', 'failed', 'cancelled'].includes(job.state)
            // Local progress is scoped to this job. The provider retains the real batch totals.
            snapshot = {
              ...observed,
              mode: 'measurement',
              jobs: [job],
              jobs_total: 1,
              total: 1,
              created_count: 1,
              succeeded: Number(job.state === 'succeeded'),
              failed: Number(job.state === 'failed'),
              cancelled: Number(job.state === 'cancelled'),
              state: job.state === 'cancelled' ? 'cancelled' : terminal ? 'completed' : 'running',
              finished_at: terminal ? job.updated_at : null,
            }
          } else {
            if (detail.last_event_id < observed.last_event_id) {
              detail = await readPage(observed.id)
              signal.throwIfAborted()
            }
            snapshot = detail
          }
          onBatchState?.(snapshot)
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
          onBatchProgress?.({
            batchId: snapshot.id,
            total: snapshot.total,
            succeeded: snapshot.succeeded,
            failed: snapshot.failed,
            cancelled: snapshot.cancelled,
            calculationFailed,
            calculated: calculationCompleted,
          })
          setStage(
            `${snapshot.succeeded + snapshot.failed + snapshot.cancelled}/${snapshot.total} · CAE ${snapshot.state} · 성공 ${snapshot.succeeded} · 실패 ${snapshot.failed} · 취소 ${snapshot.cancelled}`,
          )
          for (const measurementId of run.completed) {
            run.completed.delete(measurementId)
            if (calculated.has(measurementId)) continue
            calculated.add(measurementId)
            await invalidateMeasurementMutation(queryClient, queryScope, request.experiment_id, [measurementId])
            signal.throwIfAborted()
            onRecorded?.(measurementId)
            const current = latest.current
            const selectedId = current.selection.measurement?.id ?? null
            if (
              !request.candidates &&
              current.experimentId === request.experiment_id &&
              (selectedId === measurementId || (completion === null && selectedId === initialSelectionId))
            )
              await current.selection
                .loadMeasurement(measurementId, request.experiment_id, { expectedSelectionId: selectedId })
                .catch(() => null)
            signal.throwIfAborted()
            setAutomaticCalculationData(true)
            try {
              const calculationSummary = await current.calculationDataActions.calculateMeasurement(measurementId, {
                onProgress: (progress) => {
                  if (!signal.aborted) setStage(`${progress.stage} · ${progress.completed}/${progress.total}`)
                },
              })
              signal.throwIfAborted()
              setAutomaticCalculationData(false)
              completion = { attemptId, measurementId: measurementId, recordedDataSaved: true, calculationSummary }
              calculationCompleted += 1
              if (calculationSummary.failed || calculationSummary.cancelled) calculationFailed += 1
              if (calculationSummary.failed) {
                const message = `Measurement #${measurementId}: CalculationData ${calculationSummary.failed}개 실패`
                setError(message)
                latest.current.onActivity?.({ source: 'calculation', level: 'warning', message })
              }
            } catch (cause) {
              signal.throwIfAborted()
              if (!request.candidates) throw cause
              calculationCompleted += 1
              calculationFailed += 1
              const message = `Measurement #${measurementId}: CalculationData 실패 · ${cause instanceof Error ? cause.message : String(cause)}`
              setError(message)
              latest.current.onActivity?.({ source: 'calculation', level: 'warning', message })
            } finally {
              if (!signal.aborted) setAutomaticCalculationData(false)
            }
            onBatchProgress?.({
              batchId: snapshot.id,
              total: snapshot.total,
              succeeded: snapshot.succeeded,
              failed: snapshot.failed,
              cancelled: snapshot.cancelled,
              calculationFailed,
              calculated: calculationCompleted,
            })
          }
          if (snapshot.finished_at || snapshot.state === 'completed' || snapshot.state === 'cancelled') {
            if (snapshot.state === 'cancelled') throw new DOMException('CAE batch를 취소했습니다.', 'AbortError')
            if (request.mode !== 'generate' && !request.candidates && !completion)
              throw new Error(jobs.find((job) => job.last_error)?.last_error ?? 'CAE 작업이 완료되지 않았습니다.')
            return completion
          }
          observed = await waitForChange(registered.id, observed, signal)
        }
      })().finally(() => {
        if (active.current !== run) return
        active.current = null
        setOperation(null)
        setStage(null)
        setBatch(null)
        setAutomaticCalculationData(false)
      })
    },
    [operation, queryClient, queryScope, update, readPage, waitForChange],
  )
  const reportFailure = useCallback((cause: unknown) => {
    if ((cause as { name?: string })?.name === 'AbortError') return
    const message = cause instanceof Error ? cause.message : 'CAE 작업을 시작하지 못했습니다.'
    setError(message)
    latest.current.onActivity?.({ source: 'cae', level: 'error', message })
  }, [])
  const runReviewed = useCallback(
    async (
      input: ReviewedMeasurementInput,
      onProgress?: (progress: ReviewedMeasurementProgress) => void,
      onRecorded?: (measurementId: number) => void,
    ) => {
      const identity = requireExperiment()
      const completion = await submit(
        {
          ...identity,
          request_id: crypto.randomUUID(),
          mode: input.measurementId ? 'measurement' : 'candidate',
          measurement_id: input.measurementId,
          vars: input.vars,
          material_snapshot: input.materialSnapshot,
          evaluation_timeout_ms: experimentDocument.evaluationTimeoutMs,
        },
        input.measurementId ? 'measurement' : 'save-and-run',
        undefined,
        (batch) => {
          const job = batch.jobs[0]
          if (job) onProgress?.({ measurementId: job.measurement_id, state: job.state, error: job.last_error })
        },
        onRecorded,
      )
      if (!completion) throw new Error('CAE 결과를 찾을 수 없습니다.')
      return { ...completion, candidateId: input.candidateId }
    },
    [experimentDocument.evaluationTimeoutMs, requireExperiment, submit],
  )
  const saveAndRunCurrentAsync = useCallback(async (): Promise<SaveAndRunCompletion> => {
    const candidate = experimentDocument.ensureFullEvaluation ? await prepareCandidate() : requireCandidate()
    const result = await submit(
      {
        ...candidate,
        request_id: crypto.randomUUID(),
        mode: 'candidate',
        evaluation_timeout_ms: experimentDocument.evaluationTimeoutMs,
      },
      'save-and-run',
    )
    if (!result) throw new Error('CAE 결과를 찾을 수 없습니다.')
    return result
  }, [
    experimentDocument.evaluationTimeoutMs,
    experimentDocument.ensureFullEvaluation,
    prepareCandidate,
    requireCandidate,
    submit,
  ])
  const saveAndRunCurrent = useCallback(() => {
    void saveAndRunCurrentAsync().catch(reportFailure)
  }, [reportFailure, saveAndRunCurrentAsync])
  const runCandidatesAsync = useCallback(
    async (
      candidates: BrowserBatchCandidates,
      onProgress: (progress: CandidateBatchProgress) => void,
    ): Promise<CandidateBatchProgress> => {
      let summary: CandidateBatchProgress | null = null
      await submit(
        {
          ...requireExperiment(),
          request_id: crypto.randomUUID(),
          mode: 'candidate',
          candidates,
          evaluation_timeout_ms: experimentDocument.evaluationTimeoutMs,
        },
        'save-and-run',
        (progress) => {
          summary = progress
          onProgress(progress)
        },
      )
      if (!summary) throw new Error('CAE Batch 결과를 찾을 수 없습니다.')
      return summary
    },
    [experimentDocument.evaluationTimeoutMs, requireExperiment, submit],
  )
  const runSelected = useCallback(() => {
    try {
      const identity = requireExperiment()
      const selected = selection.measurement
      if (!selected || selected.recorded_at || selected.experiment_id !== identity.experiment_id)
        throw new Error('현재 Experiment의 Prepared Measurement를 선택하세요.')
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
  }, [experimentDocument.evaluationTimeoutMs, reportFailure, requireExperiment, selection.measurement, submit])
  const repeatGenerateAndRun = useCallback(
    (count: number) => {
      try {
        if (!Number.isSafeInteger(count) || count < 1) throw new Error('반복 횟수는 양의 정수여야 합니다.')
        const schema = experimentDocument.varsSchema
        if (!schema) throw new Error('Vars schema 평가가 완료되지 않았습니다.')
        void submit(
          {
            ...requireExperiment(),
            request_id: crypto.randomUUID(),
            mode: 'candidate',
            candidates: {
              count,
              algorithm: 'monte-carlo',
              accepted: async () => {},
              next: async (_attempt, signal) => {
                signal.throwIfAborted()
                return generateRandomVars(schema)
              },
              failed: (attempt, cause) =>
                latest.current.onActivity?.({
                  source: 'cae',
                  level: 'error',
                  message: `[Monte Carlo ${attempt}/${count}] 입력 준비 실패 · ${cause instanceof Error ? cause.message : String(cause)}`,
                }),
            },
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
    [experimentDocument.evaluationTimeoutMs, experimentDocument.varsSchema, reportFailure, requireExperiment, submit],
  )
  const generateAndRun = useCallback(() => {
    try {
      void submit(
        {
          ...requireExperiment(),
          request_id: crypto.randomUUID(),
          mode: 'generate',
          count: 1,
          evaluation_timeout_ms: experimentDocument.evaluationTimeoutMs,
        },
        'generate-and-run',
      ).catch(reportFailure)
      return true
    } catch (cause) {
      reportFailure(cause)
      return false
    }
  }, [experimentDocument.evaluationTimeoutMs, reportFailure, requireExperiment, submit])
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
      const candidate = experimentDocument.ensureFullEvaluation ? await prepareCandidate() : requireCandidate()
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
  }, [
    operation,
    queryClient,
    queryScope,
    reportFailure,
    requireCandidate,
    prepareCandidate,
    experimentDocument.ensureFullEvaluation,
  ])
  const deleteMeasurements = useCallback(
    async (rows: readonly SavedMeasurement[]) => {
      if (operation || active.current) return false
      setOperation('delete')
      setError(null)
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
    candidatePreparation.current?.abort()
    if (!run) {
      detach()
      return
    }
    run.cancelRequested = true
    if (run.batchId)
      void caeBatches
        .cancel(run.batchId, run.jobId ? [run.jobId] : undefined)
        .then(update)
        .catch(reportFailure)
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
      batch?.mode === 'generate' || (operation === 'generate-and-run' && samplingTotal !== null)
        ? {
            attempt: batch ? batch.succeeded + batch.failed + batch.cancelled : 0,
            failures: batch?.failed ?? 0,
            repeat: samplingTotal !== null,
            successes: batch?.succeeded ?? 0,
            total: batch?.total ?? samplingTotal ?? 1,
          }
        : null,
    generateCandidate,
    operation,
    repeatGenerateAndRun,
    runSelected,
    runCandidatesAsync,
    runReviewed,
    saveAndRunCurrent,
    saveAndRunCurrentAsync,
    saveCurrent,
    stage,
  }
}
