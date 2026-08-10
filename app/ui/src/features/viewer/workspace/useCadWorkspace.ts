import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BuiltRealization,
  CadDiagnostic,
  CadDocumentType,
  CadEvaluationResponse,
  CadScene,
  CadSourceDocument,
  CompiledCadDocument,
  EvaluatedDocumentSnapshot,
  RecordedData,
  TaskMaterialResolution,
  Vars,
} from '@/lib/cad'
import {
  EXPERIMENT_SIMULATION_PATH,
  addExperimentTask,
  applyFrozenMaterialParameters,
  buildRealization,
  buildSourceOnlyRealization,
  CadCompilationError,
  compileCadDocument,
  deserializeCadScene,
  evaluateInIsolatedRunner,
  rerollCadSourceDocument,
  removeExperimentTask,
  updateCadSource,
  updateExperimentSourceFile,
} from '@/lib/cad'
import { releaseRecordedDataAttachments, simulate } from '@/features/cae/client'
import type { MaterialResolution } from '@/lib/material'
import type { SimulationProgramManifest } from '@/lib/cad/simulation'
import type { SimulationProcess } from './simulationUiTypes'

export type AppStatus =
  'Dirty' | 'Checking' | 'Compiling' | 'Evaluating' | 'Resolving Materials' | 'Ready' | 'Rendering' | 'Error'
export type EvaluationTimeoutMs = 3000 | 10000 | 30000

export type RunError = {
  title: string
  message: string
  stack?: string
}

const errorTitles = {
  compile: 'Compile Error',
  type: 'Type Error',
  policy: 'Source Policy Error',
  model: 'Model Error',
  runtime: 'Runtime Error',
}

const idleSimulationProcess: SimulationProcess = Object.freeze({
  runId: null,
  status: 'idle',
  engine: null,
  stage: null,
  error: null,
  startedAt: null,
  finishedAt: null,
})

const simulationEngine = Object.freeze({ name: 'caemble-cae', version: '1' })

function createRequestId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function sameCadSource(left: CadSourceDocument | null | undefined, right: CadSourceDocument | null | undefined) {
  if (!left || !right || left.kind !== right.kind) return false
  if (left.kind === 'structure' && right.kind === 'structure') return left.source === right.source
  if (left.kind === 'experiment' && right.kind === 'experiment') {
    return JSON.stringify(left.sourceBundle) === JSON.stringify(right.sourceBundle)
  }
  return false
}

type DocumentHandlers = Readonly<{
  handleStart: (requestId: string, revision: number) => void
  handlePhase: (requestId: string, revision: number, phase: AppStatus) => void
  handleSuccess: (
    response: Extract<CadEvaluationResponse, { type: 'evaluation-success' }>,
    realization: BuiltRealization,
    compiledSource: CompiledCadDocument,
  ) => void
  handleError: (response: Extract<CadEvaluationResponse, { type: 'evaluation-error' }>) => void
  handleWorkerFailure: (message: string) => void
  getSnapshot: () => Readonly<{
    compiledSource: CompiledCadDocument | null
    document: CadSourceDocument | null | undefined
    evaluatedSnapshot: EvaluatedDocumentSnapshot | null
    realization: BuiltRealization | null
    revision: number
    successfulRevision: number
  }>
}>

type DocumentStateOptions = Readonly<{
  document: CadSourceDocument | null | undefined
  documentType: CadDocumentType
  externalVars?: Readonly<Vars>
  onDocumentChange: ((document: CadSourceDocument) => void) | undefined
  onInvalidate: () => void
  fastReroll?: boolean
  requestEvaluation: (document: CadSourceDocument, revision: number, externalVars?: Readonly<Vars>) => void
}>

function useDocumentState({
  document,
  documentType,
  externalVars,
  fastReroll = false,
  onInvalidate,
  onDocumentChange,
  requestEvaluation,
}: DocumentStateOptions) {
  const [compiledSource, setCompiledSource] = useState<CompiledCadDocument | null>(null)
  const [diagnostics, setDiagnostics] = useState<readonly CadDiagnostic[]>([])
  const [error, setError] = useState<RunError | null>(null)
  const [scene, setScene] = useState<CadScene | null>(null)
  const [taskScenes, setTaskScenes] = useState<Readonly<Record<string, CadScene>>>(Object.freeze({}))
  const [evaluatedSnapshot, setEvaluatedSnapshot] = useState<EvaluatedDocumentSnapshot | null>(null)
  const [realization, setRealization] = useState<BuiltRealization | null>(null)
  const [materialWarnings, setMaterialWarnings] = useState<readonly string[]>([])
  const [simulationProgram, setSimulationProgram] = useState<SimulationProgramManifest | null>(null)
  const [status, setStatus] = useState<AppStatus>('Ready')
  const [variables, setVariables] = useState<Readonly<Vars> | null>(null)
  const [varsSchema, setVarsSchema] = useState<EvaluatedDocumentSnapshot['varsSchema'] | null>(null)
  const [revision, setRevision] = useState(0)
  const [successfulRevision, setSuccessfulRevision] = useState(-1)
  const latestRequestIdRef = useRef('')
  const pendingEvaluationRef = useRef<Readonly<{
    document: CadSourceDocument
    externalVars?: Readonly<Vars>
    revision: number
  }> | null>(null)
  const pendingTimerRef = useRef<number | null>(null)
  const revisionRef = useRef(0)
  const previousDocumentRef = useRef<CadSourceDocument | null | undefined>(undefined)
  const documentRef = useRef(document)
  const statusRef = useRef<AppStatus>('Ready')
  const successfulRevisionRef = useRef(-1)
  const compiledSourceRef = useRef<CompiledCadDocument | null>(null)
  const evaluatedSnapshotRef = useRef<EvaluatedDocumentSnapshot | null>(null)
  const realizationRef = useRef<BuiltRealization | null>(null)

  documentRef.current = document
  compiledSourceRef.current = compiledSource
  evaluatedSnapshotRef.current = evaluatedSnapshot
  realizationRef.current = realization

  const updateStatus = useCallback((nextStatus: AppStatus) => {
    statusRef.current = nextStatus
    setStatus(nextStatus)
  }, [])

  const updateSuccessfulRevision = useCallback((nextRevision: number) => {
    successfulRevisionRef.current = nextRevision
    setSuccessfulRevision(nextRevision)
  }, [])

  const clearPendingEvaluation = useCallback(() => {
    if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = null
    pendingEvaluationRef.current = null
  }, [])

  const dispatchPendingEvaluation = useCallback(() => {
    const pending = pendingEvaluationRef.current
    pendingEvaluationRef.current = null
    pendingTimerRef.current = null
    if (pending) requestEvaluation(pending.document, pending.revision, pending.externalVars)
  }, [requestEvaluation])

  useEffect(() => {
    const previousDocument = previousDocumentRef.current
    previousDocumentRef.current = document
    const sourceChanged = !sameCadSource(previousDocument, document)
    const nextRevision = revisionRef.current + 1
    revisionRef.current = nextRevision
    setRevision(nextRevision)
    onInvalidate()
    clearPendingEvaluation()

    if (!document) {
      latestRequestIdRef.current = ''
      setCompiledSource(null)
      setDiagnostics([])
      setError(null)
      setEvaluatedSnapshot(null)
      setRealization(null)
      setMaterialWarnings([])
      setScene(null)
      setTaskScenes(Object.freeze({}))
      setSimulationProgram(null)
      setVariables(null)
      setVarsSchema(null)
      updateSuccessfulRevision(-1)
      updateStatus('Ready')
      return
    }

    pendingEvaluationRef.current = Object.freeze({
      document,
      ...(externalVars ? { externalVars } : {}),
      revision: nextRevision,
    })
    updateStatus(sourceChanged ? 'Dirty' : 'Evaluating')
    setRealization(null)
    setMaterialWarnings([])
    const delay = !sourceChanged && fastReroll ? 75 : 500
    pendingTimerRef.current = window.setTimeout(dispatchPendingEvaluation, delay)
  }, [
    clearPendingEvaluation,
    dispatchPendingEvaluation,
    document,
    externalVars,
    fastReroll,
    onInvalidate,
    requestEvaluation,
    updateStatus,
    updateSuccessfulRevision,
  ])

  useEffect(() => clearPendingEvaluation, [clearPendingEvaluation])

  const handleRenderStart = useCallback(() => {
    if (statusRef.current !== 'Ready') return
    updateStatus('Rendering')
  }, [updateStatus])
  const handleRenderEnd = useCallback(() => {
    if (statusRef.current !== 'Rendering') return
    updateStatus('Ready')
  }, [updateStatus])
  const handleRenderError = useCallback(
    (message: string) => {
      if (statusRef.current === 'Compiling' || statusRef.current === 'Error') return
      updateStatus('Error')
      setError({ title: 'Rendering Error', message })
    },
    [updateStatus],
  )

  const runIsBusy =
    status === 'Checking' ||
    status === 'Compiling' ||
    status === 'Evaluating' ||
    status === 'Resolving Materials' ||
    status === 'Rendering'
  const editingBlocked = !onDocumentChange
  const handleReroll = useCallback(() => {
    if (runIsBusy || !document || editingBlocked) return
    clearPendingEvaluation()
    onDocumentChange?.(rerollCadSourceDocument(document))
  }, [clearPendingEvaluation, document, editingBlocked, onDocumentChange, runIsBusy])

  const handleSourceChange = useCallback(
    (nextSource: string) => {
      if (!document || editingBlocked) return
      onDocumentChange?.(updateCadSource(document, nextSource))
    },
    [document, editingBlocked, onDocumentChange],
  )
  const handleSimulationCodeChange = useCallback(
    (nextSource: string) => {
      if (!document || document.kind !== 'experiment' || editingBlocked) return
      onDocumentChange?.(updateExperimentSourceFile(document, EXPERIMENT_SIMULATION_PATH, nextSource))
    },
    [document, editingBlocked, onDocumentChange],
  )
  const handleExperimentFileChange = useCallback(
    (path: string, nextSource: string) => {
      if (!document || document.kind !== 'experiment' || editingBlocked) return
      onDocumentChange?.(updateExperimentSourceFile(document, path, nextSource))
    },
    [document, editingBlocked, onDocumentChange],
  )
  const handleAddExperimentTask = useCallback(
    (taskName: string, source: string) => {
      if (!document || document.kind !== 'experiment' || editingBlocked) return
      onDocumentChange?.(addExperimentTask(document, taskName, source))
    },
    [document, editingBlocked, onDocumentChange],
  )
  const handleRemoveExperimentTask = useCallback(
    (taskName: string) => {
      if (!document || document.kind !== 'experiment' || editingBlocked) return
      onDocumentChange?.(removeExperimentTask(document, taskName))
    },
    [document, editingBlocked, onDocumentChange],
  )

  const handlers: DocumentHandlers = {
    handleStart(requestId, requestRevision) {
      if (requestRevision !== revisionRef.current) return
      latestRequestIdRef.current = requestId
      updateStatus('Checking')
      setDiagnostics([])
      setError(null)
    },
    handlePhase(requestId, requestRevision, phase) {
      if (requestRevision !== revisionRef.current || requestId !== latestRequestIdRef.current) return
      updateStatus(phase)
    },
    handleSuccess(response, builtRealization, nextCompiledSource) {
      if (
        response.documentType !== documentType ||
        response.revision !== revisionRef.current ||
        response.requestId !== latestRequestIdRef.current ||
        response.snapshot.kind !== documentType
      ) {
        return
      }
      let runtimeScene: CadScene | null = null
      let runtimeTaskScenes: Readonly<Record<string, CadScene>> = Object.freeze({})
      let warnings: readonly string[] = []
      if (response.snapshot.kind === 'structure' && builtRealization.kind === 'sample') {
        runtimeScene = applyFrozenMaterialParameters(
          deserializeCadScene(response.snapshot.scene),
          builtRealization.materialParameters,
        )
        warnings = builtRealization.materialWarnings
      } else if (response.snapshot.kind === 'experiment' && builtRealization.kind === 'setup') {
        runtimeTaskScenes = Object.freeze(
          Object.fromEntries(
            Object.entries(response.snapshot.taskScenes).map(([name, serialized]) => [
              name,
              applyFrozenMaterialParameters(
                deserializeCadScene(serialized),
                builtRealization.taskMaterialParameters[name],
              ),
            ]),
          ),
        )
        runtimeScene = Object.values(runtimeTaskScenes)[0] ?? null
        warnings = Object.entries(builtRealization.taskMaterialWarnings).flatMap(([name, items]) =>
          items.map((item) => `${name}: ${item}`),
        )
      }
      updateStatus('Ready')
      setDiagnostics([])
      setError(null)
      setCompiledSource(nextCompiledSource)
      setScene(runtimeScene)
      setTaskScenes(runtimeTaskScenes)
      setEvaluatedSnapshot(response.snapshot)
      setRealization(builtRealization)
      setMaterialWarnings(warnings)
      setVariables(response.snapshot.variables)
      setVarsSchema(response.snapshot.varsSchema)
      setSimulationProgram(response.snapshot.kind === 'experiment' ? response.snapshot.simulationProgram : null)
      updateSuccessfulRevision(response.revision)
    },
    handleError(response) {
      if (
        response.documentType !== documentType ||
        response.revision !== revisionRef.current ||
        response.requestId !== latestRequestIdRef.current
      ) {
        return
      }
      updateStatus('Error')
      updateSuccessfulRevision(-1)
      setDiagnostics(response.diagnostics ?? [])
      setError({
        title: errorTitles[response.errorType],
        message: response.message,
        stack: response.stack,
      })
    },
    handleWorkerFailure(message) {
      latestRequestIdRef.current = ''
      updateStatus('Error')
      updateSuccessfulRevision(-1)
      setDiagnostics([])
      setError({ title: 'Runtime Error', message })
    },
    getSnapshot() {
      return {
        compiledSource: compiledSourceRef.current,
        document: documentRef.current,
        evaluatedSnapshot: evaluatedSnapshotRef.current,
        realization: realizationRef.current,
        revision: revisionRef.current,
        successfulRevision: successfulRevisionRef.current,
      }
    },
  }

  return {
    controller: {
      compiledSource,
      diagnostics,
      documentType,
      error,
      evaluatedSnapshot,
      handleRenderEnd,
      handleRenderError,
      handleRenderStart,
      handleAddExperimentTask,
      handleExperimentFileChange,
      handleRemoveExperimentTask,
      handleReroll,
      handleSimulationCodeChange,
      handleSourceChange,
      materialParameters:
        realization?.kind === 'sample'
          ? realization.materialParameters
          : realization?.kind === 'setup'
            ? Object.freeze({ schemaVersion: 1 as const, tasks: realization.taskMaterialParameters })
            : null,
      materialWarnings,
      readOnly: editingBlocked,
      realization,
      revision,
      runIsBusy,
      scene,
      sceneHash: evaluatedSnapshot?.kind === 'structure' ? evaluatedSnapshot.scene.sceneHash : null,
      taskScenes,
      taskSceneHashes:
        evaluatedSnapshot?.kind === 'experiment'
          ? Object.freeze(
              Object.fromEntries(
                Object.entries(evaluatedSnapshot.taskScenes).map(([name, value]) => [name, value.sceneHash]),
              ),
            )
          : Object.freeze({}),
      simulationProgram,
      sourceReadOnly: editingBlocked,
      status,
      successfulRevision,
      variables,
      varsSchema,
    },
    handlers,
  }
}

type BaseCadDocumentController = ReturnType<typeof useDocumentState>['controller']

export type CadDocumentController = BaseCadDocumentController &
  Readonly<{
    evaluationTimeoutMs: EvaluationTimeoutMs
    setEvaluationTimeoutMs: (timeout: EvaluationTimeoutMs) => void
  }>

export function attachWorkspaceMetadata(
  controller: BaseCadDocumentController,
  evaluationTimeoutMs: EvaluationTimeoutMs,
  setEvaluationTimeoutMs: (timeout: EvaluationTimeoutMs) => void,
): CadDocumentController {
  return {
    ...controller,
    evaluationTimeoutMs,
    setEvaluationTimeoutMs,
  }
}

export type SimulationController = Readonly<{
  canRun: boolean
  cancel: () => void
  process: SimulationProcess
  recordedData: RecordedData | null
  run: () => string | null
  stale: boolean
}>

type EvaluationJob = {
  cancel: () => void
  requestId: string
  timeout: number | null
}

type CompiledSourceSlot = {
  document: CadSourceDocument
  compiledSource: CompiledCadDocument | null
  promise: Promise<CompiledCadDocument>
}

export function useCadWorkspace(
  structure: CadSourceDocument | null | undefined,
  experiment: CadSourceDocument | null | undefined,
  onStructureChange: ((document: CadSourceDocument) => void) | undefined,
  onExperimentChange: ((document: CadSourceDocument) => void) | undefined,
  structureVars?: Readonly<Vars>,
  experimentVars?: Readonly<Vars>,
  resolveMaterials?: (snapshot: EvaluatedDocumentSnapshot) => Promise<MaterialResolution | TaskMaterialResolution>,
  structureEvaluationMode: 'standard' | 'fast-reroll' = 'standard',
  runtimeEnabled = true,
) {
  const documentHandlersRef = useRef<Partial<Record<CadDocumentType, DocumentHandlers>>>({})
  const evaluationJobsRef = useRef<Partial<Record<CadDocumentType, EvaluationJob>>>({})
  const compiledSourcesRef = useRef<Partial<Record<CadDocumentType, CompiledSourceSlot>>>({})
  const activeRunRef = useRef<Readonly<{
    cancel: () => void
    requestId: string
    runId: string | null
    startedAt: number
  }> | null>(null)
  const resolveMaterialsRef = useRef(resolveMaterials)
  const recordedDataRef = useRef<RecordedData | null>(null)
  const [process, setProcess] = useState<SimulationProcess>(idleSimulationProcess)
  const [recordedData, setRecordedData] = useState<RecordedData | null>(null)
  const [stale, setStale] = useState(false)
  const [evaluationTimeoutMs, setEvaluationTimeoutMs] = useState<EvaluationTimeoutMs>(3000)
  const evaluationTimeoutMsRef = useRef<EvaluationTimeoutMs>(evaluationTimeoutMs)

  resolveMaterialsRef.current = resolveMaterials
  evaluationTimeoutMsRef.current = evaluationTimeoutMs

  const clearEvaluationJob = useCallback((documentType: CadDocumentType, requestId?: string) => {
    const active = evaluationJobsRef.current[documentType]
    if (!active || (requestId && active.requestId !== requestId)) return
    if (active.timeout !== null) window.clearTimeout(active.timeout)
    active.cancel()
    delete evaluationJobsRef.current[documentType]
  }, [])

  const finishEvaluationJob = useCallback((documentType: CadDocumentType, requestId: string) => {
    const active = evaluationJobsRef.current[documentType]
    if (!active || active.requestId !== requestId) return false
    if (active.timeout !== null) window.clearTimeout(active.timeout)
    delete evaluationJobsRef.current[documentType]
    return true
  }, [])

  const compiledSourceFor = useCallback((document: CadSourceDocument) => {
    const existing = compiledSourcesRef.current[document.kind]
    if (existing && sameCadSource(existing.document, document)) return existing.promise
    const slot: CompiledSourceSlot = {
      document,
      compiledSource: null,
      promise: Promise.resolve(null as never),
    }
    slot.promise = compileCadDocument(document)
      .then((compiledSource) => {
        slot.compiledSource = compiledSource
        return compiledSource
      })
      .catch((error) => {
        if (compiledSourcesRef.current[document.kind] === slot) {
          delete compiledSourcesRef.current[document.kind]
        }
        throw error
      })
    compiledSourcesRef.current[document.kind] = slot
    return slot.promise
  }, [])

  const requestEvaluation = useCallback(
    (document: CadSourceDocument, revision: number, externalVars?: Readonly<Vars>) => {
      const documentType = document.kind
      clearEvaluationJob(documentType)
      const requestId = createRequestId(documentType)
      const handlers = documentHandlersRef.current[documentType]
      handlers?.handleStart(requestId, revision)
      const job: EvaluationJob = {
        cancel: () => undefined,
        requestId,
        timeout: null,
      }
      evaluationJobsRef.current[documentType] = job
      const cached = compiledSourcesRef.current[documentType]
      if (!cached || !sameCadSource(cached.document, document)) {
        handlers?.handlePhase(requestId, revision, 'Compiling')
      }

      void compiledSourceFor(document)
        .then((compiledSource) => {
          if (evaluationJobsRef.current[documentType] !== job) return
          const pythonSource =
            document.kind === 'experiment' ? document.sourceBundle.files[EXPERIMENT_SIMULATION_PATH] : null
          handlers?.handlePhase(requestId, revision, 'Evaluating')
          job.cancel = evaluateInIsolatedRunner(
            {
              type: 'evaluate',
              requestId,
              revision,
              document: {
                kind: documentType,
                realizationSeed: document.realizationSeed,
                ...(pythonSource ? { pythonSource } : {}),
              },
              compiledDocument: compiledSource,
              ...(externalVars ? { vars: externalVars } : {}),
            },
            {
              onFailure(message) {
                if (!finishEvaluationJob(documentType, requestId)) return
                handlers?.handleWorkerFailure(message)
              },
              onStart() {
                if (evaluationJobsRef.current[documentType] !== job) return
                job.timeout = window.setTimeout(() => {
                  if (!finishEvaluationJob(documentType, requestId)) return
                  job.cancel()
                  handlers?.handleWorkerFailure(
                    `Model evaluation timed out after ${evaluationTimeoutMsRef.current / 1000} seconds for revision ${revision}.`,
                  )
                }, evaluationTimeoutMsRef.current)
              },
              onResponse(response) {
                if (!finishEvaluationJob(documentType, requestId)) return
                if (response.type === 'evaluation-error') {
                  handlers?.handleError(response)
                  return
                }
                handlers?.handlePhase(requestId, revision, 'Resolving Materials')
                const realizationPromise = resolveMaterialsRef.current
                  ? resolveMaterialsRef
                      .current(response.snapshot)
                      .then((resolution) => buildRealization(response.snapshot, resolution))
                  : Promise.resolve(buildSourceOnlyRealization(response.snapshot))
                void realizationPromise
                  .then((builtRealization) => {
                    if (handlers?.getSnapshot().revision !== revision) return
                    handlers.handleSuccess(response, builtRealization, compiledSource)
                  })
                  .catch((error: unknown) => {
                    handlers?.handleError({
                      type: 'evaluation-error',
                      requestId,
                      revision,
                      documentType,
                      errorType: 'model',
                      message: error instanceof Error ? error.message : String(error),
                    })
                  })
              },
            },
          )
        })
        .catch((error: unknown) => {
          if (!finishEvaluationJob(documentType, requestId)) return
          const compilationError = error instanceof CadCompilationError ? error : null
          handlers?.handleError({
            type: 'evaluation-error',
            requestId,
            revision,
            documentType,
            errorType: compilationError?.errorType ?? 'compile',
            message: error instanceof Error ? error.message : String(error),
            ...(compilationError?.diagnostics.length ? { diagnostics: compilationError.diagnostics } : {}),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          })
        })
    },
    [clearEvaluationJob, compiledSourceFor, finishEvaluationJob],
  )

  const invalidateWorkspace = useCallback(() => {
    if (recordedDataRef.current) setStale(true)
    const activeRun = activeRunRef.current
    if (activeRun) {
      activeRunRef.current = null
      activeRun.cancel()
      recordedDataRef.current = null
      setRecordedData(null)
      setProcess(
        Object.freeze({
          runId: activeRun.runId ?? activeRun.requestId,
          status: 'cancelled',
          engine: simulationEngine,
          stage: null,
          error: 'Simulation run was invalidated by a Structure, Experiment, or variable change.',
          startedAt: activeRun.startedAt,
          finishedAt: Date.now(),
        }),
      )
    }
  }, [])

  const structureState = useDocumentState({
    document: structure,
    documentType: 'structure',
    externalVars: structureVars,
    onDocumentChange: onStructureChange,
    onInvalidate: invalidateWorkspace,
    fastReroll: structureEvaluationMode === 'fast-reroll',
    requestEvaluation,
  })
  const experimentState = useDocumentState({
    document: experiment,
    documentType: 'experiment',
    externalVars: experimentVars,
    onDocumentChange: onExperimentChange,
    onInvalidate: invalidateWorkspace,
    requestEvaluation,
  })
  documentHandlersRef.current.structure = structureState.handlers
  documentHandlersRef.current.experiment = experimentState.handlers

  useEffect(() => {
    const jobs = evaluationJobsRef.current
    return () => {
      Object.keys(jobs).forEach((key) => clearEvaluationJob(key as CadDocumentType))
      activeRunRef.current?.cancel()
      activeRunRef.current = null
      releaseRecordedDataAttachments(recordedDataRef.current)
    }
  }, [clearEvaluationJob])

  const structureDocument = attachWorkspaceMetadata(
    structureState.controller,
    evaluationTimeoutMs,
    setEvaluationTimeoutMs,
  )
  const experimentDocument = attachWorkspaceMetadata(
    experimentState.controller,
    evaluationTimeoutMs,
    setEvaluationTimeoutMs,
  )

  const processActive = process.status === 'preparing' || process.status === 'running'
  const canRun =
    !processActive &&
    structureDocument.status === 'Ready' &&
    experimentDocument.status === 'Ready' &&
    structureDocument.successfulRevision === structureDocument.revision &&
    experimentDocument.successfulRevision === experimentDocument.revision &&
    Boolean(experimentDocument.simulationProgram) &&
    runtimeEnabled

  const run = useCallback(() => {
    if (!experimentDocument.simulationProgram || activeRunRef.current || !runtimeEnabled) return null
    const structureSnapshot = documentHandlersRef.current.structure?.getSnapshot()
    const experimentSnapshot = documentHandlersRef.current.experiment?.getSnapshot()
    if (
      !structureSnapshot ||
      !experimentSnapshot ||
      structureSnapshot.successfulRevision !== structureSnapshot.revision ||
      experimentSnapshot.successfulRevision !== experimentSnapshot.revision ||
      structureSnapshot.realization?.kind !== 'sample' ||
      experimentSnapshot.realization?.kind !== 'setup'
    ) {
      return null
    }

    const requestId = createRequestId('simulation')
    const startedAt = Date.now()
    releaseRecordedDataAttachments(recordedDataRef.current)
    recordedDataRef.current = null
    setRecordedData(null)
    setStale(false)
    setProcess(
      Object.freeze({
        runId: requestId,
        status: 'preparing',
        engine: simulationEngine,
        stage: 'startup',
        error: null,
        startedAt,
        finishedAt: null,
      }),
    )
    const abortController = new AbortController()
    const promise = simulate(structureSnapshot.realization, experimentSnapshot.realization, {
      signal: abortController.signal,
      onRecord(name, tensor) {
        if (activeRunRef.current?.requestId !== requestId) return
        const nextRecordedData = Object.freeze({
          ...(recordedDataRef.current ?? {}),
          [name]: tensor,
        }) as RecordedData
        recordedDataRef.current = nextRecordedData
        setRecordedData(nextRecordedData)
      },
      onProgress(progress) {
        const active = activeRunRef.current
        if (active?.requestId !== requestId) return
        if (active.runId !== progress.runId) {
          activeRunRef.current = Object.freeze({ ...active, runId: progress.runId })
        }
        setProcess(
          Object.freeze({
            runId: progress.runId,
            status: 'running',
            engine: simulationEngine,
            stage: `${progress.task}: ${progress.stage}`,
            error: null,
            startedAt,
            finishedAt: null,
          }),
        )
      },
      onStatus(status) {
        const active = activeRunRef.current
        if (active?.requestId !== requestId) return
        setProcess(
          Object.freeze({
            runId: active.runId ?? requestId,
            status: status === 'validating' ? 'preparing' : 'running',
            engine: simulationEngine,
            stage: status,
            error: null,
            startedAt,
            finishedAt: null,
          }),
        )
      },
    })
    activeRunRef.current = Object.freeze({
      cancel: () => abortController.abort(),
      requestId,
      runId: null,
      startedAt,
    })
    void promise
      .then((result) => {
        if (activeRunRef.current?.requestId !== requestId) {
          releaseRecordedDataAttachments(result)
          return
        }
        const completedRunId = activeRunRef.current.runId ?? requestId
        activeRunRef.current = null
        recordedDataRef.current = result
        setRecordedData(result)
        const currentStructure = documentHandlersRef.current.structure?.getSnapshot()
        const currentExperiment = documentHandlersRef.current.experiment?.getSnapshot()
        setStale(
          currentStructure?.revision !== structureSnapshot.revision ||
            currentExperiment?.revision !== experimentSnapshot.revision,
        )
        setProcess(
          Object.freeze({
            runId: completedRunId,
            status: 'succeeded',
            engine: simulationEngine,
            stage: null,
            error: null,
            startedAt,
            finishedAt: Date.now(),
          }),
        )
      })
      .catch((error: unknown) => {
        const active = activeRunRef.current
        if (active?.requestId !== requestId) return
        activeRunRef.current = null
        releaseRecordedDataAttachments(recordedDataRef.current)
        recordedDataRef.current = null
        setRecordedData(null)
        setProcess(
          Object.freeze({
            runId: active.runId ?? requestId,
            status: 'failed',
            engine: simulationEngine,
            stage: null,
            error: error instanceof Error ? error.message : String(error),
            startedAt,
            finishedAt: Date.now(),
          }),
        )
      })
    return requestId
  }, [experimentDocument.simulationProgram, runtimeEnabled])

  const cancel = useCallback(() => {
    const active = activeRunRef.current
    if (!active) return
    activeRunRef.current = null
    active.cancel()
    releaseRecordedDataAttachments(recordedDataRef.current)
    recordedDataRef.current = null
    setRecordedData(null)
    setProcess(
      Object.freeze({
        runId: active.runId ?? active.requestId,
        status: 'cancelled',
        engine: simulationEngine,
        stage: null,
        error: 'Simulation run was cancelled.',
        startedAt: active.startedAt,
        finishedAt: Date.now(),
      }),
    )
  }, [])

  const simulation: SimulationController = {
    canRun,
    cancel,
    process,
    recordedData,
    run,
    stale,
  }

  return {
    experimentDocument,
    simulation,
    structureDocument,
  }
}
