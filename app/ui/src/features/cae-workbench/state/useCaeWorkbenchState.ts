import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, type UserData } from '@/api'
import { privateQueryScope } from '@/features/auth/queryKeys'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import type { DefinitionFormValues, ExperimentSaveMode } from '@/features/viewer/persistence/SaveDefinitionDialog'
import { saveCadDefinition } from '@/features/viewer/persistence/saveDefinition'
import { useCadWorkspace, type CandidateVarsRegeneratedEvent } from '@/features/viewer/workspace/useCadWorkspace'
import {
  createCadSourceDocument,
  experimentTaskPaths,
  type ExperimentSourceBundle,
  type ExperimentSourceDocument,
} from '@/lib/cad/source'
import { varsFingerprint, type Tensor, type Vars } from '@/lib/cad/model'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import { useCaeDataSelection } from '@/features/measurement/useCaeDataSelection'
import { useCaeMeasurementActions } from '@/features/measurement/useCaeMeasurementActions'
import type {
  DefinitionStatus,
  SavedExperiment,
  SavedMeasurement,
  WorkbenchCalculationSelection,
  WorkbenchDraft,
  WorkbenchLayoutState,
  WorkbenchSelectionContext,
} from '../types'
import { validateVarsChanges } from '@/features/calculation/varsTensor'
import { useCalculationDataActions } from '@/features/calculation/useCalculationDataActions'
import { experimentDetailQueryOptions } from '@/features/experiment/queryOptions'
import { experimentRecordContracts } from '@/features/measurement/recordedData'
import { invalidateExperimentMutation, invalidateExperimentSummaries } from '@/features/experiment/queryInvalidation'
import { experimentEditingReducer, initialExperimentEditingState } from './experimentEditingState'

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

export type UseCaeWorkbenchStateOptions = Readonly<{ onActivity?: RuntimeActivityCallback }>
export type CandidateVariablesOrigin = 'user-vars' | 'prediction-inverse' | 'prediction-sampling'

export function useCaeWorkbenchState(
  user: UserData | null,
  authenticated: boolean,
  { onActivity }: UseCaeWorkbenchStateOptions = {},
) {
  const queryClient = useQueryClient()
  const queryScope = privateQueryScope(user)
  const [editing, dispatchEditing] = useReducer(experimentEditingReducer, initialExperimentEditingState)
  const {
    document: experiment,
    record: experimentRecord,
    baselineBundle: baselineExperimentBundle,
    name: experimentName,
    description: experimentDescription,
    candidateVars,
    candidateMaterialSnapshot,
    workspaceSession,
  } = editing
  const [saving, setSaving] = useState<'experiment' | null>(null)
  const [pendingMeasurementId, setPendingMeasurementId] = useState<number | null>(null)
  const [selectionRestoreStatus, setSelectionRestoreStatus] = useState<'idle' | 'restoring' | 'failed'>('idle')
  const [storedSelectionContext, setStoredSelectionContext] = useState<WorkbenchSelectionContext>({
    experimentId: null,
    measurementId: null,
    calculationId: null,
  })
  const selectionContextRef = useRef<WorkbenchSelectionContext>({
    experimentId: null,
    measurementId: null,
    calculationId: null,
  })
  const requestSequence = useRef(0)
  const experimentRef = useRef(experiment)
  const authenticatedRef = useRef(authenticated)
  experimentRef.current = experiment

  const experimentId = experimentRecord?.id ?? null
  const baseSelection = useCaeDataSelection(experimentId, 'visible')
  const {
    clearMeasurement: clearBaseMeasurement,
    flatRecordedData,
    loadMeasurement: loadBaseMeasurement,
    loading: measurementLoading,
    materialSnapshot,
    measurement,
    recordedData,
    recordedRows,
    recordedRules,
    recordedSchemas,
    variables: measurementVariables,
  } = baseSelection
  const selectionContext = useMemo<WorkbenchSelectionContext>(
    () =>
      storedSelectionContext.experimentId === experimentId
        ? storedSelectionContext
        : experimentId === null
          ? { experimentId: null, measurementId: null, calculationId: null }
          : { experimentId, measurementId: null, calculationId: null },
    [experimentId, storedSelectionContext],
  )
  const experimentDirty = Boolean(experiment && !sourceBundlesEqual(experiment.sourceBundle, baselineExperimentBundle))
  const hasUnsavedExperimentWork = experimentDirty
  const experimentClean = Boolean(experimentId && !experimentDirty)
  const hasTasks = Boolean(experiment && experimentTaskPaths(experiment.sourceBundle).length)

  const clearMeasurement = useCallback(() => {
    const current = selectionContextRef.current
    if (current.experimentId !== experimentId) return false
    setPendingMeasurementId(null)
    setSelectionRestoreStatus('idle')
    clearBaseMeasurement()
    const next = { ...current, measurementId: null }
    selectionContextRef.current = next
    setStoredSelectionContext(next)
    return true
  }, [clearBaseMeasurement, experimentId])

  const resetSelectionForExperiment = useCallback(
    (nextExperimentId: number | null) => {
      const next: WorkbenchSelectionContext =
        nextExperimentId === null
          ? { experimentId: null, measurementId: null, calculationId: null }
          : { experimentId: nextExperimentId, measurementId: null, calculationId: null }
      setPendingMeasurementId(null)
      setSelectionRestoreStatus('idle')
      clearBaseMeasurement()
      selectionContextRef.current = next
      setStoredSelectionContext(next)
    },
    [clearBaseMeasurement],
  )

  const loadMeasurement = useCallback(
    async (
      value: number | SavedMeasurement,
      expectedExperimentId: number | null = typeof value === 'number' ? experimentId : value.experiment_id,
    ) => {
      if (
        expectedExperimentId === null ||
        expectedExperimentId !== experimentId ||
        selectionContextRef.current.experimentId !== expectedExperimentId
      ) {
        return null
      }
      const row = await loadBaseMeasurement(value, expectedExperimentId)
      if (!row) return null
      if (row.experiment_id !== expectedExperimentId) return null
      const current = selectionContextRef.current
      if (current.experimentId !== row.experiment_id) return null
      const next = { ...current, measurementId: row.id }
      selectionContextRef.current = next
      setStoredSelectionContext(next)
      dispatchEditing({
        type: 'candidateLoaded',
        vars: row.vars as Readonly<Vars>,
        materialSnapshot: row.material_snapshot,
      })
      setPendingMeasurementId(null)
      setSelectionRestoreStatus('idle')
      return row
    },
    [experimentId, loadBaseMeasurement],
  )

  const selection = useMemo(
    () => ({
      measurement,
      recordedRows,
      recordedData,
      flatRecordedData,
      recordedRules,
      recordedSchemas,
      variables: measurementVariables,
      materialSnapshot,
      loading: measurementLoading,
      clearAll: clearMeasurement,
      clearMeasurement,
      loadMeasurement,
    }),
    [
      clearMeasurement,
      flatRecordedData,
      loadMeasurement,
      materialSnapshot,
      measurement,
      measurementLoading,
      measurementVariables,
      recordedData,
      recordedRows,
      recordedRules,
      recordedSchemas,
    ],
  )

  useEffect(() => {
    const wasAuthenticated = authenticatedRef.current
    authenticatedRef.current = authenticated
    if (authenticated && !wasAuthenticated && !selection.measurement) {
      dispatchEditing({ type: 'candidateMaterialCleared' })
    }
  }, [authenticated, selection.measurement])

  const handleExperimentChange = useCallback(
    (document: ExperimentSourceDocument) => {
      experimentRef.current = document
      dispatchEditing({ type: 'sourceEdited', document })
      clearMeasurement()
    },
    [clearMeasurement],
  )

  const handleCandidateVarsRegenerated = useCallback((event: CandidateVarsRegeneratedEvent) => {
    dispatchEditing({ type: 'candidateVariablesChanged', vars: event.vars })
    toast.info(
      event.reason === 'schema-changed'
        ? 'varsSchema가 변경되어 모든 Candidate 변수를 새로 생성했습니다.'
        : '현재 Candidate가 varsSchema와 맞지 않아 모든 변수를 새로 생성했습니다.',
    )
  }, [])

  const { experimentDocument } = useCadWorkspace(experiment, handleExperimentChange, {
    candidateVars: candidateVars ?? undefined,
    candidateVarsPending: pendingMeasurementId !== null,
    candidateProvenance: selection.measurement || pendingMeasurementId ? 'persisted-measurement' : 'editable',
    persistedMaterialSnapshot: candidateMaterialSnapshot,
    resetKey: workspaceSession,
    onActivity,
    onCandidateVarsRegenerated: handleCandidateVarsRegenerated,
  })
  const experimentSourceValidated = experimentDocument.validatedRevision === experimentDocument.revision

  const generateCandidate = useCallback(() => {
    clearMeasurement()
    dispatchEditing({ type: 'candidateCleared' })
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
    onActivity,
  })

  const setCandidateVariables = useCallback(
    (variables: Readonly<Vars>, origin: CandidateVariablesOrigin) => {
      const schema = experimentDocument.varsSchema
      const fallback = experimentDocument.variables
      if (!schema || (!candidateVars && !fallback)) {
        toast.error('편집할 Candidate 변수 또는 varsSchema가 준비되지 않았습니다.')
        return false
      }
      try {
        const variableKeys = Object.keys(variables).sort()
        const schemaKeys = Object.keys(schema).sort()
        if (variableKeys.length !== schemaKeys.length || variableKeys.some((key, index) => key !== schemaKeys[index])) {
          throw new Error('Candidate vars는 현재 varsSchema와 정확히 같은 key를 가져야 합니다.')
        }
        const normalized = validateVarsChanges(variables, schema)
        if (selection.measurement) clearMeasurement()
        dispatchEditing({
          type: 'candidateVariablesChanged',
          vars: Object.freeze(normalized),
          clearMaterialSnapshot: origin === 'prediction-sampling',
        })
        return true
      } catch (cause: unknown) {
        toast.error(cause instanceof Error ? cause.message : String(cause))
        return false
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
  const setCandidateVariable = useCallback(
    (key: string, value: Tensor) => {
      const current = candidateVars ?? experimentDocument.variables
      if (!current) {
        toast.error('편집할 Candidate 변수가 준비되지 않았습니다.')
        return false
      }
      return setCandidateVariables({ ...current, [key]: value }, 'user-vars')
    },
    [candidateVars, experimentDocument.variables, setCandidateVariables],
  )

  useEffect(() => {
    if (
      selection.measurement ||
      experimentDocument.resultSessionKey !== workspaceSession ||
      experimentDocument.status !== 'Ready' ||
      experimentDocument.successfulRevision !== experimentDocument.revision ||
      !experimentDocument.variables ||
      (candidateVars !== null && varsFingerprint(candidateVars) !== varsFingerprint(experimentDocument.variables))
    ) {
      return
    }
    dispatchEditing({
      type: 'candidateEvaluationAccepted',
      vars: experimentDocument.variables,
      ...(experimentDocument.materialSnapshot ? { materialSnapshot: experimentDocument.materialSnapshot } : {}),
    })
  }, [
    experimentDocument.materialSnapshot,
    experimentDocument.resultSessionKey,
    experimentDocument.revision,
    experimentDocument.status,
    experimentDocument.successfulRevision,
    experimentDocument.variables,
    candidateVars,
    selection.measurement,
    workspaceSession,
  ])

  useEffect(() => {
    if ((!authenticated && !experimentRecord?.isDemo) || !pendingMeasurementId || !experimentId) return
    const measurementId = pendingMeasurementId
    setSelectionRestoreStatus('restoring')
    void loadMeasurement(measurementId, experimentId).catch((cause: unknown) => {
      if (measurementId !== pendingMeasurementId) return
      const current = selectionContextRef.current
      if (current.experimentId === experimentId && current.measurementId === measurementId) {
        const next = { ...current, measurementId: null }
        selectionContextRef.current = next
        setStoredSelectionContext(next)
      }
      setPendingMeasurementId(null)
      setSelectionRestoreStatus('failed')
      toast.error(cause instanceof Error ? cause.message : '저장된 Measurement 선택을 복원하지 못했습니다.')
    })
  }, [authenticated, experimentId, experimentRecord?.isDemo, loadMeasurement, pendingMeasurementId])

  const applyExperimentState = useCallback(
    (row: SavedExperiment) => {
      const document = createExperimentDocument(row.source_bundle)
      resetSelectionForExperiment(row.id)
      experimentRef.current = document
      dispatchEditing({ type: 'recordLoaded', document, record: row })
    },
    [resetSelectionForExperiment],
  )

  const applyExperiment = useCallback(
    (row: SavedExperiment) => {
      requestSequence.current += 1
      applyExperimentState(row)
    },
    [applyExperimentState],
  )

  const loadExperiment = useCallback(
    async (value: number | SavedExperiment) => {
      const sequence = ++requestSequence.current
      const row =
        typeof value === 'number'
          ? await queryClient.fetchQuery(experimentDetailQueryOptions(queryScope, value))
          : value
      if (sequence !== requestSequence.current) return row
      applyExperimentState(row)
      return row
    },
    [applyExperimentState, queryClient, queryScope],
  )

  const selectCalculation = useCallback(
    ({ experimentId: requestedExperimentId, calculationId }: WorkbenchCalculationSelection) => {
      if (requestedExperimentId !== experimentId || (calculationId !== null && requestedExperimentId === null)) {
        return false
      }
      const current = selectionContextRef.current
      if (current.experimentId !== requestedExperimentId) return false
      const next = { ...current, calculationId } as WorkbenchSelectionContext
      selectionContextRef.current = next
      setStoredSelectionContext(next)
      return true
    },
    [experimentId],
  )

  const newExperiment = useCallback(
    (
      sourceBundle: ExperimentSourceBundle = starterExperimentSourceBundle,
      name = 'Starter Experiment',
      description = '',
    ) => {
      const document = createExperimentDocument(sourceBundle)
      requestSequence.current += 1
      resetSelectionForExperiment(null)
      experimentRef.current = document
      dispatchEditing({ type: 'newStarted', document, sourceBundle, name, description })
    },
    [resetSelectionForExperiment],
  )

  const detachDeletedExperiment = useCallback(() => {
    const current = experimentRef.current
    if (!current) return
    const document = createExperimentDocument(current.sourceBundle)
    requestSequence.current += 1
    resetSelectionForExperiment(null)
    experimentRef.current = document
    dispatchEditing({ type: 'detached', document })
  }, [resetSelectionForExperiment])

  const invalidate = useCallback(
    async (changedExperimentId: number) => {
      await invalidateExperimentMutation(queryClient, queryScope, changedExperimentId)
    },
    [queryClient, queryScope],
  )

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
          records: experimentRecordContracts(experimentDocument.simulationProgram?.recordedData ?? Object.freeze({})),
          values,
        })
        const fetched = await queryClient
          .fetchQuery(experimentDetailQueryOptions(queryScope, result.id))
          .catch(() => null)
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
        await invalidate(result.id)
        if (sourceSequence !== requestSequence.current) return result
        if (result.id !== experimentId) resetSelectionForExperiment(result.id)
        dispatchEditing({
          type: 'saveCommitted',
          record: row,
          baselineBundle: savedDocument.sourceBundle,
        })
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
      experimentDocument.simulationProgram?.recordedData,
      invalidate,
      queryClient,
      queryScope,
      resetSelectionForExperiment,
      user,
    ],
  )

  const restoreDraft = useCallback(
    (draft: WorkbenchDraft) => {
      requestSequence.current += 1
      clearBaseMeasurement()
      const restoredExperimentId = draft.experiment.record?.id ?? null
      const restoredSelection: WorkbenchSelectionContext =
        restoredExperimentId === null
          ? { experimentId: null, measurementId: null, calculationId: null }
          : draft.selection.experimentId === restoredExperimentId
            ? draft.selection
            : { experimentId: restoredExperimentId, measurementId: null, calculationId: null }
      const document = draft.experiment.document
        ? createExperimentDocument(draft.experiment.document.sourceBundle)
        : null
      experimentRef.current = document
      dispatchEditing({
        type: 'draftRestored',
        draft,
        document,
        candidateMaterialSnapshot: authenticated ? draft.candidate.materialSnapshot : null,
      })
      selectionContextRef.current = restoredSelection
      setStoredSelectionContext(restoredSelection)
      setPendingMeasurementId(restoredSelection.measurementId)
      setSelectionRestoreStatus(restoredSelection.measurementId ? 'restoring' : 'idle')
    },
    [authenticated, clearBaseMeasurement],
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
      candidate: { vars: candidateVars, materialSnapshot: candidateMaterialSnapshot },
      selection: selectionContext,
      layout,
    }),
    [
      baselineExperimentBundle,
      candidateMaterialSnapshot,
      candidateVars,
      experiment,
      experimentDescription,
      experimentName,
      experimentRecord,
      selectionContext,
    ],
  )

  const experimentManageable = Boolean(
    experimentRecord &&
    user &&
    (user.roles.includes('admin') || (!experimentRecord.isDemo && experimentRecord.user_id === user.id)),
  )
  const experimentIsDemo = Boolean(experimentRecord?.isDemo)
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
    dispatchEditing({
      type: 'usageRefreshed',
      experimentId,
      derivedCounts: usage.derivedCounts,
      sourceLocked: usage.sourceLocked,
    })
    await invalidateExperimentSummaries(queryClient, queryScope, experimentId)
  }, [experimentId, queryClient, queryScope])

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
    experimentIsDemo,
    experimentCoordinate,
    experimentVersion,
    experimentNamespaces: user?.experiment_namespaces ?? [],
    sourceLocked,
    refreshExperimentUsage,
    hasTasks,
    workspaceSession,
    candidateVars,
    candidateMaterialSnapshot,
    setCandidateVariable,
    setCandidateVariables,
    saving,
    selection,
    selectionContext,
    selectCalculation,
    selectionRestoring: pendingMeasurementId !== null || selectionRestoreStatus === 'restoring',
    measurementActions,
    calculationDataActions,
    experimentDocument,
    applyExperiment,
    loadExperiment,
    newExperiment,
    detachDeletedExperiment,
    saveExperiment,
    restoreDraft,
    draft,
  }
}

export type CaeWorkbenchState = ReturnType<typeof useCaeWorkbenchState>
