import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, getListRequest, type UserData } from '@/api'
import { authQueryKey } from '@/features/auth/use-auth'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { useCurrentCadSelection } from '@/features/viewer/current-cad-selection'
import type { DefinitionFormValues, ExperimentSaveMode } from '@/features/viewer/persistence/SaveDefinitionDialog'
import { saveCadDefinition } from '@/features/viewer/persistence/saveDefinition'
import { useCadWorkspace, type CandidateVarsRegeneratedEvent } from '@/features/viewer/workspace/useCadWorkspace'
import {
  cadSourceHash,
  createCadSourceDocument,
  createExperimentSourceBundle,
  experimentTaskPaths,
  type Tensor,
  type ExperimentSourceBundle,
  type ExperimentSourceDocument,
  type Vars,
} from '@/lib/cad'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import { useCaeDataSelection } from '../measurement/useCaeDataSelection'
import { useCaeMeasurementActions } from '../measurement/useCaeMeasurementActions'
import type {
  DefinitionStatus,
  SavedExperiment,
  SavedMeasurement,
  WorkbenchDraft,
  WorkbenchLayoutState,
} from '../types'
import { validateVarsTensor } from '../calculation/varsTensor'
import { useCalculationDataActions } from '../calculation/useCalculationDataActions'

function definitionStatus(
  document: ExperimentSourceDocument | null,
  record: SavedExperiment | null,
  dirty: boolean,
): DefinitionStatus {
  if (!document) return 'empty'
  if (!record) return 'new'
  return dirty ? 'saved-dirty' : 'saved-clean'
}

function sourceBundlesEqual(left: ExperimentSourceBundle, right: ExperimentSourceBundle | null) {
  if (!right) return false
  const paths = [...new Set([...Object.keys(left.files), ...Object.keys(right.files)])]
  return paths.every((path) => left.files[path] === right.files[path])
}

function createExperimentDocument(sourceBundle: ExperimentSourceBundle) {
  return createCadSourceDocument('experiment', sourceBundle)
}

export type AgentExperimentChange = Readonly<{
  runId: string
  appliedAt: number
  status: 'applied' | 'conflicted'
  files: readonly Readonly<{
    path: string
    before: string | null
    after: string | null
    addedLines: number
    removedLines: number
  }>[]
}>

type AgentApplyRequest = Readonly<{
  runId: string
  finalDocument: Readonly<{ kind: 'experiment'; sourceBundle: ExperimentSourceBundle }>
  baseHash: string
  sourceHash: string
  stagedRevision: number
  workspaceSession: number
}>

function changedLineCounts(before: string | null, after: string | null) {
  const beforeLines = before === null ? [] : before.split('\n')
  const afterLines = after === null ? [] : after.split('\n')
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix += 1
  }
  return { addedLines: afterLines.length - prefix - suffix, removedLines: beforeLines.length - prefix - suffix }
}

async function fetchExperiment(id: number) {
  const row = (await dbTables.Experiment.listRows(getListRequest('visible', [id]))).items[0]
  if (!row) throw new Error(`Experiment #${id}을 찾을 수 없습니다.`)
  return row as SavedExperiment
}

export type UseCaeWorkbenchStateOptions = Readonly<{ onActivity?: RuntimeActivityCallback }>

export function useCaeWorkbenchState(
  user: UserData | null,
  authenticated: boolean,
  { onActivity }: UseCaeWorkbenchStateOptions = {},
) {
  const queryClient = useQueryClient()
  const { setCurrentExperimentId } = useCurrentCadSelection()
  const [experiment, setExperiment] = useState<ExperimentSourceDocument | null>(null)
  const [experimentRecord, setExperimentRecord] = useState<SavedExperiment | null>(null)
  const [baselineExperimentBundle, setBaselineExperimentBundle] = useState<ExperimentSourceBundle | null>(null)
  const [experimentName, setExperimentName] = useState('Untitled Experiment')
  const [experimentDescription, setExperimentDescription] = useState('')
  const [candidateVars, setCandidateVars] = useState<Readonly<Vars> | null>(null)
  const [candidateMaterialParameters, setCandidateMaterialParameters] = useState<
    SavedMeasurement['material_parameters'] | null
  >(null)
  const [saving, setSaving] = useState<'experiment' | null>(null)
  const [pendingMeasurementId, setPendingMeasurementId] = useState<number | null>(null)
  const [selectionRestoreStatus, setSelectionRestoreStatus] = useState<'idle' | 'restoring' | 'failed'>('idle')
  const [workspaceSession, setWorkspaceSession] = useState(0)
  const [agentChange, setAgentChange] = useState<AgentExperimentChange | null>(null)
  const [agentWorkspaceIdentity, setAgentWorkspaceIdentity] = useState<Readonly<{
    baseHash: string
    document: ExperimentSourceDocument
  }> | null>(null)
  const requestSequence = useRef(0)
  const experimentRef = useRef(experiment)
  const authenticatedRef = useRef(authenticated)
  experimentRef.current = experiment

  const experimentId = experimentRecord?.id ?? null
  const baseSelection = useCaeDataSelection(experimentId, user?.roles.includes('admin') ? 'visible' : 'mine')
  const { clearMeasurement: clearBaseMeasurement, loadMeasurement: loadBaseMeasurement } = baseSelection
  const experimentDirty = Boolean(experiment && !sourceBundlesEqual(experiment.sourceBundle, baselineExperimentBundle))
  const hasUnsavedExperimentWork = experimentDirty
  const experimentClean = Boolean(experimentId && !experimentDirty)
  const hasTasks = Boolean(experiment && experimentTaskPaths(experiment.sourceBundle).length)

  const clearMeasurement = useCallback(() => {
    setPendingMeasurementId(null)
    setSelectionRestoreStatus('idle')
    clearBaseMeasurement()
  }, [clearBaseMeasurement])

  const loadMeasurement = useCallback(
    async (value: number | SavedMeasurement, expectedExperimentId: number | null = experimentId) => {
      const row = await loadBaseMeasurement(value, expectedExperimentId)
      if (!row) return null
      setCandidateVars(row.vars as Readonly<Vars>)
      setCandidateMaterialParameters(row.material_parameters)
      setPendingMeasurementId(null)
      setSelectionRestoreStatus('idle')
      return row
    },
    [experimentId, loadBaseMeasurement],
  )

  const selection = useMemo(
    () => ({ ...baseSelection, clearAll: clearMeasurement, clearMeasurement, loadMeasurement }),
    [baseSelection, clearMeasurement, loadMeasurement],
  )

  useEffect(() => {
    const wasAuthenticated = authenticatedRef.current
    authenticatedRef.current = authenticated
    if (authenticated && !wasAuthenticated && !selection.measurement) setCandidateMaterialParameters(null)
  }, [authenticated, selection.measurement])

  const handleExperimentChange = useCallback(
    (document: ExperimentSourceDocument) => {
      experimentRef.current = document
      setAgentWorkspaceIdentity(null)
      setExperiment(document)
      clearMeasurement()
      setCandidateMaterialParameters(null)
    },
    [clearMeasurement],
  )

  const handleCandidateVarsRegenerated = useCallback((event: CandidateVarsRegeneratedEvent) => {
    setCandidateVars(event.vars)
    toast.info(
      event.reason === 'schema-changed'
        ? 'varsSchema가 변경되어 모든 Candidate 변수를 새로 생성했습니다.'
        : '현재 Candidate가 varsSchema와 맞지 않아 모든 변수를 새로 생성했습니다.',
    )
  }, [])

  const { experimentDocument, simulation } = useCadWorkspace(experiment, handleExperimentChange, {
    candidateVars: candidateVars ?? undefined,
    candidateVarsPending: pendingMeasurementId !== null,
    candidateProvenance: selection.measurement || pendingMeasurementId ? 'persisted-measurement' : 'editable',
    frozenMaterialSnapshot: candidateMaterialParameters,
    runtimeEnabled: authenticated,
    resetKey: workspaceSession,
    sourceOnlyMaterials: !authenticated,
    onActivity,
    onCandidateVarsRegenerated: handleCandidateVarsRegenerated,
  })
  const experimentSourceValidated = experimentDocument.validatedRevision === experimentDocument.revision

  useEffect(() => {
    if (!experiment) {
      setAgentWorkspaceIdentity(null)
      return
    }
    let active = true
    void cadSourceHash(experiment).then(
      (baseHash) => {
        if (active) {
          setAgentWorkspaceIdentity(Object.freeze({ baseHash, document: experiment }))
        }
      },
      () => {
        if (active) setAgentWorkspaceIdentity(null)
      },
    )
    return () => {
      active = false
    }
  }, [experiment])
  const currentAgentWorkspaceIdentity =
    agentWorkspaceIdentity?.document === experiment
      ? Object.freeze({
          baseHash: agentWorkspaceIdentity.baseHash,
        })
      : null

  const applyAgentBundle = useCallback(
    async (request: AgentApplyRequest) => {
      const current = experimentRef.current
      if (!current) return { status: 'conflicted' as const, message: 'Experiment가 없습니다.' }
      let next: ExperimentSourceDocument
      let finalHash: string
      try {
        next = createExperimentDocument(request.finalDocument.sourceBundle)
        finalHash = await cadSourceHash(next)
      } catch (cause: unknown) {
        return { status: 'conflicted' as const, message: cause instanceof Error ? cause.message : String(cause) }
      }
      if (finalHash !== request.sourceHash) {
        return {
          status: 'conflicted' as const,
          message: 'Agent 완료 bundle의 source hash가 일치하지 않아 자동 반영하지 않았습니다.',
        }
      }
      const currentHash = await cadSourceHash(current)
      const conflicted =
        experimentRef.current !== current ||
        currentHash !== request.baseHash ||
        workspaceSession !== request.workspaceSession
      const comparison = conflicted ? (experimentRef.current ?? current) : current
      const paths = [
        ...new Set([...Object.keys(comparison.sourceBundle.files), ...Object.keys(next.sourceBundle.files)]),
      ].sort()
      const files = paths.flatMap((path) => {
        const before = comparison.sourceBundle.files[path] ?? null
        const after = next.sourceBundle.files[path] ?? null
        return before === after ? [] : [{ path, before, after, ...changedLineCounts(before, after) }]
      })
      const firstChangedFile = files[0]?.path ?? null
      if (conflicted) {
        setAgentChange(
          files.length
            ? Object.freeze({ runId: request.runId, appliedAt: Date.now(), status: 'conflicted' as const, files })
            : null,
        )
        return {
          status: 'conflicted' as const,
          message: 'Agent 실행 중 Experiment source가 변경되어 staged diff만 표시했습니다.',
          firstChangedFile,
          changedFiles: files.length,
        }
      }
      if (!files.length) return { status: 'applied' as const, firstChangedFile: null, changedFiles: 0 }
      experimentRef.current = next
      setAgentWorkspaceIdentity(null)
      setExperiment(next)
      clearMeasurement()
      setCandidateMaterialParameters(null)
      setAgentChange(Object.freeze({ runId: request.runId, appliedAt: Date.now(), status: 'applied' as const, files }))
      return { status: 'applied' as const, firstChangedFile, changedFiles: files.length }
    },
    [clearMeasurement, workspaceSession],
  )

  const undoAgentChange = useCallback(async () => {
    const current = experimentRef.current
    if (!current || !agentChange) return false
    if (agentChange.status === 'conflicted') {
      setAgentChange(null)
      toast.success('AI Agent staged diff를 닫았습니다.')
      return true
    }
    const files = { ...current.sourceBundle.files }
    for (const change of agentChange.files) {
      if ((files[change.path] ?? null) !== change.after) {
        toast.error(`${change.path}가 Agent 반영 후 다시 수정되어 전체 Undo를 적용하지 않았습니다.`)
        return false
      }
      if (change.before === null) delete files[change.path]
      else files[change.path] = change.before
    }
    const restored = createExperimentDocument(createExperimentSourceBundle(files))
    experimentRef.current = restored
    setAgentWorkspaceIdentity(null)
    setExperiment(restored)
    clearMeasurement()
    setCandidateMaterialParameters(null)
    setAgentChange(null)
    toast.success('AI Agent 변경을 되돌렸습니다.')
    return true
  }, [agentChange, clearMeasurement])

  const generateCandidate = useCallback(() => {
    clearMeasurement()
    setCandidateVars(null)
    setCandidateMaterialParameters(null)
    return experimentDocument.generateCandidate()
  }, [clearMeasurement, experimentDocument])

  const calculationDataActions = useCalculationDataActions({ authenticated, experimentId, onActivity })
  const measurementActions = useCaeMeasurementActions({
    authenticated,
    calculationDataActions,
    experimentClean,
    experimentDocument,
    experimentId,
    experimentSourceHash: experimentRecord?.source_hash ?? null,
    onGenerateCandidate: generateCandidate,
    selection,
    simulation,
  })

  const setCandidateVariable = useCallback(
    (key: string, value: Tensor) => {
      const entry = experimentDocument.varsSchema?.[key]
      const fallback = experimentDocument.variables
      if (!entry || (!candidateVars && !fallback)) {
        toast.error('편집할 Candidate 변수 또는 varsSchema가 준비되지 않았습니다.')
        return
      }
      try {
        const normalized = validateVarsTensor(value, entry, `Candidate vars.${key}`)
        if (selection.measurement) clearMeasurement()
        setCandidateVars((current) => Object.freeze({ ...(current ?? fallback ?? {}), [key]: normalized }))
      } catch (cause: unknown) {
        toast.error(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [
      candidateVars,
      clearMeasurement,
      experimentDocument.variables,
      experimentDocument.varsSchema,
      selection.measurement,
    ],
  )

  useEffect(() => setCurrentExperimentId(experimentId), [experimentId, setCurrentExperimentId])

  useEffect(() => {
    if (
      selection.measurement ||
      experimentDocument.resultSessionKey !== workspaceSession ||
      experimentDocument.status !== 'Ready' ||
      experimentDocument.successfulRevision !== experimentDocument.revision ||
      !experimentDocument.variables
    ) {
      return
    }
    setCandidateVars(experimentDocument.variables)
    if (experimentDocument.materialParameters) setCandidateMaterialParameters(experimentDocument.materialParameters)
  }, [
    experimentDocument.materialParameters,
    experimentDocument.resultSessionKey,
    experimentDocument.revision,
    experimentDocument.status,
    experimentDocument.successfulRevision,
    experimentDocument.variables,
    selection.measurement,
    workspaceSession,
  ])

  useEffect(() => {
    if (!authenticated || !pendingMeasurementId || !experimentId) return
    const measurementId = pendingMeasurementId
    setSelectionRestoreStatus('restoring')
    void loadMeasurement(measurementId, experimentId).catch((cause: unknown) => {
      if (measurementId !== pendingMeasurementId) return
      setPendingMeasurementId(null)
      setSelectionRestoreStatus('failed')
      toast.error(cause instanceof Error ? cause.message : '저장된 Measurement 선택을 복원하지 못했습니다.')
    })
  }, [authenticated, experimentId, loadMeasurement, pendingMeasurementId])

  const applyExperimentState = useCallback(
    (row: SavedExperiment) => {
      const document = createExperimentDocument(row.source_bundle)
      setWorkspaceSession((current) => current + 1)
      setAgentWorkspaceIdentity(null)
      setAgentChange(null)
      clearMeasurement()
      experimentRef.current = document
      setExperiment(document)
      setExperimentRecord(row)
      setBaselineExperimentBundle(row.source_bundle)
      setExperimentName(row.name)
      setExperimentDescription(row.description ?? '')
      setCandidateVars(null)
      setCandidateMaterialParameters(null)
    },
    [clearMeasurement],
  )

  const applyExperiment = useCallback(
    (row: SavedExperiment) => {
      requestSequence.current += 1
      applyExperimentState(row)
    },
    [applyExperimentState],
  )

  const loadExperiment = useCallback(
    async (value: number | SavedExperiment, measurementId?: number | null) => {
      const sequence = ++requestSequence.current
      const row = typeof value === 'number' ? await fetchExperiment(value) : value
      if (sequence !== requestSequence.current) return row
      applyExperimentState(row)
      if (measurementId) setPendingMeasurementId(measurementId)
      return row
    },
    [applyExperimentState],
  )

  const restoreSelection = useCallback(
    (measurementId: number | null) => {
      setPendingMeasurementId(measurementId)
      setSelectionRestoreStatus(measurementId ? 'restoring' : 'idle')
      if (!measurementId) clearMeasurement()
    },
    [clearMeasurement],
  )

  const newExperiment = useCallback(
    (
      sourceBundle: ExperimentSourceBundle = starterExperimentSourceBundle,
      name = 'Starter Experiment',
      description = '',
    ) => {
      const document = createExperimentDocument(sourceBundle)
      requestSequence.current += 1
      setWorkspaceSession((current) => current + 1)
      setAgentWorkspaceIdentity(null)
      setAgentChange(null)
      clearMeasurement()
      experimentRef.current = document
      setExperiment(document)
      setExperimentRecord(null)
      setBaselineExperimentBundle(sourceBundle)
      setExperimentName(name)
      setExperimentDescription(description)
      setCandidateVars(null)
      setCandidateMaterialParameters(null)
    },
    [clearMeasurement],
  )

  const detachDeletedExperiment = useCallback(() => {
    const current = experimentRef.current
    if (!current) return
    const document = createExperimentDocument(current.sourceBundle)
    requestSequence.current += 1
    setWorkspaceSession((value) => value + 1)
    setAgentWorkspaceIdentity(null)
    setAgentChange(null)
    clearMeasurement()
    experimentRef.current = document
    setExperiment(document)
    setExperimentRecord(null)
    setBaselineExperimentBundle(null)
    setCandidateVars(null)
    setCandidateMaterialParameters(null)
  }, [clearMeasurement])

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['experiments'] }),
      queryClient.invalidateQueries({ queryKey: ['work', 'experiments'] }),
      queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'experiment'] }),
      queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'experiments'] }),
      queryClient.invalidateQueries({ queryKey: authQueryKey }),
    ])
  }, [queryClient])

  const saveExperiment = useCallback(
    async (values: DefinitionFormValues, mode: ExperimentSaveMode) => {
      if (!authenticated || !user) throw new Error('로그인이 필요합니다.')
      if (!experiment) throw new Error('저장할 Experiment source가 없습니다.')
      if (!experimentSourceValidated) {
        throw new Error('현재 Experiment source 의미 검사가 완료되지 않아 저장할 수 없습니다.')
      }
      if (mode !== 'create' && !experimentRecord) throw new Error('먼저 Save As로 Experiment를 저장하세요.')
      const manageable = experimentRecord && (experimentRecord.user_id === user.id || user.roles.includes('admin'))
      if (mode !== 'create' && !manageable) throw new Error('이 Experiment는 Save As로 저장하세요.')
      if (mode === 'overwrite' && experimentRecord?.sourceLocked && experimentDirty) {
        throw new Error('연결 데이터가 있는 Version은 잠겨 있습니다. Save New Version을 사용하세요.')
      }
      setSaving('experiment')
      const sourceSequence = requestSequence.current
      const savedDocument = experiment
      try {
        const result = await saveCadDefinition({
          document: savedDocument,
          mode,
          savedSourceBundle: experimentId ? baselineExperimentBundle : null,
          selectedId: experimentId,
          values,
        })
        const fetched = await fetchExperiment(result.id).catch(() => null)
        const [major, minor, patch] = result.version.split('.').map(Number)
        const row: SavedExperiment = fetched ?? {
          id: result.id,
          user_id: user.id,
          namespace: result.namespace,
          repository_slug: result.repository,
          experiment_key: result.key,
          version_major: major,
          version_minor: minor,
          version_patch: patch,
          name: values.name,
          description: values.description || null,
          source_bundle: result.sourceBundle,
          source_hash: result.bundleHash,
          repository: result.repository,
          key: result.key,
          version: result.version,
          coordinate: result.coordinate,
          bundleHash: result.bundleHash,
          sourceLocked: result.sourceLocked,
          derivedCounts: result.derivedCounts,
        }
        await invalidate()
        if (sourceSequence !== requestSequence.current) return result
        setExperimentRecord(row)
        setBaselineExperimentBundle(savedDocument.sourceBundle)
        setExperimentName(row.name)
        setExperimentDescription(row.description ?? '')
        return result
      } finally {
        setSaving(null)
      }
    },
    [
      authenticated,
      baselineExperimentBundle,
      experiment,
      experimentDirty,
      experimentId,
      experimentRecord,
      experimentSourceValidated,
      invalidate,
      user,
    ],
  )

  const restoreDraft = useCallback(
    (draft: WorkbenchDraft) => {
      requestSequence.current += 1
      setWorkspaceSession((current) => current + 1)
      setAgentWorkspaceIdentity(null)
      setAgentChange(null)
      const document = draft.experiment.document
        ? createExperimentDocument(draft.experiment.document.sourceBundle)
        : null
      experimentRef.current = document
      setExperiment(document)
      setExperimentRecord(draft.experiment.record)
      setBaselineExperimentBundle(draft.experiment.baselineBundle)
      setExperimentName(draft.experiment.name)
      setExperimentDescription(draft.experiment.description)
      setCandidateVars(draft.candidate.vars)
      setCandidateMaterialParameters(authenticated ? draft.candidate.materialParameters : null)
      setPendingMeasurementId(draft.selection.measurementId)
      setSelectionRestoreStatus(draft.selection.measurementId ? 'restoring' : 'idle')
    },
    [authenticated],
  )

  const selectionIds = useMemo(
    () => ({ measurementId: pendingMeasurementId ?? selection.measurement?.id ?? null }),
    [pendingMeasurementId, selection.measurement?.id],
  )

  const draft = useCallback(
    (layout: WorkbenchLayoutState): WorkbenchDraft => ({
      savedAt: Date.now(),
      experiment: {
        record: experimentRecord,
        baselineBundle: baselineExperimentBundle,
        document: experiment,
        name: experimentName,
        description: experimentDescription,
      },
      candidate: { vars: candidateVars, materialParameters: candidateMaterialParameters },
      selection: selectionIds,
      layout,
    }),
    [
      baselineExperimentBundle,
      candidateMaterialParameters,
      candidateVars,
      experiment,
      experimentDescription,
      experimentName,
      experimentRecord,
      selectionIds,
    ],
  )

  const experimentManageable = Boolean(
    experimentRecord && user && (experimentRecord.user_id === user.id || user.roles.includes('admin')),
  )
  const experimentVersion = experimentRecord
    ? (experimentRecord.version ??
      `${experimentRecord.version_major}.${experimentRecord.version_minor}.${experimentRecord.version_patch}`)
    : null
  const experimentCoordinate = experimentRecord
    ? (experimentRecord.coordinate ??
      `caemble:experiment/${experimentRecord.namespace}/${experimentRecord.repository_slug}/${experimentRecord.experiment_key}@${experimentVersion}`)
    : null
  const sourceLocked = Boolean(experimentRecord?.sourceLocked)
  const refreshExperimentUsage = useCallback(async () => {
    if (experimentId === null) return
    const usage = (await dbTables.Experiment.usage([experimentId])).items[0]
    if (!usage) return
    setExperimentRecord((current) =>
      current?.id === experimentId
        ? { ...current, derivedCounts: usage.derivedCounts, sourceLocked: usage.sourceLocked }
        : current,
    )
  }, [experimentId])

  return {
    experiment,
    experimentRecord,
    experimentId,
    experimentName,
    experimentDescription,
    experimentDirty,
    experimentSourceValidated,
    hasUnsavedExperimentWork,
    hasUnsavedWork: experimentDirty,
    experimentClean,
    experimentStatus: definitionStatus(experiment, experimentRecord, experimentDirty),
    experimentManageable,
    experimentCoordinate,
    experimentVersion,
    experimentNamespaces: user?.experiment_namespaces ?? [],
    sourceLocked,
    refreshExperimentUsage,
    hasTasks,
    agentChange,
    agentWorkspaceIdentity: currentAgentWorkspaceIdentity,
    agentWorkspaceSession: workspaceSession,
    candidateVars,
    candidateMaterialParameters,
    setCandidateVariable,
    saving,
    selection,
    selectionIds,
    selectionRestoring: selectionRestoreStatus === 'restoring',
    measurementActions,
    calculationDataActions,
    experimentDocument,
    simulation,
    applyExperiment,
    loadExperiment,
    restoreSelection,
    newExperiment,
    detachDeletedExperiment,
    saveExperiment,
    restoreDraft,
    draft,
    applyAgentBundle,
    undoAgentChange,
  }
}

export type CaeWorkbenchState = ReturnType<typeof useCaeWorkbenchState>
