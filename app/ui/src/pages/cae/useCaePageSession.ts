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
import type { SavedExperiment, WorkbenchDraft, WorkbenchTabId } from '@/features/cae-workbench/types'
import { experimentSourceBundleHash } from '@/features/viewer/persistence/saveDefinition'
import type { PendingConfirmation, WorkbenchDialog } from './caePageTypes'

export const caeWorkbenchTabs: readonly WorkbenchTabId[] = ['experiment', 'geometry', 'recorded-data']

function positiveId(value: string | null) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

async function measurementExperimentId(measurementId: number) {
  const measurement = (await dbTables.Measurement.listRows(getListRequest('visible', [measurementId]))).items[0]
  if (!measurement?.id) throw new Error(`Measurement #${measurementId}을 찾을 수 없습니다.`)
  return measurement.experiment_id
}

function validTabs(value: readonly WorkbenchTabId[]) {
  return value.filter((tab, index) => caeWorkbenchTabs.includes(tab) && value.indexOf(tab) === index)
}

function emptyDraft(userKey: string): WorkbenchDraft {
  return {
    version: 4,
    savedAt: Date.now(),
    userKey,
    experiment: {
      record: null,
      baselineBundle: null,
      document: null,
      name: 'Untitled Experiment',
      description: '',
    },
    candidate: { vars: null, materialParameters: null },
    selection: { measurementId: null },
    geometry: { drafts: {}, stagedModules: [], selectedCoordinate: null, expandedPaths: [] },
    layout: {
      openTabs: caeWorkbenchTabs,
      activeTab: 'experiment',
      experimentFile: 'experiment.tsx',
      splitPercent: 50,
    },
  }
}

async function databaseDraftDiffers(draft: WorkbenchDraft) {
  const experiment = draft.experiment.record?.id
    ? await dbTables.Experiment.listRows(getListRequest('visible', [draft.experiment.record.id])).then(
        (response) => response.items[0] ?? null,
      )
    : null
  const sameBaseline =
    experiment && draft.experiment.baselineBundle
      ? await Promise.all([
          experimentSourceBundleHash(experiment.source_bundle),
          experimentSourceBundleHash(draft.experiment.baselineBundle),
        ]).then(([left, right]) => left === right)
      : false
  return {
    differs: Boolean(draft.experiment.record && (!experiment || !sameBaseline)),
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
    workbench.restoreStaleDraft(draft, current.experiment)
    return
  }
  if (current.experiment) workbench.applyExperiment(current.experiment)
  else if (draft.experiment.document) {
    workbench.newExperiment(draft.experiment.document.sourceBundle, draft.experiment.name, draft.experiment.description)
  }
}

export function useCaePageSession(
  authLoading: boolean,
  userId: string | null | undefined,
  workbench: CaeWorkbenchState,
) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [dialog, setDialog] = useState<WorkbenchDialog>(null)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const [openTabs, setOpenTabs] = useState<readonly WorkbenchTabId[]>(caeWorkbenchTabs)
  const [activeTab, setActiveTab] = useState<WorkbenchTabId>('experiment')
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
  const searchParamsRef = useRef(searchParams)
  const workbenchRef = useRef(workbench)
  const userKey = workbenchDraftUserKey(userId)
  const searchKey = searchParams.toString()
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
    (run: () => unknown | Promise<unknown>) => {
      if (workbench.measurementActions.pendingRecordMeasurementId) {
        toast.error('실행 결과 저장을 다시 시도한 뒤 Experiment 또는 Measurement를 바꾸세요.')
        return
      }
      if (workbench.measurementActions.busy || Boolean(workbench.saving)) {
        toast.error(workbench.saving ? '저장이 끝난 뒤 source를 바꾸세요.' : 'CAE 작업이 끝난 뒤 source를 바꾸세요.')
        return
      }
      if (!workbench.hasUnsavedWork) {
        runSafely(run)
        return
      }
      setConfirmation({
        title: '저장하지 않은 편집을 바꿀까요?',
        description:
          'Experiment와 Geometry의 로컬 편집 내용이 새 선택으로 대체됩니다. IndexedDB draft에는 마지막 상태가 남지만 현재 작업에서는 되돌릴 수 없습니다.',
        confirmLabel: '편집 내용 바꾸기',
        run,
      })
    },
    [
      runSafely,
      workbench.hasUnsavedWork,
      workbench.measurementActions.busy,
      workbench.measurementActions.pendingRecordMeasurementId,
      workbench.saving,
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
    setActiveTab('experiment')
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
        let urlExperimentId = positiveId(initialSearchParams.get('experiment'))
        const urlMeasurementId = positiveId(initialSearchParams.get('measurement'))
        if (!urlExperimentId && urlMeasurementId) {
          urlExperimentId = await measurementExperimentId(urlMeasurementId)
        }

        if (draft) {
          const restoredTabs = validTabs(draft.layout.openTabs)
          setOpenTabs(restoredTabs.length ? restoredTabs : caeWorkbenchTabs)
          if (draft.layout.activeTab && restoredTabs.includes(draft.layout.activeTab))
            setActiveTab(draft.layout.activeTab)
          setActiveExperimentFile(draft.layout.experimentFile)
          setViewerPercent(Math.min(75, Math.max(25, draft.layout.splitPercent)))
        }

        if (urlExperimentId) {
          const draftExperimentId = draft?.experiment.record?.id ?? null
          if (
            draft &&
            urlExperimentId !== draftExperimentId &&
            !window.confirm('URL의 Experiment와 마지막 로컬 작업이 다릅니다. 확인을 누르면 URL 선택을 엽니다.')
          ) {
            await restoreDraftAgainstDatabase(draft, currentWorkbench)
          } else if (draft && urlExperimentId === draftExperimentId) {
            await restoreDraftAgainstDatabase(draft, currentWorkbench)
            if (urlMeasurementId) currentWorkbench.restoreSelection(urlMeasurementId)
          } else {
            await currentWorkbench.loadExperiment(urlExperimentId, urlMeasurementId)
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
          experiment: workbench.experimentId,
          measurement: workbench.selectionIds.measurementId,
        }
        Object.entries(values).forEach(([key, value]) => {
          if (value) next.set(key, String(value))
          else next.delete(key)
        })
        ;['structure', 'sample', 'setup'].forEach((key) => next.delete(key))
        const nextKey = next.toString()
        lastSyncedSearchRef.current = nextKey
        return nextKey === current.toString() ? current : next
      },
      { replace: true },
    )
  }, [setSearchParams, workbench.experimentId, workbench.selectionIds.measurementId])

  useEffect(() => {
    if (readyUserKey !== userKey || searchKey === lastSyncedSearchRef.current) return
    const requested = new URLSearchParams(searchParams)
    const currentWorkbench = workbenchRef.current
    const requestedExperimentId = positiveId(requested.get('experiment'))
    const measurementId = positiveId(requested.get('measurement'))
    const navigationSequence = ++externalNavigationSequenceRef.current
    lastSyncedSearchRef.current = searchKey
    externalNavigationRef.current = true

    if (currentWorkbench.measurementActions.pendingRecordMeasurementId) {
      externalNavigationRef.current = false
      toast.error('실행 결과 저장을 다시 시도한 뒤 다른 Experiment 또는 Measurement를 여세요.')
      syncSelectionToUrl()
      return
    }
    if (currentWorkbench.measurementActions.busy || Boolean(currentWorkbench.saving)) {
      externalNavigationRef.current = false
      toast.error(
        currentWorkbench.saving
          ? '저장이 끝난 뒤 다른 Experiment를 여세요.'
          : 'CAE 작업이 끝난 뒤 다른 Experiment를 여세요.',
      )
      syncSelectionToUrl()
      return
    }
    void (async () => {
      try {
        const experimentId =
          requestedExperimentId ?? (measurementId ? await measurementExperimentId(measurementId) : null)
        const experimentChanges = experimentId !== currentWorkbench.experimentId
        if (
          experimentChanges &&
          currentWorkbench.hasUnsavedWork &&
          !window.confirm('저장하지 않은 Experiment/Geometry 편집을 바꾸고 URL의 Experiment를 열까요?')
        ) {
          syncSelectionToUrl()
          return
        }
        if (experimentId) {
          if (experimentChanges) await currentWorkbench.loadExperiment(experimentId, measurementId)
          else if (measurementId) await currentWorkbench.selection.loadMeasurement(measurementId, experimentId)
          else currentWorkbench.selection.clearMeasurement()
        } else {
          currentWorkbench.restoreDraft(emptyDraft(userKey))
        }
      } catch (cause: unknown) {
        if (navigationSequence !== externalNavigationSequenceRef.current) return
        toast.error(cause instanceof Error ? cause.message : 'URL의 CAE 작업을 열지 못했습니다.')
        syncSelectionToUrl()
      } finally {
        if (navigationSequence === externalNavigationSequenceRef.current) externalNavigationRef.current = false
      }
    })()
  }, [readyUserKey, searchKey, searchParams, syncSelectionToUrl, userKey])

  useEffect(() => {
    if (readyUserKey !== userKey || externalNavigationRef.current || workbench.selectionRestoring) return
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
      ).catch((cause: unknown) => {
        setPersistenceAvailable(false)
        toast.error(cause instanceof Error ? cause.message : 'CAE draft를 IndexedDB에 저장하지 못했습니다.')
      })
    }, 500)
    return () => window.clearTimeout(timeout)
  }, [activeExperimentFile, activeTab, openTabs, persistenceAvailable, readyUserKey, userKey, viewerPercent, workbench])

  useEffect(() => {
    if (!workbench.hasUnsavedWork && !workbench.measurementActions.pendingRecordMeasurementId) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [workbench.hasUnsavedWork, workbench.measurementActions.pendingRecordMeasurementId])

  const requestRunSelected = useCallback(() => {
    const runId = workbenchRef.current.measurementActions.runSelected()
    if (!runId && !workbenchRef.current.measurementActions.error) {
      throw new Error('선택한 prepared Measurement를 실행하지 못했습니다.')
    }
  }, [])

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
    requestRunSelected,
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
