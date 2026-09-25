import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getListRequest } from '@/api'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { SavedMeasurement } from '@/features/cae-workbench/types'
import { useCadWorkspace, type CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import type { RecordedData, RecordedDataRule, Vars } from '@/lib/cad/model'
import { varsFingerprint, varsSchemaFingerprint } from '@/lib/cad/model/vars'
import { measurementsQueryOptions } from './queryOptions'
import { useCaeDataSelection } from './useCaeDataSelection'
import { useMeasurementForward } from './useMeasurementForward'
import type { ReviewedMeasurementInput, ReviewedMeasurementProgress } from './useCaeMeasurementActions'
import type { MeasurementCandidatePreparationRequest } from './MeasurementCandidatePreparation'
import { sampleMeasurementVars, type VarsPoint } from './measurementSpace'

export type MeasurementCandidate = VarsPoint & {
  state: 'candidate' | 'running' | 'failed' | 'cancelled'
  error?: string
  measurementId?: number
}
type PreviewFrame = {
  candidateId: string
  document: CadDocumentController
  vars: Readonly<Vars>
  data?: RecordedData
  rules?: readonly RecordedDataRule[]
  error: string
}
export function useMeasurementSession({
  workbench,
  authenticated,
  dataReadable,
  active,
  externalBusy = false,
  onCandidateSelected,
  onMeasurementSelected,
  onActivity,
  onGenerated,
}: {
  workbench: CaeWorkbenchState
  authenticated: boolean
  dataReadable: boolean
  active: boolean
  externalBusy?: boolean
  onActivity?: RuntimeActivityCallback
  onGenerated?: () => void
  onCandidateSelected?: (vars: Readonly<Vars>) => void
  onMeasurementSelected?: (row: SavedMeasurement) => Promise<unknown>
}) {
  const queryScope = usePrivateQueryScope()
  const [vars, setVars] = useState<Readonly<Vars> | null>(
    workbench.candidateVars ?? workbench.selection.variables ?? workbench.experimentDocument.variables,
  )
  const [evaluatedVars, setEvaluatedVars] = useState(vars)
  const [candidates, setCandidates] = useState<MeasurementCandidate[]>([])
  const [currentId, setCurrentId] = useState('draft')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [valid, setValid] = useState(true)
  const [count, setCount] = useState('10')
  const [algorithm, setAlgorithm] = useState<'random' | 'empty-lhs'>('random')
  const [error, setError] = useState('')
  const [operation, setOperation] = useState<string | null>(null)
  const [previewFrame, setPreviewFrame] = useState<PreviewFrame | null>(null)
  const [preparation, setPreparation] = useState<MeasurementCandidatePreparationRequest | null>(null)
  const [recordedDocuments, setRecordedDocuments] = useState<Record<number, CadDocumentController>>({})
  const batchController = useRef<AbortController | null>(null)
  const [execution, setExecution] = useState<Record<string, ReviewedMeasurementProgress>>({})
  const callbacks = useRef({ onCandidateSelected, onMeasurementSelected, onGenerated })
  callbacks.current = { onCandidateSelected, onMeasurementSelected, onGenerated }
  const selectionSequence = useRef(0)
  const workbenchSelectionKey = `${workbench.selection.measurement?.id ?? ''}:${varsFingerprint(workbench.candidateVars ?? workbench.selection.variables ?? null)}`
  const observedSelection = useRef<string | null>(null)
  const publishedSelection = useRef<string | null>(null)
  const publishCandidate = useCallback((value: Readonly<Vars>) => {
    publishedSelection.current = `:${varsFingerprint(value)}`
    callbacks.current.onCandidateSelected?.(value)
  }, [])
  const publishMeasurement = useCallback(async (row: SavedMeasurement) => {
    publishedSelection.current = `${row.id}:${varsFingerprint(row.vars as Vars)}`
    await callbacks.current.onMeasurementSelected?.(row)
  }, [])
  const mounted = useRef(true)
  const latest = useRef(workbench)
  latest.current = workbench
  const actual = useCaeDataSelection(workbench.experimentId, 'visible')
  const actualRef = useRef(actual)
  actualRef.current = actual
  const { loadMeasurement: loadActualMeasurement } = actual
  const { experimentDocument: editableDocument } = useCadWorkspace(
    previewFrame ? null : workbench.experiment,
    undefined,
    {
      candidateVars: evaluatedVars ?? undefined,
      resetKey: workbench.workspaceSession,
      onActivity,
    },
  )
  const document = previewFrame?.document ?? editableDocument
  const schema = document.varsSchema ?? workbench.experimentDocument.varsSchema
  const schemaKey = schema ? varsSchemaFingerprint(schema) : ''
  const sourceHash = workbench.experimentRecord?.source_hash ?? ''
  const sessionKey = `${queryScope}:${workbench.workspaceSession}:${workbench.experimentId}:${JSON.stringify(workbench.experiment?.sourceBundle)}`
  const contextKey = `${sessionKey}:${sourceHash}:${schemaKey}`
  const query = useQuery({
    ...measurementsQueryOptions(queryScope, workbench.experimentId, {
      ...getListRequest('visible'),
      filter: { experiment_id: [workbench.experimentId, workbench.experimentId] },
      limit: null,
      sort: ['id', 'asc'],
    }),
    enabled: dataReadable && workbench.experimentId !== null,
    refetchOnWindowFocus: active,
  })
  const measurements = useMemo(() => (query.data?.items ?? []) as SavedMeasurement[], [query.data?.items])
  const currentKey = varsFingerprint(vars)
  const ready =
    (document.status === 'Ready' || document.status === 'Rendering') &&
    document.successfulRevision === document.revision &&
    varsFingerprint(document.variables) === currentKey &&
    document.materialSnapshot !== null
  const busy =
    externalBusy || operation !== null || workbench.measurementActions.busy || workbench.calculationDataActions.busy
  const persistable =
    authenticated && workbench.experimentClean && workbench.experimentManageable && !document.draftTaskNames.length
  const selectedMeasurements = measurements.filter(
    (row) =>
      selected.has(`measurement:${row.id}`) ||
      candidates.some((candidate) => selected.has(candidate.id) && candidate.measurementId === row.id),
  )
  const canDeleteMeasurements =
    authenticated && workbench.experimentManageable && selectedMeasurements.length > 0 && !busy
  const forward = useMeasurementForward({
    experimentId: workbench.experimentId,
    contextKey,
    document,
    measurements,
    vars,
    ready,
    active: active && !operation && !previewFrame,
    onActivity,
  })
  const points = useMemo<VarsPoint[]>(
    () => [...measurements.map((row) => ({ id: `measurement:${row.id}`, vars: row.vars as Vars })), ...candidates],
    [measurements, candidates],
  )
  useEffect(() => {
    const timer = window.setTimeout(() => setEvaluatedVars(vars), 180)
    return () => clearTimeout(timer)
  }, [vars])
  useEffect(() => {
    if (!vars && document.variables) {
      setVars(document.variables)
      setEvaluatedVars(document.variables)
    }
  }, [vars, document.variables])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (batchController.current) {
        batchController.current.abort()
        latest.current.measurementActions.cancel()
      }
    }
  }, [])
  useLayoutEffect(() => {
    const current = latest.current
    selectionSequence.current += 1
    observedSelection.current = null
    publishedSelection.current = null
    const initialVars = current.candidateVars ?? current.selection.variables ?? current.experimentDocument.variables
    setVars(initialVars)
    setEvaluatedVars(initialVars)
    setCandidates([])
    setSelected(new Set())
    setCurrentId('draft')
    setExecution({})
    setValid(true)
    setError('')
    setPreviewFrame(null)
    setRecordedDocuments({})
    setPreparation(null)
    setOperation(null)
    actualRef.current.clearMeasurement()
    return () => {
      selectionSequence.current += 1
      if (batchController.current) {
        batchController.current.abort()
        latest.current.measurementActions.cancel()
        batchController.current = null
      }
    }
  }, [sessionKey])
  useEffect(() => {
    if (observedSelection.current === workbenchSelectionKey) return
    observedSelection.current = workbenchSelectionKey
    if (publishedSelection.current === workbenchSelectionKey) return
    const sequence = ++selectionSequence.current
    setPreviewFrame(null)
    const current = latest.current
    const value = current.candidateVars ?? current.selection.variables ?? current.experimentDocument.variables
    setVars(value)
    setEvaluatedVars(value)
    const row = current.selection.measurement
    setCurrentId(row ? `measurement:${row.id}` : 'draft')
    setSelected(row ? new Set([`measurement:${row.id}`]) : new Set())
    if (row) {
      void loadActualMeasurement(row).catch((cause: unknown) => {
        if (mounted.current && sequence === selectionSequence.current)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
    } else actualRef.current.clearMeasurement()
  }, [workbenchSelectionKey, loadActualMeasurement, sessionKey])
  const changeVars = useCallback(
    (next: Vars) => {
      setPreviewFrame(null)
      selectionSequence.current += 1
      setVars(next)
      setError('')
      setCurrentId('draft')
      setSelected(new Set())
      publishCandidate(next)
    },
    [publishCandidate],
  )
  const selectPoint = useCallback(
    async (id: string, additive: boolean, draftVars?: Readonly<Vars>) => {
      if (!valid || externalBusy) return
      setPreviewFrame(null)
      const sequence = ++selectionSequence.current
      setSelected((ids) => {
        const next = additive ? new Set(ids) : new Set<string>()
        if (additive && next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setError('')
      if (id === 'draft') {
        if (draftVars) {
          setVars(draftVars)
          publishCandidate(draftVars)
        }
        setCurrentId(id)
        return
      }
      const candidate = candidates.find((row) => row.id === id)
      if (candidate) {
        setVars(candidate.vars)
        setCurrentId(id)
        publishCandidate(candidate.vars)
        return
      }
      const row = measurements.find((row) => `measurement:${row.id}` === id)
      if (!row) return
      setVars(row.vars as Vars)
      setCurrentId(id)
      try {
        const loaded = await actual.loadMeasurement(row)
        if (loaded && sequence === selectionSequence.current) await publishMeasurement(loaded)
      } catch (cause) {
        if (sequence === selectionSequence.current) setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [actual, candidates, measurements, valid, externalBusy, publishCandidate, publishMeasurement],
  )

  const generate = () => {
    if (!schema || !valid || busy || query.isFetching) return
    setPreviewFrame(null)
    selectionSequence.current += 1
    try {
      const existing = points.map((point) => point.vars)
      if (vars && currentId === 'draft') existing.push(vars)
      const generated = sampleMeasurementVars(schema, existing, Number(count), algorithm).map(
        (value): MeasurementCandidate => ({
          id: `candidate:${crypto.randomUUID()}`,
          vars: value,
          state: 'candidate',
        }),
      )
      setCandidates((rows) => [...rows, ...generated])
      setVars(generated[0].vars)
      setCurrentId(generated[0].id)
      setSelected(new Set(generated.map((point) => point.id)))
      publishCandidate(generated[0].vars)
      callbacks.current.onGenerated?.()
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const addCandidate = () => {
    if (!vars || !valid || busy) return
    selectionSequence.current += 1
    if (points.some((point) => varsFingerprint(point.vars) === currentKey)) {
      setError('동일한 Vars의 점이 이미 있습니다.')
      return
    }
    const candidate: MeasurementCandidate = { id: `candidate:${crypto.randomUUID()}`, vars, state: 'candidate' }
    setCandidates((rows) => [...rows, candidate])
    setCurrentId(candidate.id)
    setSelected(new Set([candidate.id]))
    publishCandidate(candidate.vars)
    callbacks.current.onGenerated?.()
  }
  const deleteSelectedMeasurements = async () => {
    if (!canDeleteMeasurements) return
    const recordedCount = selectedMeasurements.filter((row) => row.recorded_at).length
    if (
      !window.confirm(
        `선택한 Measurement ${selectedMeasurements.length.toLocaleString()}개를 영구 삭제할까요?\n${selectedMeasurements.map((row) => `#${row.id}`).join(', ')}\nRecorded Measurement ${recordedCount.toLocaleString()}개에 연결된 RecordedData도 함께 삭제됩니다.\n연결된 임시 후보도 함께 제거됩니다.${workbench.experimentIsDemo ? '\n공개 Demo 데이터에 즉시 반영되며 Prediction이 Not Ready가 될 수 있습니다.' : ''}`,
      )
    )
      return
    const session = workbench.workspaceSession
    const experimentId = workbench.experimentId
    const deletedIds = new Set(selectedMeasurements.map((row) => row.id))
    const removedPoints = new Set([
      ...selectedMeasurements.map((row) => `measurement:${row.id}`),
      ...candidates.filter((row) => row.measurementId && deletedIds.has(row.measurementId)).map((row) => row.id),
    ])
    setOperation('삭제 중')
    setError('')
    try {
      const deleted = await workbench.measurementActions.deleteMeasurements(selectedMeasurements)
      if (
        !mounted.current ||
        latest.current.workspaceSession !== session ||
        latest.current.experimentId !== experimentId
      )
        return
      if (!deleted) return
      selectionSequence.current += 1
      setCandidates((rows) => rows.filter((row) => !removedPoints.has(row.id)))
      setExecution((states) =>
        Object.fromEntries(
          Object.entries(states).filter(
            ([id, progress]) => !removedPoints.has(id) && !deletedIds.has(progress.measurementId ?? -1),
          ),
        ),
      )
      setSelected((ids) => new Set([...ids].filter((id) => !removedPoints.has(id))))
      setCurrentId((id) => (removedPoints.has(id) ? 'draft' : id))
      setPreviewFrame((frame) => (frame && removedPoints.has(frame.candidateId) ? null : frame))
      setRecordedDocuments((documents) =>
        Object.fromEntries(Object.entries(documents).filter(([id]) => !deletedIds.has(Number(id)))),
      )
      if (
        deletedIds.has(actualRef.current.measurement?.id ?? -1) ||
        (actualRef.current.loading && removedPoints.has(currentId))
      )
        actualRef.current.clearMeasurement()
      await query.refetch()
    } catch (cause) {
      if (
        mounted.current &&
        latest.current.workspaceSession === session &&
        latest.current.experimentId === experimentId
      )
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (
        mounted.current &&
        latest.current.workspaceSession === session &&
        latest.current.experimentId === experimentId
      )
        setOperation(null)
    }
  }
  const run = async (all: boolean) => {
    if (!persistable || !ready || !valid || busy || !vars || batchController.current) return
    const ids = all
      ? candidates.filter((row) => row.state !== 'running').map((row) => row.id)
      : selected.size
        ? [...selected]
        : [currentId]
    if (all && currentId === 'draft') ids.push('draft')
    const queue = ids.flatMap((id) => {
      const candidate = candidates.find((row) => row.id === id)
      const row = measurements.find((row) => `measurement:${row.id}` === id || row.id === candidate?.measurementId)
      if (row?.recorded_at || (!row && !candidate && id !== 'draft')) return []
      return [
        {
          candidateId: id,
          vars: structuredClone(row ? (row.vars as Vars) : (candidate?.vars ?? vars)),
          measurementId: row?.id ?? candidate?.measurementId,
          materialSnapshot:
            row?.material_snapshot ?? (id === currentId ? (document.materialSnapshot ?? undefined) : undefined),
        },
      ]
    })
    if (!queue.length) {
      setError('실행할 후보 또는 Prepared Measurement를 선택하세요.')
      return
    }
    const controller = new AbortController()
    const runSelection = ++selectionSequence.current
    batchController.current = controller
    const { signal } = controller
    // Freeze the current view before starting any background work.
    setPreviewFrame(
      (frame) =>
        frame ?? {
          candidateId: currentId,
          document: {
            ...document,
            handleRenderStart: () => {},
            handleRenderEnd: () => {},
            handleRenderError: () => {},
          },
          vars,
          data: forward.data,
          rules: forward.model?.rules,
          error: forward.error,
        },
    )
    setOperation(`실행 0/${queue.length}`)
    setError('')
    const evaluate = (input: ReviewedMeasurementInput) =>
      new Promise<CadDocumentController>((resolve, reject) => {
        signal.throwIfAborted()
        const finish = (candidate?: CadDocumentController, cause?: unknown) => {
          signal.removeEventListener('abort', abort)
          if (mounted.current) setPreparation((current) => (current === request ? null : current))
          if (candidate) resolve(candidate)
          else reject(cause)
        }
        const abort = () => finish(undefined, signal.reason)
        const request: MeasurementCandidatePreparationRequest = {
          input,
          resolve: (candidate) => {
            if (varsFingerprint(candidate.variables) !== varsFingerprint(input.vars)) {
              finish(undefined, new Error('준비된 CAD의 Vars가 실행 후보와 다릅니다.'))
            } else finish(candidate)
          },
          reject: (cause) => finish(undefined, cause),
        }
        signal.addEventListener('abort', abort, { once: true })
        setPreparation(request)
      })
    type Prepared = { frame: PreviewFrame; cause?: never } | { frame?: never; cause: unknown }
    const displayPreview = (frame: PreviewFrame) => {
      if (signal.aborted || selectionSequence.current !== runSelection) return
      setPreviewFrame(frame)
      setVars(frame.vars)
      setEvaluatedVars(frame.vars)
      setCurrentId(frame.candidateId)
    }
    const prepare = (item: ReviewedMeasurementInput, model: ReturnType<typeof forward.prepare>): Promise<Prepared> =>
      Promise.all([evaluate(item), model])
        .then(async ([candidate, trained]) => {
          const prediction = await forward.predict(trained, candidate, item.vars, signal)
          signal.throwIfAborted()
          return { frame: { candidateId: item.candidateId, vars: item.vars, document: candidate, ...prediction } }
        })
        .catch((cause: unknown) => ({ cause }))
    let model = forward.prepare(document, signal)
    let pendingPreview = prepare(queue[0], model)
    try {
      for (let index = 0; index < queue.length; index++) {
        signal.throwIfAborted()
        const item = queue[index]
        let recordedId: number | null = null
        let recordedWork: Promise<unknown> | null = null
        let frame: PreviewFrame | undefined
        const onRecorded = (measurementId: number) => {
          if (signal.aborted || recordedWork || !frame) return
          recordedId = measurementId
          setCandidates((rows) => rows.filter((row) => row.id !== item.candidateId))
          if (selectionSequence.current === runSelection)
            setSelected((ids) => {
              const next = new Set(ids)
              next.delete(item.candidateId)
              next.add(`measurement:${measurementId}`)
              return next
            })
          setCurrentId((current) => (current === item.candidateId ? `measurement:${measurementId}` : current))
          setPreviewFrame((current) =>
            current?.candidateId === item.candidateId
              ? { ...current, candidateId: `measurement:${measurementId}` }
              : current,
          )
          const candidateDocument = frame.document
          setRecordedDocuments((documents) => {
            const displayedId = actualRef.current.measurement?.id
            return {
              ...(displayedId && documents[displayedId] ? { [displayedId]: documents[displayedId] } : {}),
              [measurementId]: candidateDocument,
            }
          })
          const loaded = (
            selectionSequence.current === runSelection
              ? actual.loadMeasurement(measurementId, workbench.experimentId, { signal }).then(async (row) => {
                  if (row && !signal.aborted && selectionSequence.current === runSelection)
                    await publishMeasurement(row)
                })
              : Promise.resolve()
          ).catch((cause: unknown) => {
            if (!signal.aborted)
              setError(`실제 결과 표시 실패: ${cause instanceof Error ? cause.message : String(cause)}`)
          })
          model = forward.prepare(candidateDocument, signal)
          if (queue[index + 1])
            pendingPreview = prepare(queue[index + 1], model).then((prepared) => {
              if (prepared.frame) displayPreview(prepared.frame)
              return prepared
            })
          // Attach a rejection handler immediately: this work overlaps CalculationData.
          recordedWork = Promise.all([loaded, model]).catch((cause: unknown) => {
            if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
          })
        }
        setOperation(`준비 ${index + 1}/${queue.length} · CAD / Forward`)
        try {
          setCandidates((rows) =>
            rows.map((row) => (row.id === item.candidateId ? { ...row, state: 'running', error: undefined } : row)),
          )
          const prepared = await pendingPreview
          signal.throwIfAborted()
          if (!prepared.frame) throw prepared.cause
          frame = prepared.frame
          displayPreview(frame)
          setOperation(`실행 ${index + 1}/${queue.length}`)
          const completion = await latest.current.measurementActions.runReviewed(
            { ...item, materialSnapshot: frame.document.materialSnapshot ?? item.materialSnapshot },
            (progress) => {
              if (signal.aborted) return
              if (progress.state === 'succeeded') recordedId = progress.measurementId
              setExecution((states) => ({ ...states, [item.candidateId]: progress }))
              if (progress.measurementId)
                setCandidates((rows) =>
                  rows.map((row) =>
                    row.id === item.candidateId ? { ...row, measurementId: progress.measurementId! } : row,
                  ),
                )
            },
            onRecorded,
          )
          onRecorded(completion.measurementId)
        } catch (cause) {
          if (signal.aborted) throw cause
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(`${item.candidateId}: ${message}`)
          if (recordedId) onRecorded(recordedId)
          else {
            setExecution((states) => ({
              ...states,
              [item.candidateId]: {
                measurementId: states[item.candidateId]?.measurementId ?? item.measurementId ?? null,
                state: 'failed',
                error: message,
              },
            }))
            setCandidates((rows) =>
              rows.map((row) => (row.id === item.candidateId ? { ...row, state: 'failed', error: message } : row)),
            )
          }
        }
        await recordedWork
        signal.throwIfAborted()
        if (!recordedId && queue[index + 1]) pendingPreview = prepare(queue[index + 1], model)
      }
    } catch (cause) {
      if (!signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (batchController.current === controller) {
        batchController.current = null
        if (mounted.current) {
          setCandidates((rows) => rows.map((row) => (row.state === 'running' ? { ...row, state: 'cancelled' } : row)))
          if (signal.aborted)
            setExecution((states) =>
              Object.fromEntries(
                Object.entries(states).map(([id, progress]) => [
                  id,
                  ['succeeded', 'failed', 'cancelled'].includes(progress.state)
                    ? progress
                    : { ...progress, state: 'cancelled' },
                ]),
              ),
            )
          setOperation(null)
          void query.refetch()
        }
      }
    }
  }

  const cancel = () => {
    batchController.current?.abort()
    latest.current.measurementActions.cancel()
  }
  return {
    vars,
    candidates,
    currentId,
    selected,
    valid,
    count,
    algorithm,
    error,
    operation,
    previewFrame,
    preparation,
    recordedDocuments,
    execution,
    actual,
    document,
    schema,
    schemaKey,
    query,
    measurements,
    currentKey,
    ready,
    busy,
    persistable,
    canDeleteMeasurements,
    forward,
    points,
    setCandidates,
    setCurrentId,
    setSelected,
    setValid,
    setCount,
    setAlgorithm,
    setPreviewFrame,
    changeVars,
    selectPoint,
    generate,
    addCandidate,
    deleteSelectedMeasurements,
    run,
    cancel,
    selectionDisabled: externalBusy || !valid,
    running: operation !== null && operation !== '저장 중' && operation !== '삭제 중',
    invalidateSelection: () => {
      selectionSequence.current += 1
      setPreviewFrame(null)
    },
  }
}
export type MeasurementSession = ReturnType<typeof useMeasurementSession>
