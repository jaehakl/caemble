import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, getListRequest, type UserData } from '@/api'
import { useCurrentCadSelection } from '@/features/viewer/current-cad-selection'
import type { DefinitionFormValues } from '@/features/viewer/persistence/SaveDefinitionDialog'
import { saveCadDefinition } from '@/features/viewer/persistence/saveDefinition'
import { useCadWorkspace, type CandidateVarsRegeneratedEvent } from '@/features/viewer/workspace/useCadWorkspace'
import {
  cadSourceHash,
  canonicalizeGeometrySnapshot,
  createCadSourceDocument,
  createExperimentSourceBundle,
  type ExperimentSourceBundle,
  type ExperimentSourceDocument,
  type GeometryDraftOverlay,
  type GeometrySnapshot,
  type Vars,
} from '@/lib/cad'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import { agentGeometryContextVersion } from '../agent/agentWorkspace'
import { useGeometryManagerState } from '../geometry'
import { useCaeDataSelection } from '../measurement/useCaeDataSelection'
import { useCaeMeasurementActions } from '../measurement/useCaeMeasurementActions'
import type { DefinitionStatus, SavedExperiment, SavedMeasurement, WorkbenchDraft, WorkbenchTabId } from '../types'

function definitionStatus(
  document: ExperimentSourceDocument | null,
  record: SavedExperiment | null,
  dirty: boolean,
): DefinitionStatus {
  if (!document) return 'empty'
  if (!record) return 'new'
  return dirty ? 'saved-dirty' : 'saved-clean'
}

function sourceFilesEqual(left: SavedExperiment['source_bundle'], right: SavedExperiment['source_bundle'] | null) {
  if (!right) return false
  const paths = [...new Set([...Object.keys(left.files), ...Object.keys(right.files)])]
  return paths.every((path) => left.files[path] === right.files[path])
}

function geometrySnapshotsEqual(
  left: SavedExperiment['source_bundle'],
  right: SavedExperiment['source_bundle'] | null,
) {
  if (!right || left.formatVersion !== right.formatVersion) return false
  const normalize = (snapshot: GeometrySnapshot) => JSON.stringify(canonicalizeGeometrySnapshot(snapshot))
  return normalize(left.geometrySnapshot) === normalize(right.geometrySnapshot)
}

function createExperimentDocument(sourceBundle: SavedExperiment['source_bundle']) {
  const document = createCadSourceDocument('experiment', sourceBundle)
  if (document.kind !== 'experiment') throw new Error('Experiment source를 만들지 못했습니다.')
  return document
}

export type AgentExperimentChange = Readonly<{
  runId: string
  appliedAt: number
  status: 'applied' | 'conflicted'
  geometrySnapshot?: Readonly<{
    before: GeometrySnapshot
    after: GeometrySnapshot
  }>
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
  finalBundle: ExperimentSourceBundle
  baseHash: string
  sourceHash: string
  stagedRevision: number
  geometryContextVersion: string
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
  if (!row?.id) throw new Error(`Experiment #${id}을 찾을 수 없습니다.`)
  return row as SavedExperiment
}

export function useCaeWorkbenchState(user: UserData | null, authenticated: boolean) {
  const queryClient = useQueryClient()
  const { setCurrentExperimentId } = useCurrentCadSelection()
  const [experiment, setExperiment] = useState<ExperimentSourceDocument | null>(null)
  const [experimentRecord, setExperimentRecord] = useState<SavedExperiment | null>(null)
  const [baselineExperimentBundle, setBaselineExperimentBundle] = useState<SavedExperiment['source_bundle'] | null>(
    null,
  )
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
    geometryContextVersion: string
    document: ExperimentSourceDocument
    geometryDrafts: GeometryDraftOverlay | undefined
  }> | null>(null)
  const requestSequence = useRef(0)
  const experimentRef = useRef(experiment)
  const authenticatedRef = useRef(authenticated)
  experimentRef.current = experiment

  const experimentId = experimentRecord?.id ?? null
  const baseSelection = useCaeDataSelection(experimentId, user?.roles.includes('admin') ? 'visible' : 'mine')
  const { clearMeasurement: clearBaseMeasurement, loadMeasurement: loadBaseMeasurement } = baseSelection

  const clearMeasurement = useCallback(() => {
    setPendingMeasurementId(null)
    setSelectionRestoreStatus('idle')
    clearBaseMeasurement()
  }, [clearBaseMeasurement])

  const geometry = useGeometryManagerState({
    authenticated,
    initialNamespace: user?.geometry_namespace ?? (authenticated ? null : 'local'),
    snapshot: experiment?.sourceBundle.geometrySnapshot ?? null,
    sourceFiles: experiment?.sourceBundle.files ?? {},
  })
  const currentAgentGeometryDrafts = Object.keys(geometry.experimentDraftOverlay).length
    ? geometry.experimentDraftOverlay
    : undefined
  const agentGeometryDraftsRef = useRef<GeometryDraftOverlay | undefined>(currentAgentGeometryDrafts)
  agentGeometryDraftsRef.current = currentAgentGeometryDrafts
  const restoreGeometry = geometry.restore
  const syncGeometrySnapshot = geometry.syncSnapshot
  const createGeometryDraftState = geometry.draftState
  const experimentSourceDirty = Boolean(
    experiment && !sourceFilesEqual(experiment.sourceBundle, baselineExperimentBundle),
  )
  const geometryGraphDirty = Boolean(
    experiment && !geometrySnapshotsEqual(experiment.sourceBundle, baselineExperimentBundle),
  )
  const geometryLocalDraftDirty = Object.keys(geometry.draftVersions).length > 0
  const experimentDirty = experimentSourceDirty || geometryGraphDirty
  const hasUnsavedExperimentWork = experimentDirty
  const hasUnsavedWork = experimentDirty || geometryLocalDraftDirty
  const experimentClean = Boolean(experimentId && !experimentDirty && !geometry.hasReachableDrafts)

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
    runtimeEnabled: authenticated && !geometry.hasReachableDrafts,
    geometryDrafts: currentAgentGeometryDrafts,
    resetKey: workspaceSession,
    sourceOnlyMaterials: !authenticated,
    onCandidateVarsRegenerated: handleCandidateVarsRegenerated,
  })

  useEffect(() => {
    if (!experiment) {
      setAgentWorkspaceIdentity(null)
      return
    }
    let active = true
    const drafts = currentAgentGeometryDrafts
    void Promise.all([cadSourceHash(experiment), agentGeometryContextVersion(experiment, drafts)]).then(
      ([baseHash, geometryContextVersion]) => {
        if (active) {
          setAgentWorkspaceIdentity(
            Object.freeze({ baseHash, geometryContextVersion, document: experiment, geometryDrafts: drafts }),
          )
        }
      },
      () => {
        if (active) setAgentWorkspaceIdentity(null)
      },
    )
    return () => {
      active = false
    }
  }, [currentAgentGeometryDrafts, experiment])
  const currentAgentWorkspaceIdentity =
    agentWorkspaceIdentity?.document === experiment &&
    agentWorkspaceIdentity.geometryDrafts === currentAgentGeometryDrafts
      ? Object.freeze({
          baseHash: agentWorkspaceIdentity.baseHash,
          geometryContextVersion: agentWorkspaceIdentity.geometryContextVersion,
        })
      : null

  const applyAgentBundle = useCallback(
    async (request: AgentApplyRequest) => {
      const current = experimentRef.current
      if (!current) return { status: 'conflicted' as const, message: 'Experiment가 없습니다.' }
      let next: ExperimentSourceDocument
      let finalHash: string
      try {
        next = createExperimentDocument(
          createExperimentSourceBundle(request.finalBundle.files, request.finalBundle.geometrySnapshot),
        )
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
      const drafts = agentGeometryDraftsRef.current
      const [currentHash, contextVersion] = await Promise.all([
        cadSourceHash(current),
        agentGeometryContextVersion(current, drafts),
      ])
      const conflicted =
        experimentRef.current !== current ||
        agentGeometryDraftsRef.current !== drafts ||
        currentHash !== request.baseHash ||
        contextVersion !== request.geometryContextVersion
      const comparison = conflicted ? (experimentRef.current ?? current) : current
      const paths = [
        ...new Set([...Object.keys(comparison.sourceBundle.files), ...Object.keys(next.sourceBundle.files)]),
      ].sort()
      const files = paths.flatMap((path) => {
        const before = comparison.sourceBundle.files[path] ?? null
        const after = next.sourceBundle.files[path] ?? null
        return before === after ? [] : [{ path, before, after, ...changedLineCounts(before, after) }]
      })
      const snapshotChanged =
        JSON.stringify(canonicalizeGeometrySnapshot(comparison.sourceBundle.geometrySnapshot)) !==
        JSON.stringify(canonicalizeGeometrySnapshot(next.sourceBundle.geometrySnapshot))
      const firstChangedFile = files[0]?.path ?? (snapshotChanged ? 'geometry.tsx' : null)
      if (conflicted) {
        if (files.length > 0 || snapshotChanged) {
          setAgentChange(
            Object.freeze({
              runId: request.runId,
              appliedAt: Date.now(),
              status: 'conflicted' as const,
              geometrySnapshot: Object.freeze({
                before: comparison.sourceBundle.geometrySnapshot,
                after: next.sourceBundle.geometrySnapshot,
              }),
              files: Object.freeze(files),
            }),
          )
        } else setAgentChange(null)
        return {
          status: 'conflicted' as const,
          message: 'Agent 실행 중 Experiment 또는 Geometry context가 변경되어 staged diff만 표시했습니다.',
          firstChangedFile,
          changedFiles: files.length,
        }
      }
      if (files.length === 0 && !snapshotChanged) {
        return { status: 'applied' as const, firstChangedFile: null, changedFiles: 0 }
      }
      experimentRef.current = next
      setAgentWorkspaceIdentity(null)
      setExperiment(next)
      if (snapshotChanged) syncGeometrySnapshot(next.sourceBundle.geometrySnapshot)
      clearMeasurement()
      setCandidateMaterialParameters(null)
      setAgentChange(
        Object.freeze({
          runId: request.runId,
          appliedAt: Date.now(),
          status: 'applied' as const,
          geometrySnapshot: Object.freeze({
            before: current.sourceBundle.geometrySnapshot,
            after: next.sourceBundle.geometrySnapshot,
          }),
          files: Object.freeze(files),
        }),
      )
      return {
        status: 'applied' as const,
        firstChangedFile,
        changedFiles: files.length,
      }
    },
    [clearMeasurement, syncGeometrySnapshot],
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
    const snapshots = agentChange.geometrySnapshot
    const agentChangedGeometrySnapshot =
      snapshots &&
      JSON.stringify(canonicalizeGeometrySnapshot(snapshots.before)) !==
        JSON.stringify(canonicalizeGeometrySnapshot(snapshots.after))
    if (
      agentChangedGeometrySnapshot &&
      JSON.stringify(canonicalizeGeometrySnapshot(current.sourceBundle.geometrySnapshot)) !==
        JSON.stringify(canonicalizeGeometrySnapshot(snapshots.after))
    ) {
      toast.error('Geometry graph가 Agent 반영 후 다시 변경되어 전체 Undo를 적용하지 않았습니다.')
      return false
    }
    const restored = createExperimentDocument(
      createExperimentSourceBundle(
        files,
        agentChangedGeometrySnapshot ? snapshots.before : current.sourceBundle.geometrySnapshot,
      ),
    )
    experimentRef.current = restored
    setAgentWorkspaceIdentity(null)
    setExperiment(restored)
    if (agentChangedGeometrySnapshot) syncGeometrySnapshot(restored.sourceBundle.geometrySnapshot)
    clearMeasurement()
    setCandidateMaterialParameters(null)
    setAgentChange(null)
    toast.success('AI Agent 변경을 되돌렸습니다.')
    return true
  }, [agentChange, clearMeasurement, syncGeometrySnapshot])

  const generateCandidate = useCallback(() => {
    clearMeasurement()
    setCandidateMaterialParameters(null)
    experimentDocument.generateCandidate()
  }, [clearMeasurement, experimentDocument])

  const measurementActions = useCaeMeasurementActions({
    authenticated,
    experimentClean,
    experimentDocument,
    experimentId,
    experimentSourceHash: experimentRecord?.source_hash ?? null,
    onGenerateCandidate: generateCandidate,
    selection,
    simulation,
  })

  useEffect(() => {
    setCurrentExperimentId(experimentId)
  }, [experimentId, setCurrentExperimentId])

  useEffect(() => {
    if (
      selection.measurement ||
      experimentDocument.status !== 'Ready' ||
      experimentDocument.successfulRevision !== experimentDocument.revision ||
      !experimentDocument.variables
    ) {
      return
    }
    setCandidateVars(experimentDocument.variables)
    if (experimentDocument.materialParameters) {
      setCandidateMaterialParameters(experimentDocument.materialParameters)
    }
  }, [
    experimentDocument.materialParameters,
    experimentDocument.revision,
    experimentDocument.status,
    experimentDocument.successfulRevision,
    experimentDocument.variables,
    selection.measurement,
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
      syncGeometrySnapshot(row.source_bundle.geometrySnapshot)
    },
    [clearMeasurement, syncGeometrySnapshot],
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
      syncGeometrySnapshot(sourceBundle.geometrySnapshot)
    },
    [clearMeasurement, syncGeometrySnapshot],
  )

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['experiments'] }),
      queryClient.invalidateQueries({ queryKey: ['work', 'experiments'] }),
      queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'experiment'] }),
    ])
  }, [queryClient])

  const saveExperiment = useCallback(
    async (values: DefinitionFormValues, forceRoot: boolean) => {
      if (!authenticated || !user) throw new Error('로그인이 필요합니다.')
      if (!experiment) throw new Error('저장할 Experiment source가 없습니다.')
      if (!forceRoot && experimentRecord && experimentRecord.user_id !== user.id && !user.roles.includes('admin')) {
        throw new Error('이 Experiment는 Save As로 새 계보에 저장하세요.')
      }
      setSaving('experiment')
      const sourceSequence = requestSequence.current
      try {
        const prepared = await geometry.prepareExperimentSave()
        const savedDocument = createExperimentDocument(createExperimentSourceBundle(prepared.files, prepared.snapshot))
        experimentRef.current = savedDocument
        setAgentWorkspaceIdentity(null)
        setExperiment(savedDocument)
        const result = await saveCadDefinition({
          document: savedDocument,
          forceRoot,
          savedSourceBundle: experimentId ? baselineExperimentBundle : null,
          selectedId: experimentId,
          values,
        })
        const savedSourceBundle = result.sourceBundle ?? savedDocument.sourceBundle
        const fetched = await fetchExperiment(result.id).catch(() => null)
        const row: SavedExperiment = fetched
          ? { ...fetched, source_bundle: savedSourceBundle }
          : {
              id: result.id,
              parent_id: result.parentId,
              user_id: user.id,
              name: values.name,
              description: values.description || null,
              source_bundle: savedSourceBundle,
              source_hash: result.sourceHash,
            }
        await invalidate()
        if (sourceSequence !== requestSequence.current || experimentRef.current !== savedDocument) return result
        setExperimentRecord(row)
        setBaselineExperimentBundle(row.source_bundle)
        setExperimentName(row.name)
        setExperimentDescription(row.description ?? '')
        return result
      } finally {
        setSaving(null)
      }
    },
    [authenticated, baselineExperimentBundle, experiment, experimentId, experimentRecord, geometry, invalidate, user],
  )

  const restoreDraft = useCallback(
    (draft: WorkbenchDraft) => {
      requestSequence.current += 1
      setWorkspaceSession((current) => current + 1)
      setAgentWorkspaceIdentity(null)
      setAgentChange(null)
      const restoredGeometrySource = restoreGeometry(
        draft.geometryManager,
        draft.experimentGeometry,
        draft.experiment.document?.sourceBundle.files['geometry.tsx'],
      )
      const document = draft.experiment.document
        ? createCadSourceDocument(
            'experiment',
            createExperimentSourceBundle(
              { ...draft.experiment.document.sourceBundle.files, 'geometry.tsx': restoredGeometrySource },
              draft.experiment.document.sourceBundle.geometrySnapshot,
            ),
          )
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
    [authenticated, restoreGeometry],
  )

  const selectionIds = useMemo(
    () => ({ measurementId: pendingMeasurementId ?? selection.measurement?.id ?? null }),
    [pendingMeasurementId, selection.measurement?.id],
  )

  const draft = useCallback(
    (
      layout: Readonly<{
        openTabs: readonly WorkbenchTabId[]
        activeTab: WorkbenchTabId | null
        experimentFile: string | null
        splitPercent: number
      }>,
    ): WorkbenchDraft => {
      const geometryDraft = createGeometryDraftState()
      return {
        version: 12,
        savedAt: Date.now(),
        experiment: {
          record: experimentRecord,
          baselineBundle: baselineExperimentBundle,
          document: experiment,
          name: experimentName,
          description: experimentDescription,
        },
        candidate: {
          vars: candidateVars,
          materialParameters: candidateMaterialParameters,
        },
        selection: selectionIds,
        geometryManager: geometryDraft.geometryManager,
        experimentGeometry: geometryDraft.experimentGeometry,
        layout,
      }
    },
    [
      baselineExperimentBundle,
      candidateMaterialParameters,
      candidateVars,
      experiment,
      experimentDescription,
      experimentName,
      experimentRecord,
      createGeometryDraftState,
      selectionIds,
    ],
  )

  const experimentManageable = Boolean(
    experimentRecord && user && (experimentRecord.user_id === user.id || user.roles.includes('admin')),
  )

  return {
    experiment,
    experimentRecord,
    experimentId,
    experimentName,
    experimentDescription,
    experimentDirty,
    experimentSourceDirty,
    geometryGraphDirty,
    geometryLocalDraftDirty,
    hasUnsavedExperimentWork,
    hasUnsavedWork,
    experimentClean,
    experimentStatus: definitionStatus(experiment, experimentRecord, experimentDirty),
    experimentManageable,
    agentChange,
    agentWorkspaceIdentity: currentAgentWorkspaceIdentity,
    agentWorkspaceSession: workspaceSession,
    candidateVars,
    candidateMaterialParameters,
    saving,
    selection,
    selectionIds,
    selectionRestoring: selectionRestoreStatus === 'restoring',
    measurementActions,
    experimentDocument,
    simulation,
    geometry,
    applyExperiment,
    loadExperiment,
    restoreSelection,
    newExperiment,
    saveExperiment,
    restoreDraft,
    draft,
    applyAgentBundle,
    undoAgentChange,
  }
}

export type CaeWorkbenchState = ReturnType<typeof useCaeWorkbenchState>
