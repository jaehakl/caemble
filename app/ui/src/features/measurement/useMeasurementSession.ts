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
import type { ReviewedMeasurementProgress } from './useCaeMeasurementActions'
import type { VarsPoint } from './measurementSpace'

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
}: {
  workbench: CaeWorkbenchState
  authenticated: boolean
  dataReadable: boolean
  active: boolean
  externalBusy?: boolean
  onActivity?: RuntimeActivityCallback
  onCandidateSelected?: (vars: Readonly<Vars>) => void
  onMeasurementSelected?: (row: SavedMeasurement) => Promise<unknown>
}) {
  const queryScope = usePrivateQueryScope()
  const [vars, setVars] = useState<Readonly<Vars> | null>(
    workbench.candidateVars ?? workbench.selection.variables ?? workbench.experimentDocument.variables,
  )
  const [evaluatedVars, setEvaluatedVars] = useState(vars)
  const [currentId, setCurrentId] = useState('draft')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [valid, setValid] = useState(true)
  const [error, setError] = useState('')
  const [operation, setOperation] = useState<string | null>(null)
  const [previewFrame, setPreviewFrame] = useState<PreviewFrame | null>(null)
  const [recordedDocuments, setRecordedDocuments] = useState<Record<number, CadDocumentController>>({})
  const singleRunController = useRef<AbortController | null>(null)
  const [execution, setExecution] = useState<Record<string, ReviewedMeasurementProgress>>({})
  const callbacks = useRef({ onCandidateSelected, onMeasurementSelected })
  callbacks.current = { onCandidateSelected, onMeasurementSelected }
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
  const selectedMeasurements = measurements.filter((row) => selected.has(`measurement:${row.id}`))
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
    () => measurements.map((row) => ({ id: `measurement:${row.id}`, vars: row.vars as Vars })),
    [measurements],
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
      if (singleRunController.current) {
        singleRunController.current.abort()
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
    setSelected(new Set())
    setCurrentId('draft')
    setExecution({})
    setValid(true)
    setError('')
    setPreviewFrame(null)
    setRecordedDocuments({})
    setOperation(null)
    actualRef.current.clearMeasurement()
    return () => {
      selectionSequence.current += 1
      if (singleRunController.current) {
        singleRunController.current.abort()
        latest.current.measurementActions.cancel()
        singleRunController.current = null
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
    [actual, measurements, valid, externalBusy, publishCandidate, publishMeasurement],
  )

  const deleteSelectedMeasurements = async () => {
    if (!canDeleteMeasurements) return
    const recordedCount = selectedMeasurements.filter((row) => row.recorded_at).length
    if (
      !window.confirm(
        `선택한 Measurement ${selectedMeasurements.length.toLocaleString()}개를 영구 삭제할까요?\n${selectedMeasurements.map((row) => `#${row.id}`).join(', ')}\nRecorded Measurement ${recordedCount.toLocaleString()}개에 연결된 RecordedData도 함께 삭제됩니다.${workbench.experimentIsDemo ? '\n공개 Demo 데이터에 즉시 반영되며 Prediction이 Not Ready가 될 수 있습니다.' : ''}`,
      )
    )
      return
    const session = workbench.workspaceSession
    const experimentId = workbench.experimentId
    const deletedIds = new Set(selectedMeasurements.map((row) => row.id))
    const removedPoints = new Set(selectedMeasurements.map((row) => `measurement:${row.id}`))
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
  const run = async () => {
    if (!persistable || !ready || !valid || busy || !vars || singleRunController.current) return
    const row = measurements.find((item) => `measurement:${item.id}` === currentId)
    if (row?.recorded_at) {
      setError('Recorded Measurement는 다시 실행할 수 없습니다.')
      return
    }
    if (currentId !== 'draft' && !row) return
    const controller = new AbortController()
    singleRunController.current = controller
    const { signal } = controller
    const sequence = ++selectionSequence.current
    const frame: PreviewFrame = {
      candidateId: currentId,
      document: { ...document, handleRenderStart: () => {}, handleRenderEnd: () => {}, handleRenderError: () => {} },
      vars: structuredClone(vars),
      data: forward.data,
      rules: forward.model?.rules,
      error: forward.error,
    }
    setPreviewFrame(frame)
    setOperation('실행 중')
    setError('')
    let recordedId: number | null = null
    let loading: Promise<void> | null = null
    const onRecorded = (id: number) => {
      if (signal.aborted || loading) return
      recordedId = id
      if (selectionSequence.current !== sequence) return
      setCurrentId(`measurement:${id}`)
      setSelected(new Set([`measurement:${id}`]))
      setRecordedDocuments({ [id]: frame.document })
      loading = actual
        .loadMeasurement(id, workbench.experimentId, { signal })
        .then(async (loaded) => {
          if (loaded && !signal.aborted && selectionSequence.current === sequence) await publishMeasurement(loaded)
        })
        .catch((cause: unknown) => {
          if (!signal.aborted && selectionSequence.current === sequence)
            setError(cause instanceof Error ? cause.message : String(cause))
        })
    }
    try {
      const completion = await workbench.measurementActions.runReviewed(
        {
          candidateId: currentId,
          vars: frame.vars,
          measurementId: row?.id,
          materialSnapshot: row?.material_snapshot ?? document.materialSnapshot ?? undefined,
        },
        (progress) => {
          if (signal.aborted) return
          if (progress.state === 'succeeded') recordedId = progress.measurementId
          setExecution({ [currentId]: progress })
        },
        onRecorded,
      )
      onRecorded(completion.measurementId)
    } catch (cause) {
      if (!signal.aborted) {
        if (recordedId) onRecorded(recordedId)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      await loading
      if (singleRunController.current === controller) {
        singleRunController.current = null
        if (mounted.current) {
          setOperation(null)
          void query.refetch()
        }
      }
    }
  }

  const cancel = () => {
    singleRunController.current?.abort()
    latest.current.measurementActions.cancel()
  }
  return {
    vars,
    currentId,
    selected,
    valid,
    error,
    operation,
    previewFrame,
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
    setValid,
    setPreviewFrame,
    changeVars,
    selectPoint,
    deleteSelectedMeasurements,
    run,
    cancel,
    running: operation === '실행 중',
    invalidateSelection: () => {
      selectionSequence.current += 1
      setPreviewFrame(null)
    },
  }
}
export type MeasurementSession = ReturnType<typeof useMeasurementSession>
