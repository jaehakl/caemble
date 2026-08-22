import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { dbTables, getListRequest } from '@/api'
import { loadWorkbenchDraft, saveWorkbenchDraft } from '@/features/cae-workbench/storage/draftStorage'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import {
  defaultWorkbenchLayoutState,
  type WorkbenchDraft,
  type WorkbenchLayoutState,
} from '@/features/cae-workbench/types'
import { createCadSourceDocument } from '@/lib/cad'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import type { PendingConfirmation, WorkbenchDialog } from './caePageTypes'

function positiveId(value: string | null) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

async function measurementExperimentId(measurementId: number) {
  const measurement = (await dbTables.Measurement.listRows(getListRequest('visible', [measurementId]))).items[0]
  if (!measurement?.id) throw new Error(`Measurement #${measurementId}을 찾을 수 없습니다.`)
  return measurement.experiment_id
}

function starterDraft(): WorkbenchDraft {
  return {
    version: 15,
    savedAt: Date.now(),
    experiment: {
      record: null,
      baselineBundle: starterExperimentSourceBundle,
      document: createCadSourceDocument('experiment', starterExperimentSourceBundle),
      name: 'Starter Experiment',
      description: '브라우저에서 바로 편집하고 렌더링할 수 있는 로컬 Starter입니다.',
    },
    candidate: { vars: null, materialParameters: null },
    selection: { measurementId: null },
    layout: defaultWorkbenchLayoutState,
  }
}

export function useCaePageSession(workbench: CaeWorkbenchState) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [dialog, setDialog] = useState<WorkbenchDialog>(null)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const [layout, setLayout] = useState<WorkbenchLayoutState>(defaultWorkbenchLayoutState)
  const [initialized, setInitialized] = useState(false)
  const [persistenceAvailable, setPersistenceAvailable] = useState(true)
  const initializingRef = useRef(false)
  const lastSyncedSearchRef = useRef<string | null>(null)
  const externalNavigationRef = useRef(false)
  const externalNavigationSequenceRef = useRef(0)
  const searchParamsRef = useRef(searchParams)
  const workbenchRef = useRef(workbench)
  const searchKey = searchParams.toString()
  searchParamsRef.current = searchParams
  workbenchRef.current = workbench

  const runSafely = useCallback((run: () => unknown | Promise<unknown>) => {
    void Promise.resolve()
      .then(run)
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
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
      if (!workbench.hasUnsavedExperimentWork) {
        runSafely(run)
        return
      }
      setConfirmation({
        title: '저장하지 않은 편집을 바꿀까요?',
        description: '저장하지 않은 Experiment 편집 내용이 새 선택으로 대체됩니다.',
        confirmLabel: '편집 내용 바꾸기',
        run,
      })
    },
    [
      runSafely,
      workbench.hasUnsavedExperimentWork,
      workbench.measurementActions.busy,
      workbench.measurementActions.pendingRecordMeasurementId,
      workbench.saving,
    ],
  )

  useEffect(() => {
    if (initializingRef.current) return
    const initialSearchParams = searchParamsRef.current
    const initialSearchKey = initialSearchParams.toString()
    const currentWorkbench = workbenchRef.current
    initializingRef.current = true
    setInitialized(false)
    setPersistenceAvailable(true)
    externalNavigationRef.current = true
    lastSyncedSearchRef.current = initialSearchKey
    setLayout(defaultWorkbenchLayoutState)
    currentWorkbench.restoreDraft(starterDraft())

    let cancelled = false
    void (async () => {
      let draft: WorkbenchDraft | null = null
      try {
        try {
          draft = await loadWorkbenchDraft()
        } catch (cause: unknown) {
          if (cancelled) return
          setPersistenceAvailable(false)
          toast.error(cause instanceof Error ? cause.message : 'CAE draft 저장소를 읽지 못했습니다.')
        }
        if (cancelled) return
        let urlExperimentId = positiveId(initialSearchParams.get('experiment'))
        const urlMeasurementId = positiveId(initialSearchParams.get('measurement'))
        if (!urlExperimentId && urlMeasurementId) urlExperimentId = await measurementExperimentId(urlMeasurementId)

        if (draft) setLayout(draft.layout)

        if (urlExperimentId) {
          const draftExperimentId = draft?.experiment.record?.id ?? null
          if (
            draft &&
            urlExperimentId !== draftExperimentId &&
            !window.confirm('URL의 Experiment와 마지막 로컬 작업이 다릅니다. 확인을 누르면 URL 선택을 엽니다.')
          ) {
            currentWorkbench.restoreDraft(draft)
          } else if (draft && urlExperimentId === draftExperimentId) {
            currentWorkbench.restoreDraft(draft)
            if (urlMeasurementId) currentWorkbench.restoreSelection(urlMeasurementId)
            setLayout((current) => ({
              ...current,
              activeSection: urlMeasurementId ? 'measurement' : 'experiment',
            }))
          } else {
            await currentWorkbench.loadExperiment(urlExperimentId, urlMeasurementId)
            setLayout((current) => ({
              ...current,
              activeSection: urlMeasurementId ? 'measurement' : 'experiment',
            }))
          }
        } else if (draft) {
          currentWorkbench.restoreDraft(draft)
        }
      } catch (cause: unknown) {
        if (draft) currentWorkbench.restoreDraft(draft)
        toast.error(cause instanceof Error ? cause.message : 'CAE 작업을 복원하지 못했습니다.')
      }
      if (cancelled) return
      externalNavigationRef.current = false
      setInitialized(true)
    })()

    return () => {
      cancelled = true
      initializingRef.current = false
    }
  }, [])

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
    if (!initialized || searchKey === lastSyncedSearchRef.current) return
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
          currentWorkbench.hasUnsavedExperimentWork &&
          !window.confirm('저장하지 않은 Experiment 편집을 바꾸고 URL의 Experiment를 열까요?')
        ) {
          syncSelectionToUrl()
          return
        }
        if (experimentId) {
          if (experimentChanges) await currentWorkbench.loadExperiment(experimentId, measurementId)
          else if (measurementId) await currentWorkbench.selection.loadMeasurement(measurementId, experimentId)
          else currentWorkbench.selection.clearMeasurement()
          setLayout((current) => ({
            ...current,
            activeSection: measurementId ? 'measurement' : 'experiment',
          }))
        } else {
          const starter = starterDraft()
          currentWorkbench.restoreDraft(starter)
          setLayout(starter.layout)
        }
      } catch (cause: unknown) {
        if (navigationSequence !== externalNavigationSequenceRef.current) return
        toast.error(cause instanceof Error ? cause.message : 'URL의 CAE 작업을 열지 못했습니다.')
        syncSelectionToUrl()
      } finally {
        if (navigationSequence === externalNavigationSequenceRef.current) externalNavigationRef.current = false
      }
    })()
  }, [initialized, searchKey, searchParams, syncSelectionToUrl])

  useEffect(() => {
    if (!initialized || externalNavigationRef.current || workbench.selectionRestoring) return
    syncSelectionToUrl()
  }, [initialized, syncSelectionToUrl, workbench.selectionRestoring])

  useEffect(() => {
    if (!initialized || !persistenceAvailable) return
    const timeout = window.setTimeout(() => {
      void saveWorkbenchDraft(workbench.draft(layout)).catch((cause: unknown) => {
        setPersistenceAvailable(false)
        toast.error(cause instanceof Error ? cause.message : 'CAE draft를 sessionStorage에 저장하지 못했습니다.')
      })
    }, 500)
    return () => window.clearTimeout(timeout)
  }, [initialized, layout, persistenceAvailable, workbench])

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

  const setActiveExperimentFile = useCallback(
    (activeExperimentFile: string | null) => setLayout((current) => ({ ...current, activeExperimentFile })),
    [],
  )

  return {
    ...layout,
    confirmation,
    dialog,
    guardReplacement,
    initialized,
    layout,
    requestRunSelected,
    runSafely,
    setActiveExperimentFile,
    setConfirmation,
    setDialog,
    setLayout,
  }
}
