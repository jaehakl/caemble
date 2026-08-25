import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { releaseRecordedDataAttachments, simulate } from '@/features/cae/client'
import {
  emitRuntimeActivity,
  type RuntimeActivityCallback,
  type RuntimeActivityDetails,
} from '@/features/runtime-console/types'
import {
  EXPERIMENT_SIMULATION_PATH,
  addExperimentSourceFile,
  addExperimentTask,
  applyFrozenMaterialParameters,
  buildMeasurement,
  CadCompilationError,
  CadDocumentEvaluationError,
  deserializeCadScene,
  evaluateDocument,
  generateRandomVars,
  inspectDocument,
  normalizeVars,
  normalizeVarsSchema,
  removeExperimentSourceFile,
  removeExperimentTask,
  unresolvedMeasurementMaterialRoles,
  updateCadSource,
  updateExperimentSourceFile,
  varsSchemaFingerprint,
  type BuiltMeasurement,
  type CadDiagnostic,
  type CadScene,
  type EvaluatedExperimentSnapshot,
  type ExperimentSourceDocument,
  type RecordedData,
  type Vars,
} from '@/lib/cad'
import type { SimulationProgramManifest } from '@/lib/cad/simulation'
import { fetchCatalogRuntimeSlice } from '@/lib/catalog/references'
import { sourceCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import { assertCatalogKernelTasks } from '@/lib/catalog/solverValidation'
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
  candidateGeneration: number
  completedCandidateGeneration: number
  compiledSource: null
  diagnostics: readonly CadDiagnostic[]
  documentType: 'experiment'
  draftTaskNames: readonly string[]
  error: RunError | null
  evaluatedSnapshot: EvaluatedExperimentSnapshot | null
  evaluationTimeoutMs: EvaluationTimeoutMs
  generateCandidate: () => number | null
  handleAddExperimentFile: (path: string, source: string) => void
  handleAddExperimentTask: (taskName: string, source: string) => void
  handleExperimentFileChange: (path: string, source: string) => void
  handleRemoveExperimentFile: (path: string) => void
  handleRemoveExperimentTask: (taskName: string) => void
  handleRenderEnd: () => void
  handleRenderError: (message: string) => void
  handleRenderStart: () => void
  handleSimulationCodeChange: (source: string) => void
  handleSourceChange: (source: string) => void
  materialParameters: MeasurementMaterialParameters | null
  materialWarnings: readonly string[]
  readOnly: boolean
  measurement: BuiltMeasurement | null
  revision: number
  runIsBusy: boolean
  scene: CadScene | null
  sceneHash: string | null
  setEvaluationTimeoutMs: (timeout: EvaluationTimeoutMs) => void
  simulationProgram: SimulationProgramManifest | null
  sourceReadOnly: boolean
  status: AppStatus
  successfulCandidateGeneration: number
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

export type CandidateProvenance = 'editable' | 'persisted-measurement'

export type CandidateVarsRegeneratedEvent = Readonly<{
  reason: 'schema-changed' | 'invalid-candidate'
  vars: Readonly<Vars>
}>

export type UseCadWorkspaceOptions = Readonly<{
  candidateVars?: Readonly<Vars>
  candidateVarsPending?: boolean
  candidateProvenance?: CandidateProvenance
  frozenMaterialSnapshot?: unknown | null
  runtimeEnabled?: boolean
  resetKey?: string | number
  sourceOnlyMaterials?: boolean
  onActivity?: RuntimeActivityCallback
  onCandidateVarsRegenerated?: (event: CandidateVarsRegeneratedEvent) => void
}>

class MeasurementVarsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MeasurementVarsError'
  }
}

export function useCadWorkspace(
  experiment: ExperimentSourceDocument | null | undefined,
  onExperimentChange: ((document: ExperimentSourceDocument) => void) | undefined,
  {
    candidateVars,
    candidateVarsPending = false,
    candidateProvenance = 'editable',
    frozenMaterialSnapshot = null,
    runtimeEnabled = true,
    resetKey = 'default',
    sourceOnlyMaterials = false,
    onActivity,
    onCandidateVarsRegenerated,
  }: UseCadWorkspaceOptions = {},
) {
  const [diagnostics, setDiagnostics] = useState<readonly CadDiagnostic[]>([])
  const [draftTaskNames, setDraftTaskNames] = useState<readonly string[]>([])
  const [error, setError] = useState<RunError | null>(null)
  const [evaluatedSnapshot, setEvaluatedSnapshot] = useState<EvaluatedExperimentSnapshot | null>(null)
  const [evaluationTimeoutMs, setEvaluationTimeoutMs] = useState<EvaluationTimeoutMs>(3000)
  const [generation, setGeneration] = useState(0)
  const [completedCandidateGeneration, setCompletedCandidateGeneration] = useState(0)
  const [materialParameters, setMaterialParameters] = useState<MeasurementMaterialParameters | null>(null)
  const [materialWarnings, setMaterialWarnings] = useState<readonly string[]>([])
  const [builtMeasurement, setBuiltMeasurement] = useState<BuiltMeasurement | null>(null)
  const [revision, setRevision] = useState(0)
  const [scene, setScene] = useState<CadScene | null>(null)
  const [simulationProgram, setSimulationProgram] = useState<SimulationProgramManifest | null>(null)
  const [status, setStatus] = useState<AppStatus>('Ready')
  const [successfulCandidateGeneration, setSuccessfulCandidateGeneration] = useState(0)
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
  const candidateCacheRef = useRef<Readonly<{
    dependencyKey: string
    document: ExperimentSourceDocument
    fingerprint: string
    generation: number | null
    inputKey: string
    resetKey: string | number
    vars: Readonly<Vars>
    varsKey: string
  }> | null>(null)
  const completedCandidateGenerationRef = useRef(0)
  const editableMaterialEchoRef = useRef<Readonly<{
    dependencyKey: string
    document: ExperimentSourceDocument
    outputKey: string
    resetKey: string | number
    sourceOnlyMaterials: boolean
  }> | null>(null)
  const evaluationTimeoutRef = useRef<EvaluationTimeoutMs>(evaluationTimeoutMs)
  const generationRef = useRef(0)
  const lastSchemaFingerprintRef = useRef<string | null>(null)
  const onActivityRef = useRef(onActivity)
  const onCandidateVarsRegeneratedRef = useRef(onCandidateVarsRegenerated)
  const recordedDataRef = useRef<RecordedData | null>(null)
  const revisionRef = useRef(0)
  const statusRef = useRef<AppStatus>('Ready')
  const successfulRevisionRef = useRef(-1)
  const resetKeyRef = useRef<string | number>(resetKey)
  const preparedDocumentRef = useRef<Readonly<{
    catalog: Awaited<ReturnType<typeof fetchCatalogRuntimeSlice>>
    document: ExperimentSourceDocument
    inspection: Awaited<ReturnType<typeof inspectDocument>>
    resetKey: string | number
  }> | null>(null)

  builtMeasurementRef.current = builtMeasurement
  completedCandidateGenerationRef.current = completedCandidateGeneration
  evaluationTimeoutRef.current = evaluationTimeoutMs
  generationRef.current = generation
  onActivityRef.current = onActivity
  onCandidateVarsRegeneratedRef.current = onCandidateVarsRegenerated
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

  const varsKey = useMemo(() => stableInput(candidateVars ?? null), [candidateVars])
  const materialsKey = useMemo(() => stableInput(frozenMaterialSnapshot), [frozenMaterialSnapshot])
  const cachedCandidate = candidateCacheRef.current
  const editableMaterialEcho = editableMaterialEchoRef.current
  const candidateDependencyKey =
    candidateProvenance === 'editable' &&
    cachedCandidate &&
    cachedCandidate.document === experiment &&
    cachedCandidate.resetKey === resetKey &&
    (cachedCandidate.inputKey === varsKey || cachedCandidate.varsKey === varsKey)
      ? cachedCandidate.dependencyKey
      : varsKey
  const materialDependencyKey =
    candidateProvenance === 'editable' &&
    editableMaterialEcho !== null &&
    editableMaterialEcho.document === experiment &&
    editableMaterialEcho.resetKey === resetKey &&
    editableMaterialEcho.sourceOnlyMaterials === sourceOnlyMaterials &&
    editableMaterialEcho.outputKey === materialsKey
      ? editableMaterialEcho.dependencyKey
      : materialsKey

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
    setDraftTaskNames([])
    setError(null)
    const resetPreview = resetKeyRef.current !== resetKey
    resetKeyRef.current = resetKey
    if (resetPreview) {
      candidateCacheRef.current = null
      editableMaterialEchoRef.current = null
      lastSchemaFingerprintRef.current = null
      preparedDocumentRef.current = null
      setEvaluatedSnapshot(null)
    }
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
      candidateCacheRef.current = null
      editableMaterialEchoRef.current = null
      lastSchemaFingerprintRef.current = null
      preparedDocumentRef.current = null
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
    const explicitGeneration = generation !== completedCandidateGenerationRef.current
    const prepared =
      preparedDocumentRef.current?.document === evaluationDocument && preparedDocumentRef.current.resetKey === resetKey
        ? preparedDocumentRef.current
        : null
    if (candidateProvenance !== 'editable') editableMaterialEchoRef.current = null
    if (prepared) {
      updateStatus('Evaluating')
    } else {
      updateStatus('Checking')
      emitRuntimeActivity(onActivityRef.current, {
        source: 'cad',
        level: 'info',
        phase: 'source.checking',
        message: 'Experiment source 검사를 시작했습니다.',
        details: { revision: requestRevision },
      })
    }

    void (
      prepared
        ? Promise.resolve(prepared)
        : fetchCatalogRuntimeSlice(evaluationDocument.sourceBundle).then(async (catalog) => {
            if (abort.signal.aborted || revisionRef.current !== requestRevision) throw abort.signal.reason
            emitRuntimeActivity(onActivityRef.current, {
              source: 'cad',
              level: 'info',
              phase: 'compile.started',
              message: 'CAD source compile을 시작했습니다.',
              details: { revision: requestRevision, catalogRevision: catalog.catalogRevision },
            })
            const inspection = await inspectDocument(evaluationDocument, {
              catalog,
              signal: abort.signal,
              timeoutMs: evaluationTimeoutRef.current,
            })
            if (abort.signal.aborted || revisionRef.current !== requestRevision) throw abort.signal.reason
            emitRuntimeActivity(onActivityRef.current, {
              source: 'cad',
              level: 'info',
              phase: 'compile.completed',
              message: 'CAD source compile을 완료했습니다.',
              details: { revision: requestRevision, variableCount: Object.keys(inspection.varsSchema).length },
            })
            const nextPrepared = Object.freeze({ catalog, document: evaluationDocument, inspection, resetKey })
            preparedDocumentRef.current = nextPrepared
            return nextPrepared
          })
    )
      .then(async ({ catalog, inspection }) => {
        if (abort.signal.aborted || revisionRef.current !== requestRevision) return
        setVarsSchema(inspection.varsSchema)
        const fingerprint = varsSchemaFingerprint(inspection.varsSchema)
        const schemaChanged =
          lastSchemaFingerprintRef.current !== null && lastSchemaFingerprintRef.current !== fingerprint
        lastSchemaFingerprintRef.current = fingerprint
        const cached = candidateCacheRef.current
        const reusableCachedCandidate =
          cached?.fingerprint === fingerprint && (cached.inputKey === varsKey || cached.varsKey === varsKey)
            ? cached.vars
            : null
        const pendingGeneratedCandidate =
          explicitGeneration &&
          cached?.document === evaluationDocument &&
          cached.resetKey === resetKey &&
          cached.fingerprint === fingerprint &&
          cached.generation === generation
            ? cached.vars
            : null
        const generateCandidateVars = (reason?: CandidateVarsRegeneratedEvent['reason']) => {
          if (pendingGeneratedCandidate && cached) {
            candidateCacheRef.current = Object.freeze({
              ...cached,
              dependencyKey: candidateDependencyKey,
              inputKey: varsKey,
            })
            return pendingGeneratedCandidate
          }
          if (reusableCachedCandidate && !explicitGeneration) return reusableCachedCandidate
          const generated = generateRandomVars(inspection.varsSchema)
          candidateCacheRef.current = Object.freeze({
            dependencyKey: candidateDependencyKey,
            document: evaluationDocument,
            fingerprint,
            generation: explicitGeneration ? generation : null,
            inputKey: varsKey,
            resetKey,
            vars: generated,
            varsKey: stableInput(generated),
          })
          if (reason) onCandidateVarsRegeneratedRef.current?.(Object.freeze({ reason, vars: generated }))
          return generated
        }
        let nextVars: Readonly<Vars>
        if (candidateProvenance === 'persisted-measurement' && candidateVarsPending && candidateVars === undefined) {
          updateStatus('Checking')
          return
        } else if (explicitGeneration) {
          nextVars = generateCandidateVars()
        } else if (candidateProvenance === 'persisted-measurement') {
          candidateCacheRef.current = null
          try {
            if (candidateVars === undefined) throw new Error('The saved Measurement does not contain Candidate vars.')
            const normalizedSchema = normalizeVarsSchema(inspection.varsSchema, 'Experiment')
            nextVars = normalizeVars(normalizedSchema, candidateVars, 'Measurement')
          } catch (cause: unknown) {
            const detail = cause instanceof Error ? cause.message : String(cause)
            throw new MeasurementVarsError(
              `Saved Measurement vars do not match the current Experiment varsSchema. ${detail} Open the Experiment revision used to create this Measurement or generate a new editable Candidate.`,
            )
          }
        } else if (schemaChanged) {
          nextVars = generateCandidateVars('schema-changed')
        } else if (reusableCachedCandidate) {
          nextVars = reusableCachedCandidate
        } else if (candidateVars === undefined) {
          nextVars = generateCandidateVars()
        } else {
          try {
            const normalizedSchema = normalizeVarsSchema(inspection.varsSchema, 'Experiment')
            nextVars = normalizeVars(normalizedSchema, candidateVars, 'Candidate')
            candidateCacheRef.current = null
          } catch {
            nextVars = generateCandidateVars('invalid-candidate')
          }
        }
        updateStatus('Evaluating')
        emitRuntimeActivity(onActivityRef.current, {
          source: 'cad',
          level: 'info',
          phase: 'evaluate.started',
          message: 'CAD 구조 평가를 시작했습니다.',
          details: { revision: requestRevision },
        })
        const snapshot = await evaluateDocument(
          { document: evaluationDocument, vars: nextVars },
          { catalog, signal: abort.signal, timeoutMs: evaluationTimeoutRef.current },
        )
        if (abort.signal.aborted || revisionRef.current !== requestRevision) return
        emitRuntimeActivity(onActivityRef.current, {
          source: 'cad',
          level: 'info',
          phase: 'evaluate.completed',
          message: 'CAD 구조 평가를 완료했습니다.',
          details: {
            revision: requestRevision,
            taskCount: Object.keys(snapshot.taskScenes).length,
            sourceHash: snapshot.sourceHash,
          },
        })
        updateStatus('Resolving Materials')
        emitRuntimeActivity(onActivityRef.current, {
          source: 'cad',
          level: 'info',
          phase: 'materials.resolving',
          message: 'Material snapshot을 확인하고 있습니다.',
          details: { revision: requestRevision },
        })
        const resolution = await resolveDocumentMaterials(
          snapshot,
          explicitGeneration ? null : frozenMaterialSnapshot,
          sourceOnlyMaterials,
        )
        if (abort.signal.aborted || revisionRef.current !== requestRevision) return
        const commonScene = applyFrozenMaterialParameters(
          deserializeCadScene(snapshot.renderScene),
          resolution.materialParameters,
        )
        const nextTaskScenes = Object.freeze(
          Object.fromEntries(
            Object.entries(snapshot.taskRenderScenes).map(([name, serialized]) => [
              name,
              applyFrozenMaterialParameters(deserializeCadScene(serialized), resolution.taskMaterialParameters[name]),
            ]),
          ),
        )
        const resolutionWarnings = Object.freeze([
          ...resolution.warnings,
          ...Object.entries(resolution.taskMaterialWarnings).flatMap(([name, items]) =>
            items.map((item) => `${name}: ${item}`),
          ),
        ])
        const unresolved = unresolvedMeasurementMaterialRoles(snapshot)
        const registeredCatalog = sourceCatalogRuntimeSlice(snapshot.sourceHash)
        const reportReady = (details: RuntimeActivityDetails) =>
          emitRuntimeActivity(onActivityRef.current, {
            source: 'cad',
            level: 'info',
            phase: 'workspace.ready',
            message: 'CAD 구조가 준비되었습니다.',
            details,
          })
        const completeCandidateGeneration = () => {
          if (!explicitGeneration) return
          completedCandidateGenerationRef.current = generation
          setCompletedCandidateGeneration(generation)
          setSuccessfulCandidateGeneration(generation)
        }
        const rememberEditableMaterialOutput = (outputKey: string) => {
          if (candidateProvenance !== 'editable') return
          editableMaterialEchoRef.current = Object.freeze({
            dependencyKey: materialDependencyKey,
            document: evaluationDocument,
            outputKey,
            resetKey,
            sourceOnlyMaterials,
          })
        }
        if (unresolved.length > 0) {
          const nextDraftTaskNames = assertCatalogKernelTasks(registeredCatalog, snapshot.simulationProgram)
          setEvaluatedSnapshot(snapshot)
          setDraftTaskNames(nextDraftTaskNames)
          setVariables(snapshot.variables)
          setVarsSchema(snapshot.varsSchema)
          setScene(commonScene)
          setTaskScenes(nextTaskScenes)
          setSimulationProgram(nextDraftTaskNames.length > 0 ? null : snapshot.simulationProgram)
          setMaterialWarnings(
            Object.freeze([
              ...resolutionWarnings,
              `Measurement requires resolved Material roles: ${unresolved.join(', ')}.`,
            ]),
          )
          rememberEditableMaterialOutput(materialsKey)
          completeCandidateGeneration()
          successfulRevisionRef.current = requestRevision
          setSuccessfulRevision(requestRevision)
          updateStatus('Ready')
          reportReady({ revision: requestRevision, unresolvedMaterialRoles: unresolved.length })
          return
        }
        const nextDraftTaskNames = assertCatalogKernelTasks(registeredCatalog, snapshot.simulationProgram, {
          experiment: commonScene,
          tasks: nextTaskScenes,
        })
        if (nextDraftTaskNames.length > 0) {
          setEvaluatedSnapshot(snapshot)
          setDraftTaskNames(nextDraftTaskNames)
          setVariables(snapshot.variables)
          setVarsSchema(snapshot.varsSchema)
          setScene(commonScene)
          setTaskScenes(nextTaskScenes)
          setSimulationProgram(null)
          setMaterialParameters(null)
          setMaterialWarnings(resolutionWarnings)
          rememberEditableMaterialOutput(materialsKey)
          completeCandidateGeneration()
          successfulRevisionRef.current = requestRevision
          setSuccessfulRevision(requestRevision)
          updateStatus('Ready')
          reportReady({ revision: requestRevision, draftTaskCount: nextDraftTaskNames.length })
          return
        }
        const built = buildMeasurement(snapshot, resolution)
        const persistedMaterials: MeasurementMaterialParameters = Object.freeze({
          schemaVersion: 2,
          experiment: built.materialParameters,
          tasks: built.taskMaterialParameters,
        })
        builtMeasurementRef.current = built
        setBuiltMeasurement(built)
        setEvaluatedSnapshot(snapshot)
        setVariables(snapshot.variables)
        setVarsSchema(snapshot.varsSchema)
        setScene(commonScene)
        setTaskScenes(nextTaskScenes)
        setSimulationProgram(snapshot.simulationProgram)
        setMaterialParameters(persistedMaterials)
        setMaterialWarnings(resolutionWarnings)
        rememberEditableMaterialOutput(stableInput(persistedMaterials))
        completeCandidateGeneration()
        successfulRevisionRef.current = requestRevision
        setSuccessfulRevision(requestRevision)
        updateStatus('Ready')
        reportReady({ revision: requestRevision, warningCount: resolutionWarnings.length })
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted || revisionRef.current !== requestRevision) return
        if (explicitGeneration) {
          completedCandidateGenerationRef.current = generation
          setCompletedCandidateGeneration(generation)
        }
        const compilation = cause instanceof CadCompilationError ? cause : null
        const evaluation = cause instanceof CadDocumentEvaluationError ? cause : null
        const measurementVars = cause instanceof MeasurementVarsError
        setDiagnostics(compilation?.diagnostics ?? evaluation?.diagnostics ?? [])
        setError({
          title: compilation
            ? compilation.errorType === 'policy'
              ? 'Source Policy Error'
              : compilation.errorType === 'type'
                ? 'Type Error'
                : 'Compile Error'
            : measurementVars
              ? 'Measurement Vars Error'
              : 'Experiment Error',
          message: cause instanceof Error ? cause.message : String(cause),
          ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {}),
        })
        updateStatus('Error')
        emitRuntimeActivity(onActivityRef.current, {
          source: 'cad',
          level: 'error',
          phase: compilation ? 'compile.failed' : 'evaluate.failed',
          message: cause instanceof Error ? cause.message : 'CAD 구조 처리에 실패했습니다.',
          details: {
            revision: requestRevision,
            errorName: cause instanceof Error ? cause.name : 'UnknownError',
            diagnosticCount: compilation?.diagnostics.length ?? evaluation?.diagnostics.length ?? 0,
          },
        })
      })

    return () => {
      abort.abort()
      if (activeEvaluationRef.current === abort) activeEvaluationRef.current = null
    }
    // Canonical dependency keys keep generated Candidate/material echoes from restarting the same evaluation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    experiment,
    candidateProvenance,
    candidateVarsPending,
    generation,
    invalidateSimulation,
    materialDependencyKey,
    resetKey,
    sourceOnlyMaterials,
    updateStatus,
    candidateDependencyKey,
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
    if (!experiment || statusRef.current === 'Rendering') return null
    const nextGeneration = generationRef.current + 1
    generationRef.current = nextGeneration
    setGeneration(nextGeneration)
    return nextGeneration
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
  const handleAddExperimentFile = useCallback(
    (path: string, source: string) => {
      if (experiment && onExperimentChange) onExperimentChange(addExperimentSourceFile(experiment, path, source))
    },
    [experiment, onExperimentChange],
  )
  const handleRemoveExperimentTask = useCallback(
    (taskName: string) => {
      if (experiment && onExperimentChange) onExperimentChange(removeExperimentTask(experiment, taskName))
    },
    [experiment, onExperimentChange],
  )
  const handleRemoveExperimentFile = useCallback(
    (path: string) => {
      if (experiment && onExperimentChange) onExperimentChange(removeExperimentSourceFile(experiment, path))
    },
    [experiment, onExperimentChange],
  )
  const handleRenderStart = useCallback(() => {
    if (statusRef.current !== 'Ready') return
    updateStatus('Rendering')
    emitRuntimeActivity(onActivityRef.current, {
      source: 'cad',
      level: 'info',
      phase: 'render.started',
      message: '3D CAD View 렌더링을 시작했습니다.',
    })
  }, [updateStatus])
  const handleRenderEnd = useCallback(() => {
    if (statusRef.current !== 'Rendering') return
    updateStatus('Ready')
    emitRuntimeActivity(onActivityRef.current, {
      source: 'cad',
      level: 'info',
      phase: 'render.completed',
      message: '3D CAD View 렌더링을 완료했습니다.',
    })
  }, [updateStatus])
  const handleRenderError = useCallback(
    (message: string) => {
      if (statusRef.current === 'Error') return
      setError({ title: 'Rendering Error', message })
      updateStatus('Error')
      emitRuntimeActivity(onActivityRef.current, {
        source: 'cad',
        level: 'error',
        phase: 'render.failed',
        message,
      })
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
    simulationProgram &&
    Object.keys(simulationProgram.tasks).length > 0,
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
      onActivity: onActivityRef.current,
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
          Object.entries(evaluatedSnapshot?.taskRenderScenes ?? {}).map(([name, value]) => [name, value.sceneHash]),
        ),
      ),
    [evaluatedSnapshot],
  )
  const runIsBusy = ['Checking', 'Compiling', 'Evaluating', 'Resolving Materials', 'Rendering'].includes(status)
  const experimentDocument: CadDocumentController = {
    candidateGeneration: generation,
    completedCandidateGeneration,
    compiledSource: null,
    diagnostics,
    documentType: 'experiment',
    draftTaskNames,
    error,
    evaluatedSnapshot,
    evaluationTimeoutMs,
    generateCandidate,
    handleAddExperimentFile,
    handleAddExperimentTask,
    handleExperimentFileChange,
    handleRemoveExperimentFile,
    handleRemoveExperimentTask,
    handleRenderEnd,
    handleRenderError,
    handleRenderStart,
    handleSimulationCodeChange,
    handleSourceChange,
    materialParameters,
    materialWarnings,
    readOnly: sourceReadOnly,
    measurement: builtMeasurement,
    revision,
    runIsBusy,
    scene,
    sceneHash: evaluatedSnapshot?.renderScene.sceneHash ?? null,
    setEvaluationTimeoutMs,
    simulationProgram,
    sourceReadOnly,
    status,
    successfulCandidateGeneration,
    successfulRevision,
    taskSceneHashes,
    taskScenes,
    variables,
    varsSchema,
  }
  const simulation: SimulationController = { canRun, cancel, process, recordedData, run, stale }
  return { experimentDocument, simulation }
}
