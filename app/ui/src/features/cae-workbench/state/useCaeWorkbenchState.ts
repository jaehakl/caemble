import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, getListRequest, type UserData } from '@/api'
import { useCurrentCadSelection } from '@/features/viewer/current-cad-selection'
import type { DefinitionFormValues } from '@/features/viewer/persistence/SaveDefinitionDialog'
import { resolveDocumentMaterials } from '@/features/viewer/persistence/resolveMaterials'
import { saveCadDefinition } from '@/features/viewer/persistence/saveDefinition'
import { useCadWorkspace } from '@/features/viewer/workspace/useCadWorkspace'
import { cadSource, createCadSourceDocument, type CadSourceDocument, type EvaluatedDocumentSnapshot } from '@/lib/cad'
import { defaultCode } from '@/lib/defaultCode'
import { defaultExperimentSourceBundle } from '@/lib/defaultExperimentCode'
import type { CaembleProgramExample } from '@/lib/examples'
import { useCaeDataSelection } from '../measurement/useCaeDataSelection'
import { useCaeMeasurementActions } from '../measurement/useCaeMeasurementActions'
import type { DefinitionStatus, SavedExperiment, SavedStructure, WorkbenchDraft, WorkbenchTabId } from '../types'

type PendingSelection = Readonly<{
  structureId: number | null
  experimentId: number | null
  sampleId: number | null
  setupId: number | null
  measurementId: number | null
}>

function status(document: CadSourceDocument | null, record: { id: number } | null, dirty: boolean): DefinitionStatus {
  if (!document) return 'empty'
  if (!record) return 'new'
  return dirty ? 'saved-dirty' : 'saved-clean'
}

function sourceBundlesEqual(left: SavedExperiment['source_bundle'], right: SavedExperiment['source_bundle'] | null) {
  if (!right || left.formatVersion !== right.formatVersion) return false
  const paths = [...new Set([...Object.keys(left.files), ...Object.keys(right.files)])]
  return paths.every((path) => left.files[path] === right.files[path])
}

async function fetchStructure(id: number) {
  const row = (await dbTables.Structure.listRows(getListRequest('visible', [id]))).items[0]
  if (!row?.id) throw new Error(`Structure #${id}을 찾을 수 없습니다.`)
  return row as SavedStructure
}

async function fetchExperiment(id: number) {
  const row = (await dbTables.Experiment.listRows(getListRequest('visible', [id]))).items[0]
  if (!row?.id) throw new Error(`Experiment #${id}을 찾을 수 없습니다.`)
  return row as SavedExperiment
}

export function useCaeWorkbenchState(user: UserData | null, authenticated: boolean) {
  const queryClient = useQueryClient()
  const { setCurrentExperimentId, setCurrentStructureId } = useCurrentCadSelection()
  const [structure, setStructure] = useState<CadSourceDocument | null>(null)
  const [experiment, setExperiment] = useState<CadSourceDocument | null>(null)
  const [structureRecord, setStructureRecord] = useState<SavedStructure | null>(null)
  const [experimentRecord, setExperimentRecord] = useState<SavedExperiment | null>(null)
  const [baselineStructureCode, setBaselineStructureCode] = useState<string | null>(null)
  const [baselineExperimentBundle, setBaselineExperimentBundle] = useState<SavedExperiment['source_bundle'] | null>(
    null,
  )
  const [structureName, setStructureName] = useState('Untitled Structure')
  const [structureDescription, setStructureDescription] = useState('')
  const [experimentName, setExperimentName] = useState('Untitled Experiment')
  const [experimentDescription, setExperimentDescription] = useState('')
  const [saving, setSaving] = useState<'structure' | 'experiment' | null>(null)
  const [pendingDraftSelection, setPendingDraftSelection] = useState<PendingSelection | null>(null)
  const [selectionRestoreStatus, setSelectionRestoreStatus] = useState<'idle' | 'restoring' | 'failed'>('idle')
  const pendingSelectionRef = useRef<PendingSelection | null>(null)
  const attemptedSelectionRef = useRef<PendingSelection | null>(null)
  const structureRequestSequence = useRef(0)
  const experimentRequestSequence = useRef(0)
  const structureRef = useRef(structure)
  const experimentRef = useRef(experiment)
  structureRef.current = structure
  experimentRef.current = experiment

  const queueSelectionRestore = useCallback((next: PendingSelection) => {
    pendingSelectionRef.current = next
    attemptedSelectionRef.current = null
    setSelectionRestoreStatus('restoring')
    setPendingDraftSelection(next)
  }, [])

  const clearPendingSelectionRestore = useCallback(() => {
    pendingSelectionRef.current = null
    attemptedSelectionRef.current = null
    setSelectionRestoreStatus('idle')
    setPendingDraftSelection(null)
  }, [])

  const structureId = structureRecord?.id ?? null
  const experimentId = experimentRecord?.id ?? null
  const structureDirty = Boolean(
    structure &&
    structure.kind === 'structure' &&
    (baselineStructureCode === null || cadSource(structure) !== baselineStructureCode),
  )
  const experimentDirty = Boolean(
    experiment &&
    experiment.kind === 'experiment' &&
    !sourceBundlesEqual(experiment.sourceBundle, baselineExperimentBundle),
  )
  const pairClean = Boolean(structureId && experimentId && !structureDirty && !experimentDirty)
  const structureClean = Boolean(structureId && !structureDirty)
  const experimentClean = Boolean(experimentId && !experimentDirty)
  const selection = useCaeDataSelection(structureId, experimentId, user?.roles.includes('admin') ? 'visible' : 'mine')

  const resolveMaterials = useCallback(
    (snapshot: EvaluatedDocumentSnapshot) =>
      resolveDocumentMaterials(
        snapshot,
        snapshot.kind === 'structure'
          ? structureDirty
            ? null
            : selection.structureMaterialSnapshot
          : experimentDirty
            ? null
            : selection.experimentMaterialSnapshot,
      ),
    [experimentDirty, selection.experimentMaterialSnapshot, selection.structureMaterialSnapshot, structureDirty],
  )
  const handleStructureChange = useCallback((document: CadSourceDocument) => setStructure(document), [])
  const handleExperimentChange = useCallback((document: CadSourceDocument) => setExperiment(document), [])
  const { experimentDocument, simulation, structureDocument } = useCadWorkspace(
    structure,
    experiment,
    authenticated ? handleStructureChange : undefined,
    authenticated ? handleExperimentChange : undefined,
    structureClean ? selection.structureVars : undefined,
    experimentClean ? selection.experimentVars : undefined,
    resolveMaterials,
    'fast-reroll',
    authenticated,
  )
  const measurementActions = useCaeMeasurementActions({
    authenticated,
    experimentDocument,
    experimentClean,
    experimentId,
    pairClean,
    selection,
    simulation,
    structureDocument,
    structureClean,
    structureId,
  })

  useEffect(() => {
    setCurrentStructureId(structureId)
    setCurrentExperimentId(experimentId)
  }, [experimentId, setCurrentExperimentId, setCurrentStructureId, structureId])

  useEffect(() => {
    pendingSelectionRef.current = pendingDraftSelection
  }, [pendingDraftSelection])

  useEffect(() => {
    if (
      !pendingDraftSelection ||
      pendingDraftSelection.structureId !== structureId ||
      pendingDraftSelection.experimentId !== experimentId
    ) {
      return
    }
    if (attemptedSelectionRef.current === pendingDraftSelection) return

    const pending = pendingDraftSelection
    attemptedSelectionRef.current = pending
    setSelectionRestoreStatus('restoring')
    void (
      pending.measurementId
        ? structureId && experimentId
          ? selection.loadMeasurement(pending.measurementId, { structureId, experimentId })
          : Promise.reject(new Error('Measurement 선택을 복원할 Structure와 Experiment가 없습니다.'))
        : Promise.all([
            pending.sampleId ? selection.selectSample(pending.sampleId) : Promise.resolve(null),
            pending.setupId ? selection.selectSetup(pending.setupId) : Promise.resolve(null),
          ])
    )
      .then(() => {
        if (pendingSelectionRef.current !== pending) return
        pendingSelectionRef.current = null
        attemptedSelectionRef.current = null
        setPendingDraftSelection(null)
        setSelectionRestoreStatus('idle')
      })
      .catch((cause: unknown) => {
        if (pendingSelectionRef.current !== pending) return
        setSelectionRestoreStatus('failed')
        toast.error(
          cause instanceof Error
            ? cause.message
            : pending.measurementId
              ? '저장된 Measurement 선택을 복원하지 못했습니다.'
              : '저장된 실현값 선택을 복원하지 못했습니다.',
        )
      })
  }, [experimentId, pendingDraftSelection, selection, structureId])

  const applyStructureState = useCallback(
    (row: SavedStructure) => {
      clearPendingSelectionRestore()
      setStructure(createCadSourceDocument('structure', row.code))
      setStructureRecord(row)
      setBaselineStructureCode(row.code)
      setStructureName(row.name)
      setStructureDescription(row.description ?? '')
    },
    [clearPendingSelectionRestore],
  )

  const applyExperimentState = useCallback(
    (row: SavedExperiment) => {
      clearPendingSelectionRestore()
      setExperiment(createCadSourceDocument('experiment', row.source_bundle))
      setExperimentRecord(row)
      setBaselineExperimentBundle(row.source_bundle)
      setExperimentName(row.name)
      setExperimentDescription(row.description ?? '')
    },
    [clearPendingSelectionRestore],
  )

  const applyStructure = useCallback(
    (row: SavedStructure) => {
      structureRequestSequence.current += 1
      applyStructureState(row)
    },
    [applyStructureState],
  )

  const applyExperiment = useCallback(
    (row: SavedExperiment) => {
      experimentRequestSequence.current += 1
      applyExperimentState(row)
    },
    [applyExperimentState],
  )

  const loadStructure = useCallback(
    async (value: number | SavedStructure) => {
      const sequence = ++structureRequestSequence.current
      const row = typeof value === 'number' ? await fetchStructure(value) : value
      if (sequence === structureRequestSequence.current) applyStructureState(row)
      return row
    },
    [applyStructureState],
  )

  const loadExperiment = useCallback(
    async (value: number | SavedExperiment) => {
      const sequence = ++experimentRequestSequence.current
      const row = typeof value === 'number' ? await fetchExperiment(value) : value
      if (sequence === experimentRequestSequence.current) applyExperimentState(row)
      return row
    },
    [applyExperimentState],
  )

  const loadResearch = useCallback(
    async (nextStructureId: number, nextExperimentId: number, measurementId?: number | null) => {
      const structureSequence = ++structureRequestSequence.current
      const experimentSequence = ++experimentRequestSequence.current
      const [nextStructure, nextExperiment] = await Promise.all([
        fetchStructure(nextStructureId),
        fetchExperiment(nextExperimentId),
      ])
      if (
        structureSequence !== structureRequestSequence.current ||
        experimentSequence !== experimentRequestSequence.current
      ) {
        return
      }
      applyStructureState(nextStructure)
      applyExperimentState(nextExperiment)
      if (measurementId) {
        queueSelectionRestore({
          structureId: nextStructureId,
          experimentId: nextExperimentId,
          sampleId: null,
          setupId: null,
          measurementId,
        })
      }
    },
    [applyExperimentState, applyStructureState, queueSelectionRestore],
  )

  const restoreSelection = useCallback(
    (
      next: Readonly<{ sampleId: number | null; setupId: number | null; measurementId: number | null }>,
      expected: Readonly<{ structureId: number | null; experimentId: number | null }> = {
        structureId,
        experimentId,
      },
    ) => {
      queueSelectionRestore({
        ...expected,
        sampleId: next.sampleId,
        setupId: next.setupId,
        measurementId: next.measurementId,
      })
    },
    [experimentId, queueSelectionRestore, structureId],
  )

  const newStructure = useCallback(
    (source = defaultCode, name = 'Untitled Structure', description = '') => {
      structureRequestSequence.current += 1
      clearPendingSelectionRestore()
      setStructure(createCadSourceDocument('structure', source))
      setStructureRecord(null)
      setBaselineStructureCode(null)
      setStructureName(name)
      setStructureDescription(description)
    },
    [clearPendingSelectionRestore],
  )

  const newExperiment = useCallback(
    (sourceBundle = defaultExperimentSourceBundle, name = 'Untitled Experiment', description = '') => {
      experimentRequestSequence.current += 1
      clearPendingSelectionRestore()
      setExperiment(createCadSourceDocument('experiment', sourceBundle))
      setExperimentRecord(null)
      setBaselineExperimentBundle(null)
      setExperimentName(name)
      setExperimentDescription(description)
    },
    [clearPendingSelectionRestore],
  )

  const newResearch = useCallback(
    (example: CaembleProgramExample) => {
      newStructure(example.structureCode, `${example.title} Structure`, example.description)
      newExperiment(example.experimentSourceBundle, `${example.title} Experiment`, example.description)
    },
    [newExperiment, newStructure],
  )

  const invalidate = useCallback(
    async (kind: 'structure' | 'experiment') => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [kind === 'structure' ? 'structures' : 'experiments'] }),
        queryClient.invalidateQueries({ queryKey: ['work', `${kind}s`] }),
        queryClient.invalidateQueries({ queryKey: ['cae-workbench', kind] }),
        queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'measurement-pairs'] }),
      ])
    },
    [queryClient],
  )

  const saveStructure = useCallback(
    async (values: DefinitionFormValues, forceRoot: boolean) => {
      if (!authenticated || !user) throw new Error('로그인이 필요합니다.')
      if (!structure || structure.kind !== 'structure') throw new Error('저장할 Structure source가 없습니다.')
      if (!forceRoot && structureRecord && structureRecord.user_id !== user.id && !user.roles.includes('admin')) {
        throw new Error('이 Structure는 Save As로 새 계보에 저장하세요.')
      }
      setSaving('structure')
      const sourceSequence = structureRequestSequence.current
      const savedDocument = structure
      try {
        const result = await saveCadDefinition({
          document: structure,
          forceRoot,
          kind: 'structure',
          savedCode: baselineStructureCode,
          selectedId: structureId,
          values,
        })
        const fetched = await fetchStructure(result.id).catch(() => null)
        const row: SavedStructure = fetched ?? {
          id: result.id,
          parent_id: result.parentId,
          user_id: user.id,
          name: values.name,
          description: values.description || null,
          code: result.code ?? cadSource(structure),
        }
        await invalidate('structure')
        if (sourceSequence !== structureRequestSequence.current || structureRef.current !== savedDocument) {
          return result
        }
        setStructureRecord(row)
        setBaselineStructureCode(row.code)
        setStructureName(row.name)
        setStructureDescription(row.description ?? '')
        return result
      } finally {
        setSaving(null)
      }
    },
    [authenticated, baselineStructureCode, invalidate, structure, structureId, structureRecord, user],
  )

  const saveExperiment = useCallback(
    async (values: DefinitionFormValues, forceRoot: boolean) => {
      if (!authenticated || !user) throw new Error('로그인이 필요합니다.')
      if (!experiment || experiment.kind !== 'experiment') throw new Error('저장할 Experiment source가 없습니다.')
      if (!forceRoot && experimentRecord && experimentRecord.user_id !== user.id && !user.roles.includes('admin')) {
        throw new Error('이 Experiment는 Save As로 새 계보에 저장하세요.')
      }
      setSaving('experiment')
      const sourceSequence = experimentRequestSequence.current
      const savedDocument = experiment
      try {
        const result = await saveCadDefinition({
          document: experiment,
          forceRoot,
          kind: 'experiment',
          savedCode: null,
          savedSourceBundle: baselineExperimentBundle,
          selectedId: experimentId,
          values,
        })
        const savedSourceBundle = result.sourceBundle ?? experiment.sourceBundle
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
            }
        await invalidate('experiment')
        if (sourceSequence !== experimentRequestSequence.current || experimentRef.current !== savedDocument) {
          return result
        }
        setExperimentRecord(row)
        setBaselineExperimentBundle(row.source_bundle)
        setExperimentName(row.name)
        setExperimentDescription(row.description ?? '')
        return result
      } finally {
        setSaving(null)
      }
    },
    [authenticated, baselineExperimentBundle, experiment, experimentId, experimentRecord, invalidate, user],
  )

  const restoreDraft = useCallback(
    (draft: WorkbenchDraft) => {
      structureRequestSequence.current += 1
      experimentRequestSequence.current += 1
      setStructure(draft.structure.document)
      setStructureRecord(draft.structure.record)
      setBaselineStructureCode(draft.structure.baselineCode)
      setStructureName(draft.structure.name)
      setStructureDescription(draft.structure.description)
      setExperiment(draft.experiment.document)
      setExperimentRecord(draft.experiment.record)
      setBaselineExperimentBundle(draft.experiment.baselineBundle)
      setExperimentName(draft.experiment.name)
      setExperimentDescription(draft.experiment.description)
      queueSelectionRestore({
        structureId: draft.structure.record?.id ?? null,
        experimentId: draft.experiment.record?.id ?? null,
        sampleId: draft.selection.sampleId,
        setupId: draft.selection.setupId,
        measurementId: draft.selection.measurementId,
      })
    },
    [queueSelectionRestore],
  )

  const restoreStaleDraft = useCallback(
    (
      savedDraft: WorkbenchDraft,
      database: Readonly<{ structure: SavedStructure | null; experiment: SavedExperiment | null }>,
    ) => {
      structureRequestSequence.current += 1
      experimentRequestSequence.current += 1
      setStructure(savedDraft.structure.document)
      setStructureRecord(database.structure)
      setBaselineStructureCode(database.structure?.code ?? null)
      setStructureName(savedDraft.structure.name)
      setStructureDescription(savedDraft.structure.description)
      setExperiment(savedDraft.experiment.document)
      setExperimentRecord(database.experiment)
      setBaselineExperimentBundle(database.experiment?.source_bundle ?? null)
      setExperimentName(savedDraft.experiment.name)
      setExperimentDescription(savedDraft.experiment.description)
      queueSelectionRestore({
        structureId: database.structure?.id ?? null,
        experimentId: database.experiment?.id ?? null,
        sampleId: savedDraft.selection.sampleId,
        setupId: savedDraft.selection.setupId,
        measurementId: savedDraft.selection.measurementId,
      })
    },
    [queueSelectionRestore],
  )

  const pendingSelection =
    pendingDraftSelection?.structureId === structureId && pendingDraftSelection.experimentId === experimentId
      ? pendingDraftSelection
      : null
  const selectionIds = useMemo(
    () => ({
      sampleId: pendingSelection ? pendingSelection.sampleId : (selection.sample?.id ?? null),
      setupId: pendingSelection ? pendingSelection.setupId : (selection.setup?.id ?? null),
      measurementId: pendingSelection ? pendingSelection.measurementId : (selection.measurement?.id ?? null),
    }),
    [pendingSelection, selection.measurement?.id, selection.sample?.id, selection.setup?.id],
  )

  const draft = useCallback(
    (
      userKey: string,
      layout: Readonly<{
        openTabs: readonly WorkbenchTabId[]
        activeTab: WorkbenchTabId | null
        experimentFile: string | null
        splitPercent: number
      }>,
    ): WorkbenchDraft => ({
      version: 1,
      savedAt: Date.now(),
      userKey,
      structure: {
        record: structureRecord,
        baselineCode: baselineStructureCode,
        document: structure,
        name: structureName,
        description: structureDescription,
      },
      experiment: {
        record: experimentRecord,
        baselineBundle: baselineExperimentBundle,
        document: experiment,
        name: experimentName,
        description: experimentDescription,
      },
      selection: {
        ...selectionIds,
      },
      layout,
    }),
    [
      baselineExperimentBundle,
      baselineStructureCode,
      experiment,
      experimentDescription,
      experimentName,
      experimentRecord,
      selectionIds,
      structure,
      structureDescription,
      structureName,
      structureRecord,
    ],
  )

  const structureManageable = Boolean(
    structureRecord && user && (structureRecord.user_id === user.id || user.roles.includes('admin')),
  )
  const experimentManageable = Boolean(
    experimentRecord && user && (experimentRecord.user_id === user.id || user.roles.includes('admin')),
  )

  return {
    structure,
    experiment,
    structureRecord,
    experimentRecord,
    structureId,
    experimentId,
    structureName,
    structureDescription,
    experimentName,
    experimentDescription,
    structureDirty,
    experimentDirty,
    pairDirty: structureDirty || experimentDirty,
    pairClean,
    structureClean,
    experimentClean,
    structureStatus: status(structure, structureRecord, structureDirty),
    experimentStatus: status(experiment, experimentRecord, experimentDirty),
    structureManageable,
    experimentManageable,
    saving,
    selection,
    selectionIds,
    selectionRestoring: Boolean(pendingSelection && selectionRestoreStatus === 'restoring'),
    measurementActions,
    structureDocument,
    experimentDocument,
    simulation,
    applyStructure,
    applyExperiment,
    loadStructure,
    loadExperiment,
    loadResearch,
    restoreSelection,
    newStructure,
    newExperiment,
    newResearch,
    saveStructure,
    saveExperiment,
    restoreDraft,
    restoreStaleDraft,
    draft,
  }
}

export type CaeWorkbenchState = ReturnType<typeof useCaeWorkbenchState>
