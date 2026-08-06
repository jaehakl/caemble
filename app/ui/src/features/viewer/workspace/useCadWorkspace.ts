import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BuiltRealization,
  CadDiagnostic,
  CadDocumentType,
  CadEvaluationResponse,
  CadScene,
  CadSourceDocument,
  CompiledCadSource,
  EvaluatedDocumentSnapshot,
  RecordedData,
  Vars,
} from '@/lib/cad'
import {
  applyFrozenMaterialParameters,
  buildRealization,
  CadCompilationError,
  compileCadDocument,
  deserializeCadScene,
  evaluateInIsolatedRunner,
  preflightSimulationInIsolatedRunner,
  rerollCadSourceDocument,
  runSimulationInIsolatedRunner,
  updateCadSource,
} from '@/lib/cad'
import { sourceOnlyMaterialParameters, type MaterialResolution } from '@/lib/material'
import { exportSimulationResult, type SimulationProgramManifest, type SimulationResult } from '@/lib/simulation'
import type { SimulationCompatibility, SimulationCompatibilityIssue, SimulationProcess } from './simulationUiTypes'

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

const simulationEngine = Object.freeze({ name: 'experiment-program', version: '1' })

function createRequestId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function sameCadSource(left: CadSourceDocument | null | undefined, right: CadSourceDocument | null | undefined) {
  return Boolean(
    left &&
    right &&
    left.apiVersion === right.apiVersion &&
    left.formatVersion === right.formatVersion &&
    left.kind === right.kind &&
    left.source === right.source,
  )
}

type DocumentHandlers = Readonly<{
  handleStart: (requestId: string, revision: number) => void
  handlePhase: (requestId: string, revision: number, phase: AppStatus) => void
  handleSuccess: (
    response: Extract<CadEvaluationResponse, { type: 'evaluation-success' }>,
    realization: BuiltRealization,
    compiledSource: CompiledCadSource,
  ) => void
  handleError: (response: Extract<CadEvaluationResponse, { type: 'evaluation-error' }>) => void
  handleWorkerFailure: (message: string) => void
  getSnapshot: () => Readonly<{
    compiledSource: CompiledCadSource | null
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
  const [compiledSource, setCompiledSource] = useState<CompiledCadSource | null>(null)
  const [diagnostics, setDiagnostics] = useState<readonly CadDiagnostic[]>([])
  const [error, setError] = useState<RunError | null>(null)
  const [scene, setScene] = useState<CadScene | null>(null)
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
  const compiledSourceRef = useRef<CompiledCadSource | null>(null)
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
  const handleReroll = useCallback(() => {
    if (runIsBusy || !document || !onDocumentChange) return
    clearPendingEvaluation()
    onDocumentChange(rerollCadSourceDocument(document))
  }, [clearPendingEvaluation, document, onDocumentChange, runIsBusy])

  const handleSourceChange = useCallback(
    (nextSource: string) => {
      if (!document || !onDocumentChange) return
      onDocumentChange(updateCadSource(document, nextSource))
    },
    [document, onDocumentChange],
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
      const runtimeScene = applyFrozenMaterialParameters(
        deserializeCadScene(response.snapshot.scene),
        builtRealization.materialParameters,
      )
      updateStatus('Ready')
      setDiagnostics([])
      setError(null)
      setCompiledSource(nextCompiledSource)
      setScene(runtimeScene)
      setEvaluatedSnapshot(response.snapshot)
      setRealization(builtRealization)
      setMaterialWarnings(builtRealization.materialWarnings)
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
      handleReroll,
      handleSourceChange,
      materialParameters: realization?.materialParameters ?? null,
      materialWarnings,
      readOnly: !onDocumentChange,
      realization,
      revision,
      runIsBusy,
      scene,
      sceneHash: evaluatedSnapshot?.scene.sceneHash ?? null,
      simulationProgram,
      sourceReadOnly: !onDocumentChange,
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
    preflightIssues: readonly SimulationCompatibilityIssue[]
    setEvaluationTimeoutMs: (timeout: EvaluationTimeoutMs) => void
  }>

export function attachPreflightMetadata(
  controller: BaseCadDocumentController,
  issues: readonly SimulationCompatibilityIssue[],
  evaluationTimeoutMs: EvaluationTimeoutMs,
  setEvaluationTimeoutMs: (timeout: EvaluationTimeoutMs) => void,
): CadDocumentController {
  return {
    ...controller,
    evaluationTimeoutMs,
    preflightIssues: issues,
    setEvaluationTimeoutMs,
  }
}

export type SimulationController = Readonly<{
  canRun: boolean
  cancel: () => void
  compatibility: SimulationCompatibility
  process: SimulationProcess
  programResult: SimulationResult | null
  exportProgramResult: () => string | null
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
  compiledSource: CompiledCadSource | null
  promise: Promise<CompiledCadSource>
}

export function useCadWorkspace(
  structure: CadSourceDocument | null | undefined,
  experiment: CadSourceDocument | null | undefined,
  onStructureChange: ((document: CadSourceDocument) => void) | undefined,
  onExperimentChange: ((document: CadSourceDocument) => void) | undefined,
  structureVars?: Readonly<Vars>,
  experimentVars?: Readonly<Vars>,
  resolveMaterials?: (snapshot: EvaluatedDocumentSnapshot) => Promise<MaterialResolution>,
  structureEvaluationMode: 'standard' | 'fast-reroll' = 'standard',
) {
  const documentHandlersRef = useRef<Partial<Record<CadDocumentType, DocumentHandlers>>>({})
  const evaluationJobsRef = useRef<Partial<Record<CadDocumentType, EvaluationJob>>>({})
  const compiledSourcesRef = useRef<Partial<Record<CadDocumentType, CompiledSourceSlot>>>({})
  const activeRunRef = useRef<Readonly<{
    cancel: () => void
    requestId: string
    startedAt: number
  }> | null>(null)
  const activePreflightRef = useRef<Readonly<{
    cancel: () => void
    requestId: string
  }> | null>(null)
  const resolveMaterialsRef = useRef(resolveMaterials)
  const recordedDataRef = useRef<RecordedData | null>(null)
  const [process, setProcess] = useState<SimulationProcess>(idleSimulationProcess)
  const [programResult, setProgramResult] = useState<SimulationResult | null>(null)
  const [recordedData, setRecordedData] = useState<RecordedData | null>(null)
  const [stale, setStale] = useState(false)
  const [evaluationTimeoutMs, setEvaluationTimeoutMs] = useState<EvaluationTimeoutMs>(3000)
  const evaluationTimeoutMsRef = useRef<EvaluationTimeoutMs>(evaluationTimeoutMs)
  const [preflight, setPreflight] = useState<Readonly<{
    structureRevision: number
    experimentRevision: number
    issues: readonly SimulationCompatibilityIssue[] | null
  }> | null>(null)

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
          handlers?.handlePhase(requestId, revision, 'Evaluating')
          job.cancel = evaluateInIsolatedRunner(
            {
              type: 'evaluate',
              requestId,
              revision,
              document: {
                kind: documentType,
                realizationSeed: document.realizationSeed,
              },
              compiledSource,
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
                const fallback = () => {
                  const scene = deserializeCadScene(response.snapshot.scene)
                  const materials = scene.parts.flatMap((part) => (part.material ? [part.material] : []))
                  return sourceOnlyMaterialParameters(materials)
                }
                void (
                  resolveMaterialsRef.current
                    ? resolveMaterialsRef.current(response.snapshot)
                    : Promise.resolve(fallback())
                )
                  .then((resolution) => {
                    if (handlers?.getSnapshot().revision !== revision) return
                    handlers.handleSuccess(response, buildRealization(response.snapshot, resolution), compiledSource)
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
      setProcess(
        Object.freeze({
          runId: activeRun.requestId,
          status: 'cancelled',
          engine: simulationEngine,
          stage: null,
          error: 'Simulation run was invalidated by a Structure, Experiment, or variable change.',
          startedAt: activeRun.startedAt,
          finishedAt: Date.now(),
        }),
      )
    }
    activePreflightRef.current?.cancel()
    activePreflightRef.current = null
    setPreflight(null)
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
    const structureSnapshot = documentHandlersRef.current.structure?.getSnapshot()
    const experimentSnapshot = documentHandlersRef.current.experiment?.getSnapshot()
    if (
      !structureSnapshot ||
      !experimentSnapshot ||
      structureSnapshot.successfulRevision !== structureSnapshot.revision ||
      experimentSnapshot.successfulRevision !== experimentSnapshot.revision ||
      structureSnapshot.realization?.kind !== 'sample' ||
      experimentSnapshot.realization?.kind !== 'setup' ||
      !experimentSnapshot.compiledSource ||
      experimentSnapshot.evaluatedSnapshot?.kind !== 'experiment'
    ) {
      setPreflight(null)
      return
    }

    const requestId = createRequestId('preflight')
    const structureRevision = structureSnapshot.revision
    const experimentRevision = experimentSnapshot.revision
    setPreflight(
      Object.freeze({
        structureRevision,
        experimentRevision,
        issues: null,
      }),
    )
    const cancel = preflightSimulationInIsolatedRunner(
      {
        type: 'preflight-simulation',
        requestId,
        structureRevision,
        experimentRevision,
        compiledSource: experimentSnapshot.compiledSource,
        sample: structureSnapshot.realization,
        setup: experimentSnapshot.realization,
      },
      {
        onFailure(message) {
          if (activePreflightRef.current?.requestId !== requestId) return
          activePreflightRef.current = null
          setPreflight(
            Object.freeze({
              structureRevision,
              experimentRevision,
              issues: Object.freeze([{ path: 'simulation', message }]),
            }),
          )
        },
        onResponse(response) {
          if (activePreflightRef.current?.requestId !== requestId) return
          activePreflightRef.current = null
          setPreflight(
            Object.freeze({
              structureRevision,
              experimentRevision,
              issues: response.issues,
            }),
          )
        },
      },
    )
    activePreflightRef.current = Object.freeze({ cancel, requestId })
    return () => {
      if (activePreflightRef.current?.requestId !== requestId) return
      activePreflightRef.current.cancel()
      activePreflightRef.current = null
    }
  }, [
    experimentState.controller.compiledSource,
    experimentState.controller.realization,
    experimentState.controller.revision,
    experimentState.controller.successfulRevision,
    structureState.controller.realization,
    structureState.controller.revision,
    structureState.controller.successfulRevision,
  ])

  useEffect(() => {
    const jobs = evaluationJobsRef.current
    return () => {
      Object.keys(jobs).forEach((key) => clearEvaluationJob(key as CadDocumentType))
      activePreflightRef.current?.cancel()
      activePreflightRef.current = null
      activeRunRef.current?.cancel()
      activeRunRef.current = null
    }
  }, [clearEvaluationJob])

  const structureIssues = preflight?.issues?.filter((issue) => issue.documentType === 'structure') ?? []
  const experimentIssues = preflight?.issues?.filter((issue) => issue.documentType !== 'structure') ?? []
  const structureDocument = attachPreflightMetadata(
    structureState.controller,
    structureIssues,
    evaluationTimeoutMs,
    setEvaluationTimeoutMs,
  )
  const experimentDocument = attachPreflightMetadata(
    experimentState.controller,
    experimentIssues,
    evaluationTimeoutMs,
    setEvaluationTimeoutMs,
  )
  const compatibility = useMemo<SimulationCompatibility>(() => {
    if (!experimentState.controller.simulationProgram) {
      return Object.freeze({ status: 'unavailable', issues: Object.freeze([]) })
    }
    if (
      !preflight ||
      preflight.structureRevision !== structureState.controller.revision ||
      preflight.experimentRevision !== experimentState.controller.revision ||
      preflight.issues === null
    ) {
      return Object.freeze({ status: 'checking', issues: Object.freeze([]) })
    }
    if (preflight.issues.length > 0) {
      return Object.freeze({ status: 'incompatible', issues: preflight.issues })
    }
    return Object.freeze({ status: 'compatible', issues: Object.freeze([]) })
  }, [
    experimentState.controller.revision,
    experimentState.controller.simulationProgram,
    preflight,
    structureState.controller.revision,
  ])

  const processActive = process.status === 'preparing' || process.status === 'running'
  const canRun =
    !processActive &&
    structureDocument.status === 'Ready' &&
    experimentDocument.status === 'Ready' &&
    structureDocument.successfulRevision === structureDocument.revision &&
    experimentDocument.successfulRevision === experimentDocument.revision &&
    compatibility.status === 'compatible'

  const run = useCallback(() => {
    if (compatibility.status !== 'compatible' || activeRunRef.current) return null
    const structureSnapshot = documentHandlersRef.current.structure?.getSnapshot()
    const experimentSnapshot = documentHandlersRef.current.experiment?.getSnapshot()
    if (
      !structureSnapshot ||
      !experimentSnapshot ||
      structureSnapshot.successfulRevision !== structureSnapshot.revision ||
      experimentSnapshot.successfulRevision !== experimentSnapshot.revision ||
      structureSnapshot.realization?.kind !== 'sample' ||
      experimentSnapshot.realization?.kind !== 'setup' ||
      !experimentSnapshot.compiledSource
    ) {
      return null
    }

    const requestId = createRequestId('simulation')
    const startedAt = Date.now()
    if (recordedDataRef.current) setStale(true)
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
    const cancel = runSimulationInIsolatedRunner(
      {
        type: 'run-simulation',
        requestId,
        structureRevision: structureSnapshot.revision,
        experimentRevision: experimentSnapshot.revision,
        compiledSource: experimentSnapshot.compiledSource,
        sample: structureSnapshot.realization,
        setup: experimentSnapshot.realization,
      },
      {
        onFailure(message) {
          if (activeRunRef.current?.requestId !== requestId) return
          activeRunRef.current = null
          setProcess(
            Object.freeze({
              runId: requestId,
              status: 'failed',
              engine: simulationEngine,
              stage: null,
              error: message,
              startedAt,
              finishedAt: Date.now(),
            }),
          )
        },
        onProgress(progress) {
          if (activeRunRef.current?.requestId !== requestId) return
          setProcess(
            Object.freeze({
              runId: requestId,
              status: 'running',
              engine: simulationEngine,
              stage: `${progress.task}: ${progress.stage}`,
              error: null,
              startedAt,
              finishedAt: null,
            }),
          )
        },
        onStart() {
          if (activeRunRef.current?.requestId !== requestId) return
          setProcess(
            Object.freeze({
              runId: requestId,
              status: 'running',
              engine: simulationEngine,
              stage: 'running',
              error: null,
              startedAt,
              finishedAt: null,
            }),
          )
        },
        onResponse(response) {
          if (activeRunRef.current?.requestId !== requestId) return
          activeRunRef.current = null
          if (response.type === 'run-simulation-error') {
            setProcess(
              Object.freeze({
                runId: requestId,
                status: 'failed',
                engine: simulationEngine,
                stage: null,
                error: response.message,
                startedAt,
                finishedAt: Date.now(),
              }),
            )
            return
          }
          const nextRecordedData = Object.freeze(
            Object.fromEntries(Object.entries(response.result.recordedData).map(([name, entry]) => [name, entry.data])),
          ) as RecordedData
          recordedDataRef.current = nextRecordedData
          setRecordedData(nextRecordedData)
          setProgramResult(response.result)
          const currentStructure = documentHandlersRef.current.structure?.getSnapshot()
          const currentExperiment = documentHandlersRef.current.experiment?.getSnapshot()
          setStale(
            currentStructure?.revision !== response.structureRevision ||
              currentExperiment?.revision !== response.experimentRevision,
          )
          setProcess(
            Object.freeze({
              runId: requestId,
              status: 'succeeded',
              engine: simulationEngine,
              stage: null,
              error: null,
              startedAt,
              finishedAt: Date.now(),
            }),
          )
        },
      },
    )
    activeRunRef.current = Object.freeze({ cancel, requestId, startedAt })
    return requestId
  }, [compatibility.status])

  const cancel = useCallback(() => {
    const active = activeRunRef.current
    if (!active) return
    activeRunRef.current = null
    active.cancel()
    setProcess(
      Object.freeze({
        runId: active.requestId,
        status: 'cancelled',
        engine: simulationEngine,
        stage: null,
        error: 'Simulation run was cancelled.',
        startedAt: active.startedAt,
        finishedAt: Date.now(),
      }),
    )
  }, [])

  const exportProgramResult = useCallback(
    () => (programResult ? exportSimulationResult(programResult) : null),
    [programResult],
  )

  const simulation: SimulationController = {
    canRun,
    cancel,
    compatibility,
    process,
    programResult,
    exportProgramResult,
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
