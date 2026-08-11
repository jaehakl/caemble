import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { dbTables, getListRequest } from '@/api'
import {
  loadWorkbenchDraft,
  saveWorkbenchDraft,
  workbenchDraftUserKey,
} from '@/features/cae-workbench/storage/draftStorage'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { SavedExperiment, SavedStructure, WorkbenchDraft, WorkbenchTabId } from '@/features/cae-workbench/types'
import type { PendingConfirmation, WorkbenchDialog } from './caePageTypes'

export const caeWorkbenchTabs: readonly WorkbenchTabId[] = ['structure', 'experiment', 'recorded-data']

function positiveId(value: string | null) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function validTabs(value: readonly WorkbenchTabId[]) {
  const valid = value.filter((tab, index) => caeWorkbenchTabs.includes(tab) && value.indexOf(tab) === index)
  return valid
}

function emptyDraft(userKey: string): WorkbenchDraft {
  return {
    version: 1,
    savedAt: Date.now(),
    userKey,
    structure: {
      record: null,
      baselineCode: null,
      document: null,
      name: 'Untitled Structure',
      description: '',
    },
    experiment: {
      record: null,
      baselineBundle: null,
      document: null,
      name: 'Untitled Experiment',
      description: '',
    },
    selection: { sampleId: null, setupId: null, measurementId: null },
    layout: {
      openTabs: caeWorkbenchTabs,
      activeTab: 'structure',
      experimentFile: 'experiment.tsx',
      splitPercent: 50,
    },
  }
}

function sameExperimentBundle(left: SavedExperiment['source_bundle'], right: SavedExperiment['source_bundle'] | null) {
  if (!right || left.formatVersion !== right.formatVersion) return false
  const paths = [...new Set([...Object.keys(left.files), ...Object.keys(right.files)])].sort()
  return paths.every((path) => left.files[path] === right.files[path])
}

async function databaseDraftDiffers(draft: WorkbenchDraft) {
  const [structure, experiment] = await Promise.all([
    draft.structure.record?.id
      ? dbTables.Structure.listRows(getListRequest('visible', [draft.structure.record.id])).then(
          (response) => response.items[0] ?? null,
        )
      : null,
    draft.experiment.record?.id
      ? dbTables.Experiment.listRows(getListRequest('visible', [draft.experiment.record.id])).then(
          (response) => response.items[0] ?? null,
        )
      : null,
  ])
  return {
    differs:
      Boolean(draft.structure.record && (!structure || structure.code !== draft.structure.baselineCode)) ||
      Boolean(
        draft.experiment.record &&
        (!experiment || !sameExperimentBundle(experiment.source_bundle, draft.experiment.baselineBundle)),
      ),
    structure: structure?.id ? (structure as SavedStructure) : null,
    experiment: experiment?.id ? (experiment as SavedExperiment) : null,
  }
}

async function restoreDraftAgainstDatabase(draft: WorkbenchDraft, workbench: CaeWorkbenchState) {
  const current = await databaseDraftDiffers(draft)
  if (!current.differs) {
    workbench.restoreDraft(draft)
    return
  }
  if (window.confirm('저장된 DB 기준이 마지막 작업 이후 바뀌었습니다. 로컬 draft를 복원할까요?')) {
    workbench.restoreStaleDraft(draft, current)
    return
  }
  if (current.structure) workbench.applyStructure(current.structure)
  else if (draft.structure.document?.kind === 'structure') {
    workbench.newStructure(draft.structure.document.source, draft.structure.name, draft.structure.description)
  }
  if (current.experiment) workbench.applyExperiment(current.experiment)
  else if (draft.experiment.document?.kind === 'experiment') {
    workbench.newExperiment(draft.experiment.document.sourceBundle, draft.experiment.name, draft.experiment.description)
  }
}

export function useCaePageSession(
  authLoading: boolean,
  userId: string | null | undefined,
  workbench: CaeWorkbenchState,
  measurementScope: 'mine' | 'visible' = 'mine',
) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [dialog, setDialog] = useState<WorkbenchDialog>(null)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const [openTabs, setOpenTabs] = useState<readonly WorkbenchTabId[]>(caeWorkbenchTabs)
  const [activeTab, setActiveTab] = useState<WorkbenchTabId>('structure')
  const [activeExperimentFile, setActiveExperimentFile] = useState<string | null>('experiment.tsx')
  const [viewerPercent, setViewerPercent] = useState(50)
  const [mobileViewerOpen, setMobileViewerOpen] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [persistenceAvailable, setPersistenceAvailable] = useState(true)
  const [readyUserKey, setReadyUserKey] = useState<string | null>(null)
  const initializingUserKeyRef = useRef<string | null>(null)
  const lastSyncedSearchRef = useRef<string | null>(null)
  const externalNavigationRef = useRef(false)
  const externalNavigationSequenceRef = useRef(0)
  const measurementPreflightPendingRef = useRef(false)
  const searchParamsRef = useRef(searchParams)
  const workbenchRef = useRef(workbench)
  const userKey = workbenchDraftUserKey(userId)
  const searchKey = searchParams.toString()
  const selectionIds = workbench.selectionIds ?? {
    sampleId: workbench.selection.sample?.id ?? null,
    setupId: workbench.selection.setup?.id ?? null,
    measurementId: workbench.selection.measurement?.id ?? null,
  }
  searchParamsRef.current = searchParams
  workbenchRef.current = workbench

  const runSafely = useCallback((run: () => unknown | Promise<unknown>) => {
    void Promise.resolve()
      .then(run)
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  const openTab = useCallback((tab: WorkbenchTabId) => {
    setOpenTabs((current) => (current.includes(tab) ? current : [...current, tab]))
    setActiveTab(tab)
  }, [])

  const guardReplacement = useCallback(
    (target: 'experiment' | 'pair' | 'structure', run: () => unknown | Promise<unknown>) => {
      if (workbench.measurementActions.busy || Boolean(workbench.saving)) {
        toast.error(workbench.saving ? '저장이 끝난 뒤 source를 바꾸세요.' : 'CAE 작업이 끝난 뒤 source를 바꾸세요.')
        return
      }
      const dirty =
        target === 'pair'
          ? workbench.pairDirty
          : target === 'structure'
            ? workbench.structureDirty
            : workbench.experimentDirty
      if (!dirty) {
        runSafely(run)
        return
      }
      setConfirmation({
        title: '저장하지 않은 편집을 바꿀까요?',
        description: `${target === 'pair' ? 'Structure 또는 Experiment' : target === 'structure' ? 'Structure' : 'Experiment'}의 로컬 편집 내용이 새 선택으로 대체됩니다. IndexedDB draft에는 마지막 상태가 남지만 현재 작업에서는 되돌릴 수 없습니다.`,
        confirmLabel: '편집 내용 바꾸기',
        run,
      })
    },
    [
      runSafely,
      workbench.experimentDirty,
      workbench.measurementActions.busy,
      workbench.pairDirty,
      workbench.saving,
      workbench.structureDirty,
    ],
  )

  useEffect(() => {
    if (authLoading || initializingUserKeyRef.current === userKey) return
    const initialSearchParams = searchParamsRef.current
    const initialSearchKey = initialSearchParams.toString()
    const currentWorkbench = workbenchRef.current
    initializingUserKeyRef.current = userKey
    setInitialized(false)
    setPersistenceAvailable(true)
    setReadyUserKey(null)
    externalNavigationRef.current = true
    lastSyncedSearchRef.current = initialSearchKey
    setOpenTabs(caeWorkbenchTabs)
    setActiveTab('structure')
    setActiveExperimentFile('experiment.tsx')
    setViewerPercent(50)
    currentWorkbench.restoreDraft(emptyDraft(userKey))

    let cancelled = false
    void (async () => {
      let draft: WorkbenchDraft | null = null
      try {
        try {
          draft = await loadWorkbenchDraft(userKey)
        } catch (cause: unknown) {
          if (cancelled) return
          setPersistenceAvailable(false)
          toast.error(cause instanceof Error ? cause.message : 'CAE draft 저장소를 읽지 못했습니다.')
        }
        if (cancelled) return
        const urlStructureId = positiveId(initialSearchParams.get('structure'))
        const urlExperimentId = positiveId(initialSearchParams.get('experiment'))
        const urlMeasurementId = positiveId(initialSearchParams.get('measurement'))
        const urlSampleId = positiveId(initialSearchParams.get('sample'))
        const urlSetupId = positiveId(initialSearchParams.get('setup'))
        const hasUrlSelection = urlStructureId !== null || urlExperimentId !== null

        if (draft) {
          setOpenTabs(validTabs(draft.layout.openTabs))
          if (draft.layout.activeTab && draft.layout.openTabs.includes(draft.layout.activeTab)) {
            setActiveTab(draft.layout.activeTab)
          }
          setActiveExperimentFile(draft.layout.experimentFile)
          setViewerPercent(Math.min(75, Math.max(25, draft.layout.splitPercent)))
        }

        if (hasUrlSelection) {
          const draftStructureId = draft?.structure.record?.id ?? null
          const draftExperimentId = draft?.experiment.record?.id ?? null
          const urlDiffers =
            Boolean(urlStructureId && urlStructureId !== draftStructureId) ||
            Boolean(urlExperimentId && urlExperimentId !== draftExperimentId)
          if (
            draft &&
            urlDiffers &&
            !window.confirm('URL의 CAE 선택과 마지막 로컬 작업이 다릅니다. 확인을 누르면 URL 선택을 엽니다.')
          ) {
            currentWorkbench.restoreDraft(draft)
          } else {
            const structureId = urlStructureId ?? draftStructureId
            const experimentId = urlExperimentId ?? draftExperimentId
            const usesDraftPair =
              Boolean(draft) && structureId === draftStructureId && experimentId === draftExperimentId
            if (draft && usesDraftPair) {
              await restoreDraftAgainstDatabase(draft, currentWorkbench)
              if (urlMeasurementId || urlSampleId || urlSetupId) {
                currentWorkbench.restoreSelection(
                  {
                    sampleId: urlSampleId,
                    setupId: urlSetupId,
                    measurementId: urlMeasurementId,
                  },
                  { structureId, experimentId },
                )
              }
            } else if (structureId && experimentId) {
              await currentWorkbench.loadResearch(structureId, experimentId, urlMeasurementId)
              if (!urlMeasurementId && (urlSampleId || urlSetupId)) {
                currentWorkbench.restoreSelection(
                  { sampleId: urlSampleId, setupId: urlSetupId, measurementId: null },
                  { structureId, experimentId },
                )
              }
            } else {
              if (structureId) await currentWorkbench.loadStructure(structureId)
              if (experimentId) await currentWorkbench.loadExperiment(experimentId)
            }
          }
        } else if (draft) {
          await restoreDraftAgainstDatabase(draft, currentWorkbench)
        }
      } catch (cause: unknown) {
        if (draft) currentWorkbench.restoreDraft(draft)
        toast.error(cause instanceof Error ? cause.message : 'CAE 작업을 복원하지 못했습니다.')
      }
      if (cancelled) return
      externalNavigationRef.current = false
      setReadyUserKey(userKey)
      setInitialized(true)
    })()

    return () => {
      cancelled = true
      if (initializingUserKeyRef.current === userKey) initializingUserKeyRef.current = null
    }
  }, [authLoading, userKey])

  const syncSelectionToUrl = useCallback(() => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        const values = {
          structure: workbench.structureId,
          experiment: workbench.experimentId,
          sample: selectionIds.sampleId,
          setup: selectionIds.setupId,
          measurement: selectionIds.measurementId,
        }
        Object.entries(values).forEach(([key, value]) => {
          if (value) next.set(key, String(value))
          else next.delete(key)
        })
        const nextKey = next.toString()
        lastSyncedSearchRef.current = nextKey
        return nextKey === current.toString() ? current : next
      },
      { replace: true },
    )
  }, [
    selectionIds.measurementId,
    selectionIds.sampleId,
    selectionIds.setupId,
    setSearchParams,
    workbench.experimentId,
    workbench.structureId,
  ])

  useEffect(() => {
    if (readyUserKey !== userKey || searchKey === lastSyncedSearchRef.current) return
    const requested = new URLSearchParams(searchParams)
    const currentWorkbench = workbenchRef.current
    const structureId = positiveId(requested.get('structure'))
    const experimentId = positiveId(requested.get('experiment'))
    const measurementId = positiveId(requested.get('measurement'))
    const sampleId = positiveId(requested.get('sample'))
    const setupId = positiveId(requested.get('setup'))
    const pairChanges = structureId !== currentWorkbench.structureId || experimentId !== currentWorkbench.experimentId
    const navigationSequence = ++externalNavigationSequenceRef.current
    lastSyncedSearchRef.current = searchKey
    externalNavigationRef.current = true

    if (currentWorkbench.measurementActions.busy || Boolean(currentWorkbench.saving)) {
      externalNavigationRef.current = false
      toast.error(
        currentWorkbench.saving
          ? '저장이 끝난 뒤 다른 Research를 여세요.'
          : 'CAE 작업이 끝난 뒤 다른 Research를 여세요.',
      )
      syncSelectionToUrl()
      return
    }
    if (
      pairChanges &&
      currentWorkbench.pairDirty &&
      !window.confirm('저장하지 않은 편집을 바꾸고 URL의 CAE 선택을 열까요?')
    ) {
      externalNavigationRef.current = false
      syncSelectionToUrl()
      return
    }

    void (async () => {
      try {
        if (structureId && experimentId) {
          if (pairChanges) {
            await currentWorkbench.loadResearch(structureId, experimentId, measurementId)
            if (navigationSequence !== externalNavigationSequenceRef.current) return
          }
          if (!pairChanges || !measurementId) {
            currentWorkbench.selection.clearAll()
            if (sampleId || setupId || measurementId) {
              currentWorkbench.restoreSelection({ sampleId, setupId, measurementId }, { structureId, experimentId })
            }
          }
        } else if (structureId || experimentId) {
          if (structureId) await currentWorkbench.loadStructure(structureId)
          if (navigationSequence !== externalNavigationSequenceRef.current) return
          if (experimentId) await currentWorkbench.loadExperiment(experimentId)
          if (navigationSequence !== externalNavigationSequenceRef.current) return
        } else {
          currentWorkbench.restoreDraft(emptyDraft(userKey))
        }
      } catch (cause: unknown) {
        if (navigationSequence !== externalNavigationSequenceRef.current) return
        toast.error(cause instanceof Error ? cause.message : 'URL의 CAE 작업을 열지 못했습니다.')
        syncSelectionToUrl()
      } finally {
        if (navigationSequence === externalNavigationSequenceRef.current) {
          externalNavigationRef.current = false
        }
      }
    })()
  }, [readyUserKey, searchKey, searchParams, syncSelectionToUrl, userKey])

  useEffect(() => {
    if (readyUserKey !== userKey || externalNavigationRef.current || workbench.selectionRestoring) {
      return
    }
    syncSelectionToUrl()
  }, [readyUserKey, syncSelectionToUrl, userKey, workbench.selectionRestoring])

  useEffect(() => {
    if (readyUserKey !== userKey || !persistenceAvailable) return
    const timeout = window.setTimeout(() => {
      void saveWorkbenchDraft(
        workbench.draft(userKey, {
          openTabs,
          activeTab: openTabs.includes(activeTab) ? activeTab : null,
          experimentFile: activeExperimentFile,
          splitPercent: viewerPercent,
        }),
      ).catch(() => undefined)
    }, 500)
    return () => window.clearTimeout(timeout)
  }, [activeExperimentFile, activeTab, openTabs, persistenceAvailable, readyUserKey, userKey, viewerPercent, workbench])

  useEffect(() => {
    if (!workbench.pairDirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [workbench.pairDirty])

  const requestPerformMeasurement = useCallback(async () => {
    if (measurementPreflightPendingRef.current) throw new Error('Measurement 확인이 진행 중입니다.')
    const currentWorkbench = workbenchRef.current
    const sample = currentWorkbench.selection.sample
    const setup = currentWorkbench.selection.setup
    if (!sample || !setup) throw new Error('Sample과 Setup을 먼저 선택하세요.')
    const expected = { sampleId: sample.id, setupId: setup.id }
    measurementPreflightPendingRef.current = true
    try {
      const existing = await dbTables.Measurement.listRows({
        ...getListRequest(measurementScope),
        limit: 1,
        filter: { sample_id: [sample.id, sample.id], setup_id: [setup.id, setup.id] },
      })
      const latestWorkbench = workbenchRef.current
      if (
        latestWorkbench.selection.sample?.id !== expected.sampleId ||
        latestWorkbench.selection.setup?.id !== expected.setupId
      ) {
        throw new Error('Measurement 확인 중 Sample 또는 Setup 선택이 바뀌었습니다. 다시 실행하세요.')
      }
      if (existing.total > 0) {
        setConfirmation({
          title: '기존 Measurement를 덮어쓸까요?',
          description: `Sample #${sample.id} + Setup #${setup.id}의 기존 Measurement와 RecordedData가 새 실행 결과로 교체됩니다.`,
          confirmLabel: '실행하고 덮어쓰기',
          run: () => workbenchRef.current.measurementActions.performMeasurement(true, expected),
        })
        return
      }
      latestWorkbench.measurementActions.performMeasurement(false, expected)
    } finally {
      measurementPreflightPendingRef.current = false
    }
  }, [measurementScope])

  return {
    activeExperimentFile,
    activeTab,
    confirmation,
    dialog,
    guardReplacement,
    initialized,
    mobileViewerOpen,
    openTab,
    openTabs,
    requestPerformMeasurement,
    runSafely,
    setActiveExperimentFile,
    setActiveTab,
    setConfirmation,
    setDialog,
    setMobileViewerOpen,
    setOpenTabs,
    setViewerPercent,
    viewerPercent,
  }
}
