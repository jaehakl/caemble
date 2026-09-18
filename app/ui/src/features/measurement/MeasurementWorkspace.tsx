import { createComparisonCamera } from '@/features/viewer/viewer/comparisonCamera'
import { ComparisonToolbar } from '@/features/viewer/viewer/ComparisonToolbar'
import { WorkbenchRibbonGroup } from '@/features/cae-workbench/chrome/WorkbenchRibbon'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { dbTables, getListRequest } from '@/api'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { SavedMeasurement } from '@/features/cae-workbench/types'
import { WorkbenchViewer } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import { createComparisonSettings, type ViewerComparison } from '@/features/viewer/viewer/comparisonSettings'
import { visualizationData } from '@/features/viewer/viewer/visualizationData'
import { useCadWorkspace, type CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import type { RecordedData, RecordedDataRule, Vars } from '@/lib/cad/model'
import { varsFingerprint, varsSchemaFingerprint } from '@/lib/cad/model/vars'
import { materialVarsHash } from '@/lib/material/resolution'
import { createCadSourceDocument } from '@/lib/cad/source'
import { measurementsQueryOptions } from './queryOptions'
import { invalidateMeasurementMutation } from './queryInvalidation'
import { useCaeDataSelection } from './useCaeDataSelection'
import { useMeasurementForward } from './useMeasurementForward'
import type { ReviewedMeasurementInput, ReviewedMeasurementProgress } from './useCaeMeasurementActions'
import {
  MeasurementCandidatePreparation,
  type MeasurementCandidatePreparationRequest,
} from './MeasurementCandidatePreparation'
import { MeasurementSplit } from './MeasurementSplit'
import { MeasurementVarsEditor } from './MeasurementVarsEditor'
import { MeasurementPcaChart } from './MeasurementPcaChart'
import {
  projectSpace,
  sampleMeasurementVars,
  spaceValues,
  varsAtProjection,
  type MeasurementProjection,
  type VarsPoint,
} from './measurementSpace'

type Candidate = VarsPoint & {
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
const controlClass =
  'h-9 shrink-0 rounded-md border border-border bg-background px-3 text-xs font-medium shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45'

export function MeasurementWorkspace({
  workbench,
  authenticated,
  dataReadable,
  active,
  menubar,
  onActivity,
}: {
  workbench: CaeWorkbenchState
  authenticated: boolean
  dataReadable: boolean
  active: boolean
  menubar: ReactNode
  onActivity?: RuntimeActivityCallback
}) {
  const queryClient = useQueryClient()
  const queryScope = usePrivateQueryScope()
  const [vars, setVars] = useState<Readonly<Vars> | null>(
    workbench.candidateVars ?? workbench.selection.variables ?? workbench.experimentDocument.variables,
  )
  const [evaluatedVars, setEvaluatedVars] = useState(vars)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [currentId, setCurrentId] = useState('draft')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedVar, setSelectedVar] = useState<string | null>(null)
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
  const [selectedResult, setSelectedResult] = useState('')
  const [comparisonSettings] = useState(createComparisonSettings)
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null)
  const [camera] = useState(createComparisonCamera)
  const [pcaRevision, setPcaRevision] = useState(0)
  const [projection, setProjection] = useState<MeasurementProjection | null>(null)
  const [pcaError, setPcaError] = useState('')
  const [pcaBusy, setPcaBusy] = useState(false)
  const worker = useRef<Worker | null>(null)
  const pcaSequence = useRef(0)
  const selectionSequence = useRef(0)
  const initialSelectionApplied = useRef(false)
  const mounted = useRef(true)
  const latest = useRef(workbench)
  latest.current = workbench
  const actual = useCaeDataSelection(workbench.experimentId, 'visible')
  const actualRef = useRef(actual)
  actualRef.current = actual
  const { loadMeasurement: loadActualMeasurement } = actual
  const recordedSource = useMemo(
    () =>
      workbench.experimentRecord?.source_bundle
        ? createCadSourceDocument('experiment', workbench.experimentRecord.source_bundle)
        : workbench.experiment,
    [workbench.experimentRecord?.source_bundle, workbench.experiment],
  )
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
  const { experimentDocument: actualDocument } = useCadWorkspace(
    actual.measurement && !recordedDocuments[actual.measurement.id] ? recordedSource : null,
    undefined,
    {
      candidateVars: actual.variables,
      candidateProvenance: 'persisted-measurement',
      persistedMaterialSnapshot: actual.materialSnapshot,
      resetKey: workbench.workspaceSession,
      onActivity,
    },
  )
  const schema = document.varsSchema ?? workbench.experimentDocument.varsSchema
  const schemaKey = schema ? varsSchemaFingerprint(schema) : ''
  const sourceHash = workbench.experimentRecord?.source_hash ?? ''
  const contextKey = `${queryScope}:${workbench.experimentId}:${sourceHash}:${schemaKey}`
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
  const busy = operation !== null || workbench.measurementActions.busy || workbench.calculationDataActions.busy
  const persistable =
    authenticated && workbench.experimentClean && workbench.experimentManageable && !document.draftTaskNames.length
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
  const previewDocument = previewFrame?.document ?? document
  const previewData = previewFrame ? previewFrame.data : forward.data
  const displayedActualDocument = (actual.measurement && recordedDocuments[actual.measurement.id]) || actualDocument
  const comparisonContracts = {
    ...previewDocument.simulationProgram?.resultContracts,
    ...actual.resultContracts,
    ...visualizationData(actual.visualizations ?? {}).contracts,
  }
  const actualHasSelectedData =
    Object.keys(actual.flatRecordedData ?? {}).some(
      (name) => name === selectedResult || name.startsWith(`${selectedResult}.`),
    ) || selectedResult.startsWith('@visualizations.')
  const controlsSide =
    actual.measurement &&
    (!previewData?.[selectedResult] || (actualHasSelectedData && !actual.resultErrors?.[selectedResult])) &&
    (!selectedResult || actual.resultContracts?.[selectedResult] || selectedResult.startsWith('@visualizations.'))
      ? 'actual'
      : 'preview'
  const comparison = useMemo(() => {
    const common = {
      settings: comparisonSettings,
      item: selectedResult,
      controlsHost,
      suspended: !active || (!previewFrame && (!ready || forward.predicting)),
    }
    return {
      preview: {
        ...common,
        side: 'preview',
        controlsOwner: controlsSide === 'preview',
        camera,
      } as ViewerComparison,
      actual: {
        ...common,
        side: 'actual',
        controlsOwner: controlsSide === 'actual',
        camera,
      } as ViewerComparison,
    }
  }, [
    comparisonSettings,
    camera,
    selectedResult,
    controlsHost,
    active,
    ready,
    forward.predicting,
    controlsSide,
    previewFrame,
  ])
  const topology = candidates.map((candidate) => candidate.id).join('|')
  const points = useMemo<VarsPoint[]>(
    () => [...measurements.map((row) => ({ id: `measurement:${row.id}`, vars: row.vars as Vars })), ...candidates],
    [measurements, candidates],
  )
  const pointsRef = useRef(points)
  pointsRef.current = points
  const varsRef = useRef(vars)
  varsRef.current = vars
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId

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
      batchController.current?.abort()
    }
  }, [])
  useEffect(() => {
    setPreviewFrame(null)
    setRecordedDocuments({})
    setPreparation(null)
    setOperation(null)
    return () => {
      batchController.current?.abort()
      batchController.current = null
    }
  }, [contextKey, workbench.workspaceSession])
  useEffect(() => {
    const initial = workbench.selection.measurement
    if (initialSelectionApplied.current || !initial?.recorded_at) return
    initialSelectionApplied.current = true
    if (selectionSequence.current !== 0) return
    setVars(initial.vars as Vars)
    setCurrentId(`measurement:${initial.id}`)
    setSelected(new Set([`measurement:${initial.id}`]))
    void loadActualMeasurement(initial).catch((cause: unknown) => {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      if (!mounted.current) initialSelectionApplied.current = false
    }
  }, [loadActualMeasurement, workbench.selection.measurement])
  useEffect(() => {
    const instance = new Worker(new URL('./measurementSpace.worker.ts', import.meta.url), { type: 'module' })
    worker.current = instance
    instance.onmessage = (event: MessageEvent<{ id: number; projection?: MeasurementProjection; error?: string }>) => {
      if (event.data.id !== pcaSequence.current) return
      setProjection(event.data.projection ?? null)
      setPcaError(event.data.error ?? '')
      setPcaBusy(false)
    }
    instance.onerror = () => {
      setPcaError('PCA Worker 오류입니다. 탭을 다시 열거나 새로고침하세요.')
      setPcaBusy(false)
    }
    return () => {
      worker.current = null
      instance.terminate()
    }
  }, [])
  useEffect(() => {
    if (!schema || !worker.current) return
    setPcaBusy(true)
    const input = [...pointsRef.current]
    if (
      currentIdRef.current === 'draft' &&
      varsRef.current &&
      !input.some((point) => varsFingerprint(point.vars) === varsFingerprint(varsRef.current))
    )
      input.push({ id: 'draft', vars: varsRef.current })
    worker.current.postMessage({ id: ++pcaSequence.current, schema, points: input })
    // Editing projects into the existing snapshot; only membership/data refreshes rebuild it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey, measurements, topology, pcaRevision])

  const changeVars = useCallback(
    (next: Vars) => {
      setPreviewFrame(null)
      selectionSequence.current += 1
      setVars(next)
      setError('')
      setExecution((states) => {
        const nextStates = { ...states }
        delete nextStates[currentId]
        return nextStates
      })
      if (currentId.startsWith('candidate:'))
        setCandidates((rows) =>
          rows.map((row) =>
            row.id === currentId
              ? { ...row, vars: next, state: 'candidate', error: undefined, measurementId: undefined }
              : row,
          ),
        )
      else {
        setCurrentId('draft')
        setSelected(new Set())
      }
    },
    [currentId],
  )
  const selectPoint = useCallback(
    async (id: string, additive: boolean) => {
      if (!valid || busy) return
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
        const point = projection?.points.find((point) => point.id === id)
        if (point && projection) {
          const { spaceVars } = await import('./measurementSpace')
          if (sequence === selectionSequence.current) {
            setVars(spaceVars(projection.layouts, point.values))
            setCurrentId(id)
          }
        }
        return
      }
      const candidate = candidates.find((row) => row.id === id)
      if (candidate) {
        setVars(candidate.vars)
        setCurrentId(id)
        return
      }
      const row = measurements.find((row) => `measurement:${row.id}` === id)
      if (!row) return
      setVars(row.vars as Vars)
      setCurrentId(id)
      if (row.recorded_at) {
        try {
          await actual.loadMeasurement(row)
        } catch (cause) {
          if (sequence === selectionSequence.current) setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    },
    [actual, busy, candidates, measurements, projection, valid],
  )

  const generate = () => {
    if (!schema || !valid || busy) return
    setPreviewFrame(null)
    selectionSequence.current += 1
    try {
      const existing = points.map((point) => point.vars)
      if (vars && currentId === 'draft') existing.push(vars)
      const generated = sampleMeasurementVars(schema, existing, Number(count), algorithm).map((value): Candidate => ({
        id: `candidate:${crypto.randomUUID()}`,
        vars: value,
        state: 'candidate',
      }))
      setCandidates((rows) => [...rows, ...generated])
      setVars(generated[0].vars)
      setCurrentId(generated[0].id)
      setSelected(new Set(generated.map((point) => point.id)))
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
    const candidate: Candidate = { id: `candidate:${crypto.randomUUID()}`, vars, state: 'candidate' }
    setCandidates((rows) => [...rows, candidate])
    setCurrentId(candidate.id)
    setSelected(new Set([candidate.id]))
  }
  const save = async () => {
    if (
      !persistable ||
      !ready ||
      !valid ||
      busy ||
      !vars ||
      !document.materialSnapshot ||
      !workbench.experimentId ||
      currentId.startsWith('measurement:')
    )
      return
    const savedId = currentId
    setOperation('저장 중')
    setError('')
    try {
      const result = await dbTables.Measurement.create({
        experiment_id: workbench.experimentId,
        experiment_source_hash: sourceHash,
        vars,
        material_snapshot: document.materialSnapshot,
      })
      await invalidateMeasurementMutation(queryClient, queryScope, workbench.experimentId, [result.id])
      if (!mounted.current) return
      setCandidates((rows) => rows.filter((row) => row.id !== savedId))
      setCurrentId(`measurement:${result.id}`)
      setSelected(new Set([`measurement:${result.id}`]))
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setOperation(null)
    }
  }
  const run = async (all: boolean) => {
    if (!persistable || !ready || !valid || busy || !vars) return
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
    selectionSequence.current += 1
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
      if (signal.aborted) return
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
          const loaded = actual
            .loadMeasurement(measurementId, workbench.experimentId, { signal })
            .catch((cause: unknown) => {
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
          const prepared = await pendingPreview
          signal.throwIfAborted()
          if (!prepared.frame) throw prepared.cause
          frame = prepared.frame
          displayPreview(frame)
          setOperation(`실행 ${index + 1}/${queue.length}`)
          setCandidates((rows) =>
            rows.map((row) => (row.id === item.candidateId ? { ...row, state: 'running', error: undefined } : row)),
          )
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

  const chartPoints =
    projection?.points.map((point) => {
      const row = measurements.find((row) => point.id === `measurement:${row.id}`)
      const candidate = candidates.find((row) => row.id === point.id)
      const progress = execution[point.id]
      return {
        id: point.id,
        xy: point.xy,
        label: row
          ? `Measurement #${row.id}`
          : point.id === 'draft'
            ? '편집 후보'
            : `후보 ${candidates.findIndex((row) => row.id === point.id) + 1}`,
        state: row?.recorded_at
          ? 'recorded'
          : progress
            ? progress.state === 'succeeded'
              ? 'recorded'
              : progress.state === 'failed' || progress.state === 'cancelled'
                ? progress.state
                : 'running'
            : row
              ? 'prepared'
              : (candidate?.state ?? 'candidate'),
      }
    }) ?? []
  let currentProjection: number[] | undefined
  try {
    if (projection && vars) currentProjection = projectSpace(projection, spaceValues(projection.layouts, vars))
  } catch {
    /* A new schema waits for its matching PCA snapshot. */
  }
  const viewerBase = {
    experiment: workbench.experiment,
    selectionQuery: null,
    selectionSourceStatus: {},
    viewerExpanded: false,
    onFindSelectionSource: () => {},
    onSelectionQueryChange: () => {},
    onSelectionSourcePathsChange: () => {},
    selectedResult,
    onSelectedResultChange: setSelectedResult,
    showToolbar: false,
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {preparation ? (
        <MeasurementCandidatePreparation
          key={preparation.input.candidateId}
          request={preparation}
          experiment={workbench.experiment}
          onActivity={onActivity}
        />
      ) : null}
      {menubar}
      <div aria-label="Measurement 리본" className="shrink-0 overflow-x-auto border-b bg-muted/20 px-1 py-1">
        <div className="flex min-w-max items-stretch">
          <WorkbenchRibbonGroup label="후보 생성">
            <select
              aria-label="후보 생성 방식"
              className={controlClass}
              value={algorithm}
              onChange={(event) => setAlgorithm(event.target.value as typeof algorithm)}
            >
              <option value="random">Random</option>
              <option value="empty-lhs">빈 구간 LHS</option>
            </select>
            <input
              aria-label="후보 생성 개수 N"
              className={`${controlClass} w-16`}
              type="number"
              min={1}
              step={1}
              value={count}
              onChange={(event) => setCount(event.target.value)}
            />
            <button
              className={controlClass}
              disabled={!schema || busy || !valid || query.isFetching}
              onClick={generate}
            >
              후보 생성
            </button>
            <button className={controlClass} disabled={!vars || busy || !valid} onClick={addCandidate}>
              후보 추가
            </button>
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="저장">
            <button
              className={controlClass}
              disabled={!persistable || !ready || !valid || busy || currentId.startsWith('measurement:')}
              onClick={() => void save()}
            >
              Prepared 저장
            </button>
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="시뮬레이션 실행">
            <button
              className={`${controlClass} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
              disabled={!persistable || !ready || !valid || busy}
              onClick={() => void run(false)}
            >
              선택 Run
            </button>
            <button
              className={controlClass}
              disabled={!persistable || !ready || !valid || busy || (!candidates.length && currentId !== 'draft')}
              onClick={() => void run(true)}
            >
              전체 후보 Run
            </button>
            {operation && operation !== '저장 중' ? (
              <button
                className={controlClass}
                onClick={() => {
                  batchController.current?.abort()
                  latest.current.measurementActions.cancel()
                }}
              >
                취소
              </button>
            ) : null}
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="Forward 모델">
            <button
              className={controlClass}
              disabled={!dataReadable || !ready || forward.building || busy}
              onClick={() => {
                setPreviewFrame(null)
                void forward.build()
              }}
            >
              {forward.building ? '모델 생성 중…' : forward.model ? '모델 업데이트' : 'Forward 모델 생성'}
            </button>
            <span className="text-xs text-muted-foreground">
              {operation ??
                workbench.measurementActions.stage ??
                (forward.outdated
                  ? '새 데이터 · 모델 업데이트 필요'
                  : forward.model
                    ? 'Forward 모델 준비됨'
                    : 'Forward 모델 없음')}
            </span>
          </WorkbenchRibbonGroup>
        </div>
      </div>
      {!persistable ? (
        <p className="border-b px-3 py-1 text-xs text-muted-foreground">
          실행·저장에는 로그인과 저장된 편집 가능한 Experiment가 필요합니다.
        </p>
      ) : null}
      {error || query.isError ? (
        <p role="alert" className="border-b px-3 py-1 text-xs text-destructive">
          {error || 'Measurement를 불러오지 못했습니다.'}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <MeasurementSplit
          label="Measurement 좌우 너비 조절"
          first={
            <MeasurementSplit
              vertical
              label="PCA와 Vars 높이 조절"
              first={
                <section className="flex h-full min-h-0 flex-col">
                  <header className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2 text-xs">
                    <strong>Vars PCA</strong>
                    <span>
                      {measurements.length} Measurements · {candidates.length} 후보
                    </span>
                    <button
                      className={controlClass}
                      disabled={!schema || pcaBusy || !valid}
                      onClick={() => setPcaRevision((value) => value + 1)}
                    >
                      PCA 갱신
                    </button>
                    <button
                      className={controlClass}
                      disabled={busy || !valid || ![...selected].some((id) => id.startsWith('candidate:'))}
                      onClick={() => {
                        setCandidates((rows) => rows.filter((row) => !selected.has(row.id)))
                        if (selected.has(currentId)) setCurrentId('draft')
                        setSelected(new Set())
                      }}
                    >
                      선택 후보 삭제
                    </button>
                    {pcaBusy ? <span>계산 중…</span> : null}
                  </header>
                  {pcaError ? (
                    <p role="alert" className="p-2 text-xs text-destructive">
                      {pcaError}
                    </p>
                  ) : null}
                  <MeasurementPcaChart
                    projection={projection}
                    points={chartPoints}
                    current={currentProjection}
                    selected={selected}
                    disabled={!valid || busy || pcaBusy}
                    onSelect={(id, additive) => void selectPoint(id, additive)}
                    onSpace={(xy) => {
                      if (projection) changeVars(varsAtProjection(projection, xy))
                    }}
                  />
                  <label className="flex shrink-0 items-center gap-2 border-t p-2 text-xs">
                    점 선택
                    <select
                      className={`${controlClass} min-w-0 flex-1`}
                      value={currentId}
                      disabled={!valid || busy}
                      onChange={(event) => void selectPoint(event.target.value, false)}
                    >
                      <option value="draft">편집 후보</option>
                      {measurements.map((row) => (
                        <option key={row.id} value={`measurement:${row.id}`}>
                          #{row.id} · {row.recorded_at ? 'Recorded' : 'Prepared'}
                        </option>
                      ))}
                      {candidates.map((row, index) => (
                        <option key={row.id} value={row.id}>
                          후보 {index + 1} · {row.state}
                          {row.error ? ` · ${row.error}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                </section>
              }
              second={
                <MeasurementVarsEditor
                  schema={schema}
                  vars={vars}
                  selectedKey={selectedVar}
                  onSelectedKeyChange={setSelectedVar}
                  onVarsChange={changeVars}
                  onValidityChange={setValid}
                  disabled={busy}
                />
              }
            />
          }
          second={
            <div className="flex h-full min-h-0 flex-col">
              <div
                aria-label="비교 Viewer 공통 툴바"
                className="max-h-[45%] shrink-0 overflow-auto border-b bg-background [&_button]:min-h-8 [&_button]:rounded [&_button]:border [&_button]:px-2 [&_button:disabled]:opacity-40 [&_input[type=number]]:w-20 [&_input[type=number]]:rounded [&_input[type=number]]:border [&_select]:min-h-8 [&_select]:rounded [&_select]:border [&_select]:bg-background [&_select]:px-2"
              >
                <label className="flex items-center gap-2 p-2 text-xs">
                  데이터
                  <select
                    aria-label="Viewer 결과 선택"
                    value={selectedResult}
                    onChange={(event) => setSelectedResult(event.target.value)}
                    className="min-w-0 flex-1"
                  >
                    <option value="">Geometry</option>
                    {selectedResult && !comparisonContracts[selectedResult] ? (
                      <option value={selectedResult}>{selectedResult} · 결과 없음</option>
                    ) : null}
                    {Object.keys(comparisonContracts).map((name) => (
                      <option key={name} value={name}>
                        {name.startsWith('@visualizations.')
                          ? `${name.slice('@visualizations.'.length)} · 시각화`
                          : `${name} · Output`}
                      </option>
                    ))}
                  </select>
                </label>
                <ComparisonToolbar camera={camera} />
                <div ref={setControlsHost} />
              </div>
              <div className="min-h-0 flex-1">
                <MeasurementSplit
                  label="미리보기와 실제 결과 너비 조절"
                  first={
                    <section aria-label="미리보기 Viewer" className="flex h-full min-h-0 flex-col">
                      <header className="shrink-0 border-b p-2 text-xs">
                        <strong>
                          미리보기 ·{' '}
                          {previewFrame
                            ? previewFrame.candidateId.startsWith('measurement:')
                              ? `Measurement #${previewFrame.candidateId.slice(12)}`
                              : previewFrame.candidateId === 'draft'
                                ? '편집 후보'
                                : `후보 ${previewFrame.candidateId.slice(10, 18)}`
                            : '현재 Vars'}
                        </strong>
                        <span className="ml-2 text-muted-foreground">
                          {previewFrame
                            ? previewFrame.error || (previewFrame.data ? 'Forward 예측 · 실행 전' : 'CAD')
                            : !ready
                              ? '구조 평가 중…'
                              : forward.predicting
                                ? 'Forward 갱신 중…'
                                : forward.model
                                  ? 'Forward 예측'
                                  : '구조 · 모델을 생성하면 Output을 예측합니다.'}
                        </span>
                        {previewDocument.error ? (
                          <p role="alert" className="text-destructive">
                            {previewDocument.error.message}
                          </p>
                        ) : null}
                        {!previewFrame && forward.error ? (
                          <p role="alert" className="text-destructive">
                            {forward.error}
                          </p>
                        ) : null}
                        {!previewFrame &&
                          forward.model &&
                          Object.values(forward.model.errors).map((message, index) => (
                            <p className="text-muted-foreground" key={index}>
                              {message}
                            </p>
                          ))}
                      </header>
                      <div className="min-h-0 flex-1">
                        <WorkbenchViewer
                          {...viewerBase}
                          comparison={comparison.preview}
                          experimentDocument={previewDocument}
                          resultContracts={previewDocument.simulationProgram?.resultContracts}
                          recordedData={previewData}
                          recordedRules={previewFrame ? previewFrame.rules : forward.model?.rules}
                          resultSourceHash={previewDocument.evaluatedSnapshot?.sourceHash}
                          resultVarsHash={
                            (previewFrame?.vars ?? vars) ? materialVarsHash((previewFrame?.vars ?? vars)!) : null
                          }
                          loading={!previewFrame && (!ready || forward.predicting)}
                          selectedResult={previewFrame && !previewFrame.data ? '' : selectedResult}
                        />
                      </div>
                    </section>
                  }
                  second={
                    <section aria-label="실제 결과 Viewer" className="flex h-full min-h-0 flex-col">
                      <header className="shrink-0 border-b p-2 text-xs">
                        <strong>실제 결과 {actual.measurement ? `· Measurement #${actual.measurement.id}` : ''}</strong>
                        {actual.variables && varsFingerprint(actual.variables) !== currentKey ? (
                          <span className="ml-2 text-amber-700">비교 기준 · 현재 Vars와 다름</span>
                        ) : null}
                        {displayedActualDocument.error ? (
                          <p role="alert" className="text-destructive">
                            {displayedActualDocument.error.message}
                          </p>
                        ) : null}
                      </header>
                      <div className="min-h-0 flex-1">
                        {actual.measurement || actual.loading ? (
                          <WorkbenchViewer
                            {...viewerBase}
                            comparison={comparison.actual}
                            experimentDocument={displayedActualDocument}
                            resultContracts={actual.resultContracts}
                            recordedData={actual.flatRecordedData}
                            recordedRules={actual.recordedRules}
                            resultErrors={actual.resultErrors}
                            visualizations={actual.visualizations}
                            resultSourceHash={actual.materialSnapshot?.sourceHash}
                            resultVarsHash={actual.materialSnapshot?.varsHash}
                            loading={actual.loading && !actual.measurement}
                            downloadProgress={actual.downloadProgress}
                          />
                        ) : (
                          <p className="grid h-full place-items-center p-3 text-sm text-muted-foreground">
                            Recorded Measurement를 선택하면 실제 결과를 표시합니다.
                          </p>
                        )}
                      </div>
                    </section>
                  }
                />
              </div>
            </div>
          }
        />
      </div>
    </div>
  )
}
