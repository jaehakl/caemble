import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, getListRequest, type UserData } from '@/api'
import { useCurrentCadSelection } from '@/features/viewer/current-cad-selection'
import type { DefinitionFormValues } from '@/features/viewer/persistence/SaveDefinitionDialog'
import { saveCadDefinition } from '@/features/viewer/persistence/saveDefinition'
import { useCadWorkspace } from '@/features/viewer/workspace/useCadWorkspace'
import {
  canonicalizeGeometrySnapshot,
  createCadSourceDocument,
  createExperimentSourceBundle,
  type ExperimentSourceBundle,
  type ExperimentSourceDocument,
  type GeometrySnapshot,
  type Vars,
} from '@/lib/cad'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import { useGeometryWorkspaceState } from '../geometry'
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

  const handleGeometryExperimentChange = useCallback(
    (snapshot: GeometrySnapshot, files?: Readonly<Record<string, string>>) => {
      setExperiment((current) =>
        current
          ? createExperimentDocument(createExperimentSourceBundle(files ?? current.sourceBundle.files, snapshot))
          : current,
      )
      clearMeasurement()
      setCandidateMaterialParameters(null)
    },
    [clearMeasurement],
  )

  const geometry = useGeometryWorkspaceState({
    authenticated,
    initialNamespace: user?.geometry_namespace ?? (authenticated ? null : 'local'),
    onExperimentChange: handleGeometryExperimentChange,
    snapshot: experiment?.sourceBundle.geometrySnapshot ?? null,
    sourceFiles: experiment?.sourceBundle.files ?? {},
  })
  const resetGeometry = geometry.reset
  const restoreGeometry = geometry.restore
  const createGeometryDraftState = geometry.draftState
  const experimentSourceDirty = Boolean(
    experiment && !sourceFilesEqual(experiment.sourceBundle, baselineExperimentBundle),
  )
  const geometryGraphDirty = Boolean(
    experiment && !geometrySnapshotsEqual(experiment.sourceBundle, baselineExperimentBundle),
  )
  const geometryLocalDraftDirty = Object.keys(geometry.drafts).length > 0
  const experimentDirty = experimentSourceDirty || geometryGraphDirty
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
      setExperiment(document)
      clearMeasurement()
      setCandidateMaterialParameters(null)
    },
    [clearMeasurement],
  )

  const { experimentDocument, simulation } = useCadWorkspace(
    experiment,
    handleExperimentChange,
    candidateVars ?? undefined,
    candidateMaterialParameters,
    authenticated && !geometry.hasReachableDrafts,
    geometry.previewDraftActive ? geometry.draftOverlay : undefined,
    workspaceSession,
    !authenticated,
  )

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
      setWorkspaceSession((current) => current + 1)
      clearMeasurement()
      setExperiment(createExperimentDocument(row.source_bundle))
      setExperimentRecord(row)
      setBaselineExperimentBundle(row.source_bundle)
      setExperimentName(row.name)
      setExperimentDescription(row.description ?? '')
      setCandidateVars(null)
      setCandidateMaterialParameters(null)
      resetGeometry(row.source_bundle.geometrySnapshot)
    },
    [clearMeasurement, resetGeometry],
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
      name = 'Untitled Experiment',
      description = '',
    ) => {
      requestSequence.current += 1
      setWorkspaceSession((current) => current + 1)
      clearMeasurement()
      setExperiment(createExperimentDocument(sourceBundle))
      setExperimentRecord(null)
      setBaselineExperimentBundle(sourceBundle)
      setExperimentName(name)
      setExperimentDescription(description)
      setCandidateVars(null)
      setCandidateMaterialParameters(null)
      resetGeometry(sourceBundle.geometrySnapshot)
    },
    [clearMeasurement, resetGeometry],
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
      const restoredGeometrySource = restoreGeometry(
        draft.geometry,
        draft.experiment.document?.sourceBundle.files['geometry.tsx'],
      )
      setExperiment(
        draft.experiment.document
          ? createCadSourceDocument(
              'experiment',
              createExperimentSourceBundle(
                { ...draft.experiment.document.sourceBundle.files, 'geometry.tsx': restoredGeometrySource },
                draft.experiment.document.sourceBundle.geometrySnapshot,
              ),
            )
          : null,
      )
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
    ): WorkbenchDraft => ({
      version: 10,
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
      geometry: createGeometryDraftState(),
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
    hasUnsavedWork,
    experimentClean,
    experimentStatus: definitionStatus(experiment, experimentRecord, experimentDirty),
    experimentManageable,
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
  }
}

export type CaeWorkbenchState = ReturnType<typeof useCaeWorkbenchState>
