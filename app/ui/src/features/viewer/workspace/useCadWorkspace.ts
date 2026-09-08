import { measurementMaterialSnapshot } from '@/lib/cad/execution/measurement'
import { readMeasurementMaterialSnapshot } from '../persistence/contracts'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  emitRuntimeActivity,
  type RuntimeActivityCallback,
  type RuntimeActivityDetails,
} from '@/features/runtime-console/types'
import {
  EXPERIMENT_SIMULATION_PATH,
  addExperimentSourceFile,
  addExperimentTask,
  removeExperimentSourceFile,
  removeExperimentTask,
  updateCadSource,
  updateExperimentSourceFile,
  type ExperimentSourceDocument,
} from '@/lib/cad/source'
import { CadCompilationError } from '@/lib/cad/compiler/monacoCompiler'
import type { CadScene } from '@/lib/cad/evaluation/types'
import {
  applyMaterialSnapshot,
  buildMeasurement,
  CadDocumentEvaluationError,
  deserializeCadScene,
  evaluateDocument,
  inspectDocument,
  unresolvedMeasurementMaterialRoles,
  type BuiltMeasurement,
  type EvaluatedExperimentSnapshot,
} from '@/lib/cad/execution'
import {
  generateRandomVars,
  normalizeVars,
  normalizeVarsSchema,
  varsSchemaFingerprint,
  type Vars,
} from '@/lib/cad/model'
import type { SimulationProgramManifest } from '@/lib/cad/simulation'
import type { CadDiagnostic } from '@/lib/cad/worker/protocol'
import { sourceCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import { catalogDraftTaskNames } from '@/lib/catalog/solverTasks'
import type { MeasurementMaterialSnapshot } from '../persistence/contracts'
import { resolveDocumentMaterials } from '../persistence/resolveMaterials'
import {
  cadWorkspaceLifecycleReducer,
  initialCadWorkspaceLifecycleState,
  type AppStatus,
  type RunError,
} from './cadWorkspaceLifecycle'
import { fetchCatalogRuntimeSlice } from './catalogRuntime'

export type { AppStatus, RunError } from './cadWorkspaceLifecycle'
export type EvaluationTimeoutMs = 3000 | 10000 | 30000

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
  materialSnapshot: MeasurementMaterialSnapshot | null
  materialWarnings: readonly string[]
  readOnly: boolean
  measurement: BuiltMeasurement | null
  resultSessionKey: string | number | null
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
  validatedRevision: number
  variables: Readonly<Vars> | null
  varsSchema: EvaluatedExperimentSnapshot['varsSchema'] | null
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
  persistedMaterialSnapshot?: unknown | null
  resetKey?: string | number
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
    persistedMaterialSnapshot = null,
    resetKey = 'default',
    onActivity,
    onCandidateVarsRegenerated,
  }: UseCadWorkspaceOptions = {},
) {
  const [lifecycle, dispatchLifecycle] = useReducer(cadWorkspaceLifecycleReducer, initialCadWorkspaceLifecycleState)
  const { error, status } = lifecycle
  const [diagnostics, setDiagnostics] = useState<readonly CadDiagnostic[]>([])
  const [draftTaskNames, setDraftTaskNames] = useState<readonly string[]>([])
  const [evaluatedSnapshot, setEvaluatedSnapshot] = useState<EvaluatedExperimentSnapshot | null>(null)
  const [evaluationTimeoutMs, setEvaluationTimeoutMs] = useState<EvaluationTimeoutMs>(3000)
  const [generation, setGeneration] = useState(0)
  const [completedCandidateGeneration, setCompletedCandidateGeneration] = useState(0)
  const [materialSnapshot, setMaterialSnapshot] = useState<MeasurementMaterialSnapshot | null>(null)
  const [materialWarnings, setMaterialWarnings] = useState<readonly string[]>([])
  const [builtMeasurement, setBuiltMeasurement] = useState<BuiltMeasurement | null>(null)
  const [revision, setRevision] = useState(0)
  const [scene, setScene] = useState<CadScene | null>(null)
  const [simulationProgram, setSimulationProgram] = useState<SimulationProgramManifest | null>(null)
  const [successfulCandidateGeneration, setSuccessfulCandidateGeneration] = useState(0)
  const [successfulRevision, setSuccessfulRevision] = useState(-1)
  const [validatedRevision, setValidatedRevision] = useState(-1)
  const [taskScenes, setTaskScenes] = useState<Readonly<Record<string, CadScene>>>(Object.freeze({}))
  const [variables, setVariables] = useState<Readonly<Vars> | null>(null)
  const [varsSchema, setVarsSchema] = useState<EvaluatedExperimentSnapshot['varsSchema'] | null>(null)
  const [resultSessionKey, setResultSessionKey] = useState<string | number | null>(null)

  const activeEvaluationRef = useRef<AbortController | null>(null)
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
  }> | null>(null)
  const evaluationTimeoutRef = useRef<EvaluationTimeoutMs>(evaluationTimeoutMs)
  const generationRef = useRef(0)
  const lastSchemaFingerprintRef = useRef<string | null>(null)
  const onActivityRef = useRef(onActivity)
  const onCandidateVarsRegeneratedRef = useRef(onCandidateVarsRegenerated)
  const revisionRef = useRef(0)
  const statusRef = useRef<AppStatus>('Ready')
  const successfulRevisionRef = useRef(-1)
  const validatedCandidateDependencyKeyRef = useRef<string | null>(null)
  const validatedDocumentRef = useRef<ExperimentSourceDocument | null>(null)
  const validatedGenerationRef = useRef(-1)
  const validatedResetKeyRef = useRef<string | number | null>(null)
  const resetKeyRef = useRef<string | number>(resetKey)
  const preparedDocumentRef = useRef<Readonly<{
    catalog: Awaited<ReturnType<typeof fetchCatalogRuntimeSlice>>
    document: ExperimentSourceDocument
    inspection: Awaited<ReturnType<typeof inspectDocument>>
    resetKey: string | number
  }> | null>(null)

  completedCandidateGenerationRef.current = completedCandidateGeneration
  evaluationTimeoutRef.current = evaluationTimeoutMs
  generationRef.current = generation
  onActivityRef.current = onActivity
  onCandidateVarsRegeneratedRef.current = onCandidateVarsRegenerated
  statusRef.current = status
  successfulRevisionRef.current = successfulRevision

  const varsKey = useMemo(() => stableInput(candidateVars ?? null), [candidateVars])
  const materialsKey = useMemo(() => stableInput(persistedMaterialSnapshot), [persistedMaterialSnapshot])
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
    editableMaterialEcho.outputKey === materialsKey
      ? editableMaterialEcho.dependencyKey
      : materialsKey

  useEffect(() => {
    activeEvaluationRef.current?.abort()
    const requestRevision = revisionRef.current + 1
    revisionRef.current = requestRevision
    setRevision(requestRevision)
    setSuccessfulRevision(-1)
    successfulRevisionRef.current = -1
    setDiagnostics([])
    setDraftTaskNames([])
    const resetPreview = resetKeyRef.current !== resetKey
    resetKeyRef.current = resetKey
    const sessionCandidateVars = resetPreview ? undefined : candidateVars
    const sessionMaterialSnapshot = resetPreview ? null : persistedMaterialSnapshot
    if (resetPreview) {
      candidateCacheRef.current = null
      editableMaterialEchoRef.current = null
      lastSchemaFingerprintRef.current = null
      preparedDocumentRef.current = null
      setEvaluatedSnapshot(null)
      setResultSessionKey(null)
    }
    setBuiltMeasurement(null)
    setMaterialSnapshot(null)
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
      setResultSessionKey(null)
      setScene(null)
      setTaskScenes(Object.freeze({}))
      setVarsSchema(null)
      statusRef.current = 'Ready'
      dispatchLifecycle({ type: 'sourceCleared' })
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
      statusRef.current = 'Evaluating'
      dispatchLifecycle({ type: 'evaluationStarted' })
    } else {
      statusRef.current = 'Checking'
      dispatchLifecycle({ type: 'sourceChecking' })
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
            statusRef.current = 'Compiling'
            dispatchLifecycle({ type: 'compilationStarted' })
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
        if (candidateProvenance === 'persisted-measurement' && candidateVarsPending && sessionCandidateVars === undefined) {
          statusRef.current = 'Checking'
          dispatchLifecycle({ type: 'candidatePending' })
          return
        } else if (explicitGeneration) {
          nextVars = generateCandidateVars()
        } else if (candidateProvenance === 'persisted-measurement') {
          candidateCacheRef.current = null
          try {
            if (sessionCandidateVars === undefined) throw new Error('The saved Measurement does not contain Candidate vars.')
            const normalizedSchema = normalizeVarsSchema(inspection.varsSchema, 'Experiment')
            nextVars = normalizeVars(normalizedSchema, sessionCandidateVars, 'Measurement')
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
        } else if (sessionCandidateVars === undefined) {
          nextVars = generateCandidateVars()
        } else {
          try {
            const normalizedSchema = normalizeVarsSchema(inspection.varsSchema, 'Experiment')
            nextVars = normalizeVars(normalizedSchema, sessionCandidateVars, 'Candidate')
            candidateCacheRef.current = null
          } catch {
            nextVars = generateCandidateVars('invalid-candidate')
          }
        }
        statusRef.current = 'Evaluating'
        dispatchLifecycle({ type: 'evaluationStarted' })
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
        validatedCandidateDependencyKeyRef.current = candidateDependencyKey
        validatedDocumentRef.current = evaluationDocument
        validatedGenerationRef.current = generation
        validatedResetKeyRef.current = resetKey
        setValidatedRevision(requestRevision)
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
        statusRef.current = 'Resolving Materials'
        dispatchLifecycle({ type: 'materialsResolutionStarted' })
        emitRuntimeActivity(onActivityRef.current, {
          source: 'cad',
          level: 'info',
          phase: 'materials.resolving',
          message: 'Material snapshot을 확인하고 있습니다.',
          details: { revision: requestRevision },
        })
        const resolution = await resolveDocumentMaterials(
          snapshot,
          candidateProvenance === 'persisted-measurement' && !explicitGeneration ? readMeasurementMaterialSnapshot(sessionMaterialSnapshot) : null,
          catalog,
        )
        if (abort.signal.aborted || revisionRef.current !== requestRevision) return
        const commonScene = applyMaterialSnapshot(
          deserializeCadScene(snapshot.renderScene),
          resolution.materialSnapshot,
        )
        const nextTaskScenes = Object.freeze(
          Object.fromEntries(
            Object.entries(snapshot.taskRenderScenes).map(([name, serialized]) => [
              name,
              applyMaterialSnapshot(deserializeCadScene(serialized), resolution.taskMaterialSnapshots[name]),
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
          })
        }
        if (unresolved.length > 0) {
          const nextDraftTaskNames = catalogDraftTaskNames(registeredCatalog, snapshot.simulationProgram)
          setEvaluatedSnapshot(snapshot)
          setResultSessionKey(resetKey)
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
          statusRef.current = 'Ready'
          dispatchLifecycle({ type: 'evaluationSucceeded' })
          reportReady({ revision: requestRevision, unresolvedMaterialRoles: unresolved.length })
          return
        }
        const nextDraftTaskNames = catalogDraftTaskNames(registeredCatalog, snapshot.simulationProgram)
        if (nextDraftTaskNames.length > 0) {
          setEvaluatedSnapshot(snapshot)
          setResultSessionKey(resetKey)
          setDraftTaskNames(nextDraftTaskNames)
          setVariables(snapshot.variables)
          setVarsSchema(snapshot.varsSchema)
          setScene(commonScene)
          setTaskScenes(nextTaskScenes)
          setSimulationProgram(null)
          setMaterialSnapshot(null)
          setMaterialWarnings(resolutionWarnings)
          rememberEditableMaterialOutput(materialsKey)
          completeCandidateGeneration()
          successfulRevisionRef.current = requestRevision
          setSuccessfulRevision(requestRevision)
          statusRef.current = 'Ready'
          dispatchLifecycle({ type: 'evaluationSucceeded' })
          reportReady({ revision: requestRevision, draftTaskCount: nextDraftTaskNames.length })
          return
        }
        const built = buildMeasurement(snapshot, resolution)
        const persistedMaterials = measurementMaterialSnapshot(built)
        setBuiltMeasurement(built)
        setEvaluatedSnapshot(snapshot)
        setResultSessionKey(resetKey)
        setVariables(snapshot.variables)
        setVarsSchema(snapshot.varsSchema)
        setScene(commonScene)
        setTaskScenes(nextTaskScenes)
        setSimulationProgram(snapshot.simulationProgram)
        setMaterialSnapshot(persistedMaterials)
        setMaterialWarnings(resolutionWarnings)
        rememberEditableMaterialOutput(stableInput(persistedMaterials))
        completeCandidateGeneration()
        successfulRevisionRef.current = requestRevision
        setSuccessfulRevision(requestRevision)
        statusRef.current = 'Ready'
        dispatchLifecycle({ type: 'evaluationSucceeded' })
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
        const nextError: RunError = {
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
        }
        statusRef.current = 'Error'
        dispatchLifecycle({ type: 'evaluationFailed', error: nextError })
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
  }, [
    experiment,
    candidateProvenance,
    candidateVarsPending,
    generation,
    materialDependencyKey,
    resetKey,
    candidateDependencyKey,
  ])

  useEffect(
    () => () => {
      activeEvaluationRef.current?.abort()
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
    statusRef.current = 'Rendering'
    dispatchLifecycle({ type: 'renderStarted' })
    emitRuntimeActivity(onActivityRef.current, {
      source: 'cad',
      level: 'info',
      phase: 'render.started',
      message: '3D CAD View 렌더링을 시작했습니다.',
    })
  }, [])
  const handleRenderEnd = useCallback(() => {
    if (statusRef.current !== 'Rendering') return
    statusRef.current = 'Ready'
    dispatchLifecycle({ type: 'renderSucceeded' })
    emitRuntimeActivity(onActivityRef.current, {
      source: 'cad',
      level: 'info',
      phase: 'render.completed',
      message: '3D CAD View 렌더링을 완료했습니다.',
    })
  }, [])
  const handleRenderError = useCallback((message: string) => {
    if (statusRef.current === 'Error') return
    statusRef.current = 'Error'
    dispatchLifecycle({ type: 'renderFailed', error: { title: 'Rendering Error', message } })
    emitRuntimeActivity(onActivityRef.current, {
      source: 'cad',
      level: 'error',
      phase: 'render.failed',
      message,
    })
  }, [])

  const ownsCurrentSession = resultSessionKey === resetKey
  const currentValidatedRevision =
    validatedDocumentRef.current === experiment &&
    validatedCandidateDependencyKeyRef.current === candidateDependencyKey &&
    validatedGenerationRef.current === generation &&
    validatedResetKeyRef.current === resetKey
      ? validatedRevision
      : -1
  const taskSceneHashes = useMemo(
    () =>
      Object.freeze(
        Object.fromEntries(
          Object.entries(ownsCurrentSession ? (evaluatedSnapshot?.taskRenderScenes ?? {}) : {}).map(([name, value]) => [
            name,
            value.sceneHash,
          ]),
        ),
      ),
    [evaluatedSnapshot, ownsCurrentSession],
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
    evaluatedSnapshot: ownsCurrentSession ? evaluatedSnapshot : null,
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
    materialSnapshot: ownsCurrentSession ? materialSnapshot : null,
    materialWarnings,
    readOnly: sourceReadOnly,
    measurement: ownsCurrentSession ? builtMeasurement : null,
    resultSessionKey: ownsCurrentSession ? resultSessionKey : null,
    revision,
    runIsBusy,
    scene: ownsCurrentSession ? scene : null,
    sceneHash: ownsCurrentSession ? (evaluatedSnapshot?.renderScene.sceneHash ?? null) : null,
    setEvaluationTimeoutMs,
    simulationProgram: ownsCurrentSession ? simulationProgram : null,
    sourceReadOnly,
    status,
    successfulCandidateGeneration,
    successfulRevision,
    taskSceneHashes,
    taskScenes: ownsCurrentSession ? taskScenes : Object.freeze({}),
    validatedRevision: currentValidatedRevision,
    variables: ownsCurrentSession ? variables : null,
    varsSchema,
  }
  return { experimentDocument }
}
