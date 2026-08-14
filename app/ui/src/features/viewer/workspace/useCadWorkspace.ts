import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { releaseRecordedDataAttachments, simulate } from '@/features/cae/client'
import {
  EXPERIMENT_SIMULATION_PATH,
  addExperimentTask,
  applyFrozenMaterialParameters,
  buildMeasurement,
  CadCompilationError,
  CadDocumentEvaluationError,
  deserializeCadScene,
  evaluateDocument,
  generateRandomVars,
  inspectDocument,
  removeExperimentTask,
  updateCadSource,
  updateExperimentSourceFile,
  type BuiltMeasurement,
  type CadDiagnostic,
  type CadScene,
  type EvaluatedExperimentSnapshot,
  type ExperimentSourceDocument,
  type GeometryDraftOverlay,
  type RecordedData,
  type Vars,
} from '@/lib/cad'
import type { SimulationProgramManifest } from '@/lib/cad/simulation'
import type { MeasurementMaterialParameters } from '../persistence/contracts'
import { resolveDocumentMaterials } from '../persistence/resolveMaterials'
import type { SimulationProcess } from './simulationUiTypes'

export type AppStatus =
  'Dirty' | 'Checking' | 'Compiling' | 'Evaluating' | 'Resolving Materials' | 'Ready' | 'Rendering' | 'Error'
export type EvaluationTimeoutMs = 3000 | 10000 | 30000

export type RunError = Readonly<{
  title: string
  message: string
  stack?: string
}>

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

function requestId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

function stableInput(value: unknown) {
  return JSON.stringify(value)
}

export type CadDocumentController = Readonly<{
  compiledSource: null
  diagnostics: readonly CadDiagnostic[]
  documentType: 'experiment'
  error: RunError | null
  evaluatedSnapshot: EvaluatedExperimentSnapshot | null
  evaluationTimeoutMs: EvaluationTimeoutMs
  generateCandidate: () => void
  handleAddExperimentTask: (taskName: string, source: string) => void
  handleExperimentFileChange: (path: string, source: string) => void
  handleRemoveExperimentTask: (taskName: string) => void
  handleRenderEnd: () => void
  handleRenderError: (message: string) => void
  handleRenderStart: () => void
  handleSimulationCodeChange: (source: string) => void
  handleSourceChange: (source: string) => void
  materialParameters: MeasurementMaterialParameters | null
  materialWarnings: readonly string[]
  readOnly: boolean
  previewStale: boolean
  measurement: BuiltMeasurement | null
  revision: number
  runIsBusy: boolean
  scene: CadScene | null
  sceneHash: string | null
  setEvaluationTimeoutMs: (timeout: EvaluationTimeoutMs) => void
  simulationProgram: SimulationProgramManifest | null
  sourceReadOnly: boolean
  status: AppStatus
  successfulRevision: number
  taskSceneHashes: Readonly<Record<string, string>>
  taskScenes: Readonly<Record<string, CadScene>>
  variables: Readonly<Vars> | null
  varsSchema: EvaluatedExperimentSnapshot['varsSchema'] | null
}>

export type SimulationController = Readonly<{
  canRun: boolean
  cancel: () => void
  process: SimulationProcess
  recordedData: RecordedData | null
  run: () => string | null
  stale: boolean
}>

export function useCadWorkspace(
  experiment: ExperimentSourceDocument | null | undefined,
  onExperimentChange: ((document: ExperimentSourceDocument) => void) | undefined,
  candidateVars?: Readonly<Vars>,
  frozenMaterialSnapshot: unknown | null = null,
  runtimeEnabled = true,
  geometryDrafts?: GeometryDraftOverlay,
  resetKey: string | number = 'default',
  sourceOnlyMaterials = false,
) {
  const [diagnostics, setDiagnostics] = useState<readonly CadDiagnostic[]>([])
  const [error, setError] = useState<RunError | null>(null)
  const [evaluatedSnapshot, setEvaluatedSnapshot] = useState<EvaluatedExperimentSnapshot | null>(null)
  const [evaluationTimeoutMs, setEvaluationTimeoutMs] = useState<EvaluationTimeoutMs>(3000)
  const [generation, setGeneration] = useState(0)
  const [materialParameters, setMaterialParameters] = useState<MeasurementMaterialParameters | null>(null)
  const [materialWarnings, setMaterialWarnings] = useState<readonly string[]>([])
  const [builtMeasurement, setBuiltMeasurement] = useState<BuiltMeasurement | null>(null)
  const [revision, setRevision] = useState(0)
  const [scene, setScene] = useState<CadScene | null>(null)
  const [simulationProgram, setSimulationProgram] = useState<SimulationProgramManifest | null>(null)
  const [status, setStatus] = useState<AppStatus>('Ready')
  const [successfulRevision, setSuccessfulRevision] = useState(-1)
  const [taskScenes, setTaskScenes] = useState<Readonly<Record<string, CadScene>>>(Object.freeze({}))
  const [variables, setVariables] = useState<Readonly<Vars> | null>(null)
  const [varsSchema, setVarsSchema] = useState<EvaluatedExperimentSnapshot['varsSchema'] | null>(null)
  const [process, setProcess] = useState<SimulationProcess>(idleSimulationProcess)
  const [recordedData, setRecordedData] = useState<RecordedData | null>(null)
  const [stale, setStale] = useState(false)

  const activeEvaluationRef = useRef<AbortController | null>(null)
  const activeRunRef = useRef<Readonly<{
    abort: AbortController
    requestId: string
    runId: string | null
    startedAt: number
  }> | null>(null)
  const builtMeasurementRef = useRef<BuiltMeasurement | null>(null)
  const evaluationTimeoutRef = useRef<EvaluationTimeoutMs>(evaluationTimeoutMs)
  const lastHandledGenerationRef = useRef(0)
  const recordedDataRef = useRef<RecordedData | null>(null)
  const revisionRef = useRef(0)
  const statusRef = useRef<AppStatus>('Ready')
  const successfulRevisionRef = useRef(-1)
  const resetKeyRef = useRef<string | number>(resetKey)

  builtMeasurementRef.current = builtMeasurement
  evaluationTimeoutRef.current = evaluationTimeoutMs
  recordedDataRef.current = recordedData
  statusRef.current = status
  successfulRevisionRef.current = successfulRevision

  const updateStatus = useCallback((next: AppStatus) => {
    statusRef.current = next
    setStatus(next)
  }, [])

  const invalidateSimulation = useCallback(() => {
    if (recordedDataRef.current) setStale(true)
    const active = activeRunRef.current
    if (!active) return
    activeRunRef.current = null
    active.abort.abort()
    setProcess(
      Object.freeze({
        runId: active.runId ?? active.requestId,
        status: 'cancelled',
        engine: simulationEngine,
        stage: null,
        error: 'Simulation run was invalidated by an Experiment or candidate change.',
        startedAt: active.startedAt,
        finishedAt: Date.now(),
      }),
    )
  }, [])

  const varsKey = stableInput(candidateVars ?? null)
  const materialsKey = stableInput(frozenMaterialSnapshot)

  useEffect(() => {
    if (!runtimeEnabled) invalidateSimulation()
  }, [invalidateSimulation, runtimeEnabled])

  useEffect(() => {
    activeEvaluationRef.current?.abort()
    invalidateSimulation()
    const requestRevision = revisionRef.current + 1
    revisionRef.current = requestRevision
    setRevision(requestRevision)
    setSuccessfulRevision(-1)
    successfulRevisionRef.current = -1
    setDiagnostics([])
    setError(null)
    const resetPreview = resetKeyRef.current !== resetKey
    resetKeyRef.current = resetKey
    if (resetPreview) setEvaluatedSnapshot(null)
    setBuiltMeasurement(null)
    builtMeasurementRef.current = null
    setMaterialParameters(null)
    setMaterialWarnings([])
    if (resetPreview) {
      setScene(null)
      setTaskScenes(Object.freeze({}))
    }
    setSimulationProgram(null)
    setVariables(null)

    if (!experiment) {
      setEvaluatedSnapshot(null)
      setScene(null)
      setTaskScenes(Object.freeze({}))
      setVarsSchema(null)
      updateStatus('Ready')
      return
    }

    const evaluationDocument = experiment

    const abort = new AbortController()
    activeEvaluationRef.current = abort
    updateStatus('Checking')
    const explicitGeneration = generation !== lastHandledGenerationRef.current
    if (explicitGeneration) lastHandledGenerationRef.current = generation

    void inspectDocument(evaluationDocument, {
      geometryDrafts,
      signal: abort.signal,
      timeoutMs: evaluationTimeoutRef.current,
    })
      .then(async (inspection) => {
        if (abort.signal.aborted || revisionRef.current !== requestRevision) return
        setVarsSchema(inspection.varsSchema)
        const nextVars =
          explicitGeneration || candidateVars === undefined ? generateRandomVars(inspection.varsSchema) : candidateVars
        updateStatus('Evaluating')
        const snapshot = await evaluateDocument(
          { document: evaluationDocument, vars: nextVars },
          { geometryDrafts, signal: abort.signal, timeoutMs: evaluationTimeoutRef.current },
        )
        if (abort.signal.aborted || revisionRef.current !== requestRevision) return
        updateStatus('Resolving Materials')
        const resolution = await resolveDocumentMaterials(
          snapshot,
          explicitGeneration ? null : frozenMaterialSnapshot,
          sourceOnlyMaterials,
        )
        if (abort.signal.aborted || revisionRef.current !== requestRevision) return
        const built = buildMeasurement(snapshot, resolution)
        const commonScene = applyFrozenMaterialParameters(deserializeCadScene(snapshot.scene), built.materialParameters)
        const nextTaskScenes = Object.freeze(
          Object.fromEntries(
            Object.entries(snapshot.taskScenes).map(([name, serialized]) => [
              name,
              applyFrozenMaterialParameters(deserializeCadScene(serialized), built.taskMaterialParameters[name]),
            ]),
          ),
        )
        const persistedMaterials: MeasurementMaterialParameters = Object.freeze({
          schemaVersion: 2,
          experiment: built.materialParameters,
          tasks: built.taskMaterialParameters,
        })
        const warnings = Object.freeze([
          ...built.materialWarnings,
          ...Object.entries(built.taskMaterialWarnings).flatMap(([name, items]) =>
            items.map((item) => `${name}: ${item}`),
          ),
        ])
        builtMeasurementRef.current = built
        setBuiltMeasurement(built)
        setEvaluatedSnapshot(snapshot)
        setVariables(snapshot.variables)
        setVarsSchema(snapshot.varsSchema)
        setScene(commonScene)
        setTaskScenes(nextTaskScenes)
        setSimulationProgram(snapshot.simulationProgram)
        setMaterialParameters(persistedMaterials)
        setMaterialWarnings(warnings)
        successfulRevisionRef.current = requestRevision
        setSuccessfulRevision(requestRevision)
        updateStatus('Ready')
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted || revisionRef.current !== requestRevision) return
        const compilation = cause instanceof CadCompilationError ? cause : null
        const evaluation = cause instanceof CadDocumentEvaluationError ? cause : null
        setDiagnostics(compilation?.diagnostics ?? evaluation?.diagnostics ?? [])
        setError({
          title: compilation
            ? compilation.errorType === 'policy'
              ? 'Source Policy Error'
              : compilation.errorType === 'type'
                ? 'Type Error'
                : 'Compile Error'
            : 'Experiment Error',
          message: cause instanceof Error ? cause.message : String(cause),
          ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {}),
        })
        updateStatus('Error')
      })

    return () => {
      abort.abort()
      if (activeEvaluationRef.current === abort) activeEvaluationRef.current = null
    }
    // Canonical keys deliberately avoid reevaluating when parent state reuses the same persisted values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    experiment,
    generation,
    geometryDrafts,
    invalidateSimulation,
    materialsKey,
    resetKey,
    sourceOnlyMaterials,
    updateStatus,
    varsKey,
  ])

  useEffect(
    () => () => {
      activeEvaluationRef.current?.abort()
      activeRunRef.current?.abort.abort()
      releaseRecordedDataAttachments(recordedDataRef.current)
    },
    [],
  )

  const sourceReadOnly = !onExperimentChange
  const generateCandidate = useCallback(() => {
    if (!experiment || statusRef.current === 'Rendering') return
    setGeneration((value) => value + 1)
  }, [experiment])
  const handleSourceChange = useCallback(
    (source: string) => {
      if (experiment && onExperimentChange) onExperimentChange(updateCadSource(experiment, source))
    },
    [experiment, onExperimentChange],
  )
  const handleSimulationCodeChange = useCallback(
    (source: string) => {
      if (experiment && onExperimentChange) {
        onExperimentChange(updateExperimentSourceFile(experiment, EXPERIMENT_SIMULATION_PATH, source))
      }
    },
    [experiment, onExperimentChange],
  )
  const handleExperimentFileChange = useCallback(
    (path: string, source: string) => {
      if (experiment && onExperimentChange) onExperimentChange(updateExperimentSourceFile(experiment, path, source))
    },
    [experiment, onExperimentChange],
  )
  const handleAddExperimentTask = useCallback(
    (taskName: string, source: string) => {
      if (experiment && onExperimentChange) onExperimentChange(addExperimentTask(experiment, taskName, source))
    },
    [experiment, onExperimentChange],
  )
  const handleRemoveExperimentTask = useCallback(
    (taskName: string) => {
      if (experiment && onExperimentChange) onExperimentChange(removeExperimentTask(experiment, taskName))
    },
    [experiment, onExperimentChange],
  )
  const handleRenderStart = useCallback(() => {
    if (statusRef.current === 'Ready') updateStatus('Rendering')
  }, [updateStatus])
  const handleRenderEnd = useCallback(() => {
    if (statusRef.current === 'Rendering') updateStatus('Ready')
  }, [updateStatus])
  const handleRenderError = useCallback(
    (message: string) => {
      if (statusRef.current === 'Error') return
      setError({ title: 'Rendering Error', message })
      updateStatus('Error')
    },
    [updateStatus],
  )

  const processActive = process.status === 'preparing' || process.status === 'running'
  const canRun = Boolean(
    runtimeEnabled &&
    !processActive &&
    status === 'Ready' &&
    successfulRevision === revision &&
    builtMeasurement &&
    simulationProgram,
  )

  const run = useCallback(() => {
    const built = builtMeasurementRef.current
    if (
      !runtimeEnabled ||
      !built ||
      activeRunRef.current ||
      statusRef.current !== 'Ready' ||
      successfulRevisionRef.current !== revisionRef.current
    ) {
      return null
    }
    const id = requestId('simulation')
    const startedAt = Date.now()
    releaseRecordedDataAttachments(recordedDataRef.current)
    recordedDataRef.current = null
    setRecordedData(null)
    setStale(false)
    setProcess(
      Object.freeze({
        runId: id,
        status: 'preparing',
        engine: simulationEngine,
        stage: 'startup',
        error: null,
        startedAt,
        finishedAt: null,
      }),
    )
    const abort = new AbortController()
    activeRunRef.current = Object.freeze({ abort, requestId: id, runId: null, startedAt })
    void simulate(built, {
      signal: abort.signal,
      onRecord(name, tensor) {
        if (activeRunRef.current?.requestId !== id) return
        const next = Object.freeze({ ...(recordedDataRef.current ?? {}), [name]: tensor }) as RecordedData
        recordedDataRef.current = next
        setRecordedData(next)
      },
      onProgress(progress) {
        const active = activeRunRef.current
        if (active?.requestId !== id) return
        if (active.runId !== progress.runId) activeRunRef.current = Object.freeze({ ...active, runId: progress.runId })
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
      onStatus(nextStatus) {
        const active = activeRunRef.current
        if (active?.requestId !== id) return
        setProcess(
          Object.freeze({
            runId: active.runId ?? id,
            status: nextStatus === 'validating' ? 'preparing' : 'running',
            engine: simulationEngine,
            stage: nextStatus,
            error: null,
            startedAt,
            finishedAt: null,
          }),
        )
      },
    })
      .then((result) => {
        const active = activeRunRef.current
        if (active?.requestId !== id) {
          releaseRecordedDataAttachments(result)
          return
        }
        activeRunRef.current = null
        recordedDataRef.current = result
        setRecordedData(result)
        setStale(builtMeasurementRef.current !== built)
        setProcess(
          Object.freeze({
            runId: active.runId ?? id,
            status: 'succeeded',
            engine: simulationEngine,
            stage: null,
            error: null,
            startedAt,
            finishedAt: Date.now(),
          }),
        )
      })
      .catch((cause: unknown) => {
        const active = activeRunRef.current
        if (active?.requestId !== id) return
        activeRunRef.current = null
        releaseRecordedDataAttachments(recordedDataRef.current)
        recordedDataRef.current = null
        setRecordedData(null)
        setProcess(
          Object.freeze({
            runId: active.runId ?? id,
            status: 'failed',
            engine: simulationEngine,
            stage: null,
            error: cause instanceof Error ? cause.message : String(cause),
            startedAt,
            finishedAt: Date.now(),
          }),
        )
      })
    return id
  }, [runtimeEnabled])

  const cancel = useCallback(() => {
    const active = activeRunRef.current
    if (!active) return
    activeRunRef.current = null
    active.abort.abort()
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

  const taskSceneHashes = useMemo(
    () =>
      Object.freeze(
        Object.fromEntries(
          Object.entries(evaluatedSnapshot?.taskScenes ?? {}).map(([name, value]) => [name, value.sceneHash]),
        ),
      ),
    [evaluatedSnapshot],
  )
  const runIsBusy = ['Checking', 'Compiling', 'Evaluating', 'Resolving Materials', 'Rendering'].includes(status)
  const experimentDocument: CadDocumentController = {
    compiledSource: null,
    diagnostics,
    documentType: 'experiment',
    error,
    evaluatedSnapshot,
    evaluationTimeoutMs,
    generateCandidate,
    handleAddExperimentTask,
    handleExperimentFileChange,
    handleRemoveExperimentTask,
    handleRenderEnd,
    handleRenderError,
    handleRenderStart,
    handleSimulationCodeChange,
    handleSourceChange,
    materialParameters,
    materialWarnings,
    readOnly: sourceReadOnly,
    previewStale: Boolean(scene && successfulRevision !== revision),
    measurement: builtMeasurement,
    revision,
    runIsBusy,
    scene,
    sceneHash: evaluatedSnapshot?.scene.sceneHash ?? null,
    setEvaluationTimeoutMs,
    simulationProgram,
    sourceReadOnly,
    status,
    successfulRevision,
    taskSceneHashes,
    taskScenes,
    variables,
    varsSchema,
  }
  const simulation: SimulationController = { canRun, cancel, process, recordedData, run, stale }
  return { experimentDocument, simulation }
}
