import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useBlocker, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import type { PendingConfirmation } from '@/features/cae-workbench/caePageTypes'
import { availableExperimentsQueryOptions, experimentDetailQueryOptions } from '@/features/experiment/queryOptions'
import { measurementDetailQueryOptions } from '@/features/measurement/queryOptions'
import { loadWorkbenchDraft, saveWorkbenchDraft } from '@/features/cae-workbench/storage/draftStorage'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { defaultWorkbenchLayoutState, type WorkbenchDraft } from '@/features/cae-workbench/types'
import { createCadSourceDocument } from '@/lib/cad/source'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import { useWorkbenchShell } from '@/workbench/state/workbenchShellStore'
import {
  draftNeedsPredictionLandingPreservation,
  predictionLandingExperiment,
} from '@/features/cae-workbench/predictionLandingPolicy'
import { readWorkbenchUrlSelection, replacementDisposition, writeWorkbenchUrlSelection } from './sessionPolicy'

async function measurementExperimentId(queryClient: QueryClient, queryScope: PrivateQueryScope, measurementId: number) {
  const measurement = await queryClient.fetchQuery(measurementDetailQueryOptions(queryScope, measurementId))
  return measurement.experiment_id
}

function starterDraft(): WorkbenchDraft {
  return {
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

export function useCaePageSession(
  workbench: CaeWorkbenchState,
  {
    authPending,
    queryScope,
    hasUnsavedCalculationWork = false,
    allowAdminSection = null,
  }: {
    authPending: boolean
    queryScope: PrivateQueryScope
    hasUnsavedCalculationWork?: boolean
    allowAdminSection?: boolean | null
  },
) {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const dialog = useWorkbenchShell((state) => state.dialog)
  const layout = useWorkbenchShell((state) => state.layout)
  const setDialog = useWorkbenchShell((state) => state.setDialog)
  const setLayout = useWorkbenchShell((state) => state.setLayout)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [persistenceAvailable, setPersistenceAvailable] = useState(true)
  const [calculationId, setCalculationId] = useState<number | null>(null)
  const [calculationContextPending, setCalculationContextPending] = useState(false)
  const createDraft = workbench.draft
  const navigationBlocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasUnsavedCalculationWork &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.hash !== nextLocation.hash),
  )
  const initializingRef = useRef(false)
  const lastSyncedSearchRef = useRef<string | null>(null)
  const externalNavigationRef = useRef(false)
  const externalNavigationSequenceRef = useRef(0)
  const searchParamsRef = useRef(searchParams)
  const workbenchRef = useRef(workbench)
  const searchKey = searchParams.toString()
  searchParamsRef.current = searchParams
  workbenchRef.current = workbench

  const persistenceSnapshotRef = useRef({
    createDraft,
    initialized,
    layout,
    persistenceAvailable,
    workbench,
  })
  persistenceSnapshotRef.current = {
    createDraft,
    initialized,
    layout,
    persistenceAvailable,
    workbench,
  }

  useEffect(() => {
    if (allowAdminSection !== false || layout.activeSection !== 'admin') return
    setLayout((current) => ({ ...current, activeSection: 'prediction' }))
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.set('section', 'prediction')
        lastSyncedSearchRef.current = next.toString()
        return next
      },
      { replace: true },
    )
  }, [allowAdminSection, layout.activeSection, setLayout, setSearchParams])

  useEffect(() => {
    if (navigationBlocker.state !== 'blocked') return
    if (window.confirm('저장하지 않은 Calculation 편집을 버리고 페이지를 나갈까요?')) {
      navigationBlocker.proceed()
    } else {
      navigationBlocker.reset()
    }
  }, [navigationBlocker])

  const runSafely = useCallback((run: () => unknown | Promise<unknown>) => {
    void Promise.resolve()
      .then(run)
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  useEffect(
    () => () => {
      const snapshot = persistenceSnapshotRef.current
      snapshot.workbench.measurementActions.cancel()
      snapshot.workbench.calculationDataActions.cancel()
      if (snapshot.initialized && snapshot.persistenceAvailable) {
        void saveWorkbenchDraft(queryScope, snapshot.createDraft(snapshot.layout)).catch(() => undefined)
      }
    },
    [queryScope],
  )

  const guardReplacement = useCallback(
    (run: () => unknown | Promise<unknown>, cancel?: () => void) => {
      const disposition = replacementDisposition({
        calculationDirty: hasUnsavedCalculationWork,
        calculationRunning: workbench.calculationDataActions.busy,
        experimentDirty: workbench.hasUnsavedExperimentWork,
        measurementRunning: workbench.measurementActions.busy,
        pendingRecord: Boolean(workbench.measurementActions.pendingRecordMeasurementId),
        saving: Boolean(workbench.saving),
      })
      if (disposition === 'blocked-by-pending-record') {
        toast.error('실행 결과 저장을 다시 시도한 뒤 Experiment 또는 Measurement를 바꾸세요.')
        cancel?.()
        return
      }
      if (disposition === 'blocked-by-save' || disposition === 'blocked-by-running-workflow') {
        toast.error(
          disposition === 'blocked-by-save'
            ? '저장이 끝난 뒤 source를 바꾸세요.'
            : 'CAE 작업이 끝난 뒤 source를 바꾸세요.',
        )
        cancel?.()
        return
      }
      if (disposition === 'run') {
        runSafely(run)
        return
      }
      setConfirmation({
        cancel,
        title: '저장하지 않은 편집을 바꿀까요?',
        description:
          disposition === 'confirm-calculation-replacement'
            ? '저장하지 않은 Calculation 편집 내용이 새 선택으로 대체됩니다.'
            : '저장하지 않은 Experiment 편집 내용이 새 선택으로 대체됩니다.',
        confirmLabel: '편집 내용 바꾸기',
        run,
      })
    },
    [
      runSafely,
      hasUnsavedCalculationWork,
      workbench.hasUnsavedExperimentWork,
      workbench.calculationDataActions.busy,
      workbench.measurementActions.busy,
      workbench.measurementActions.pendingRecordMeasurementId,
      workbench.saving,
    ],
  )

  useEffect(() => {
    if (authPending || initializingRef.current) return
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
        const initialQueryScope = queryScope
        try {
          draft = await loadWorkbenchDraft(initialQueryScope, () =>
            window.confirm(
              '업데이트 전에 저장된 로컬 작업은 계정 정보가 없습니다. 이 브라우저의 이전 작업이 맞다면 현재 세션으로 가져올까요?',
            ),
          )
        } catch (cause: unknown) {
          if (cancelled) return
          setPersistenceAvailable(false)
          toast.error(cause instanceof Error ? cause.message : 'CAE draft 저장소를 읽지 못했습니다.')
        }
        if (cancelled) return
        const urlSelection = readWorkbenchUrlSelection(initialSearchParams)
        let urlExperimentId = urlSelection.experimentId
        const urlMeasurementId = urlSelection.measurementId
        const urlCalculationId = urlSelection.calculationId
        const requestedSection = urlSelection.section
        if (!urlExperimentId && urlMeasurementId) {
          urlExperimentId = await measurementExperimentId(queryClient, initialQueryScope, urlMeasurementId)
          if (cancelled) return
        }
        const effectiveCalculationId = urlExperimentId ? urlCalculationId : null
        const initialSection =
          requestedSection ??
          (urlMeasurementId || effectiveCalculationId ? 'measurement' : urlExperimentId ? 'experiment' : 'prediction')
        setCalculationId(effectiveCalculationId)

        const draftNeedsPreservation = draftNeedsPredictionLandingPreservation(draft, starterExperimentSourceBundle)

        if (draft) setLayout({ ...draft.layout, activeSection: initialSection })

        if (urlExperimentId) {
          const draftExperimentId = draft?.experiment.record?.id ?? null
          if (
            draft &&
            draftNeedsPreservation &&
            urlExperimentId !== draftExperimentId &&
            !window.confirm('URL의 Experiment와 마지막 로컬 작업이 다릅니다. 확인을 누르면 URL 선택을 엽니다.')
          ) {
            currentWorkbench.restoreDraft(draft)
            setCalculationId(null)
          } else if (draft && urlExperimentId === draftExperimentId) {
            currentWorkbench.restoreDraft(draft)
            if (urlMeasurementId) currentWorkbench.restoreSelection(urlMeasurementId)
            setLayout((current) => ({
              ...current,
              activeSection: initialSection,
            }))
          } else {
            const row = await queryClient.fetchQuery(experimentDetailQueryOptions(initialQueryScope, urlExperimentId))
            if (cancelled) return
            await currentWorkbench.loadExperiment(row, urlMeasurementId)
            if (cancelled) return
            setLayout((current) => ({
              ...current,
              activeSection: initialSection,
            }))
          }
        } else {
          if (draftNeedsPreservation && draft) {
            currentWorkbench.restoreDraft(draft)
          } else {
            const available = await queryClient.ensureQueryData(availableExperimentsQueryOptions(initialQueryScope))
            if (cancelled) return
            const draftExperimentId = draft?.experiment.record?.id ?? null
            const selected = predictionLandingExperiment(available, draftExperimentId)
            if (selected) {
              await currentWorkbench.loadExperiment(selected)
              if (cancelled) return
            } else if (draft) currentWorkbench.restoreDraft(draft)
          }
          setLayout((current) => ({ ...current, activeSection: initialSection }))
        }
      } catch (cause: unknown) {
        if (cancelled) return
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
  }, [authPending, queryClient, queryScope, setLayout])

  const syncSelectionToUrl = useCallback(() => {
    setSearchParams(
      (current) => {
        const next = writeWorkbenchUrlSelection(current, {
          experimentId: workbench.experimentId,
          measurementId: workbench.selectionIds.measurementId,
          calculationId,
          section: layout.activeSection,
        })
        const nextKey = next.toString()
        lastSyncedSearchRef.current = nextKey
        return nextKey === current.toString() ? current : next
      },
      { replace: true },
    )
  }, [
    calculationId,
    layout.activeSection,
    setSearchParams,
    workbench.experimentId,
    workbench.selectionIds.measurementId,
  ])

  useEffect(() => {
    if (!initialized || searchKey === lastSyncedSearchRef.current) return
    const requested = new URLSearchParams(searchParams)
    const currentWorkbench = workbenchRef.current
    const requestedSelection = readWorkbenchUrlSelection(requested)
    const requestedExperimentId = requestedSelection.experimentId
    const measurementId = requestedSelection.measurementId
    const requestedCalculationId = requestedSelection.calculationId
    const requestedSection = requestedSelection.section
    const navigationSequence = ++externalNavigationSequenceRef.current
    lastSyncedSearchRef.current = searchKey
    externalNavigationRef.current = true

    const blockingDisposition = replacementDisposition({
      calculationDirty: false,
      calculationRunning: currentWorkbench.calculationDataActions.busy,
      experimentDirty: false,
      measurementRunning: currentWorkbench.measurementActions.busy,
      pendingRecord: Boolean(currentWorkbench.measurementActions.pendingRecordMeasurementId),
      saving: Boolean(currentWorkbench.saving),
    })
    if (blockingDisposition === 'blocked-by-pending-record') {
      externalNavigationRef.current = false
      toast.error('실행 결과 저장을 다시 시도한 뒤 다른 Experiment 또는 Measurement를 여세요.')
      syncSelectionToUrl()
      return
    }
    if (blockingDisposition === 'blocked-by-save' || blockingDisposition === 'blocked-by-running-workflow') {
      externalNavigationRef.current = false
      toast.error(
        blockingDisposition === 'blocked-by-save'
          ? '저장이 끝난 뒤 다른 Experiment를 여세요.'
          : 'CAE 작업이 끝난 뒤 다른 Experiment를 여세요.',
      )
      syncSelectionToUrl()
      return
    }
    const contextMayChange =
      requestedCalculationId !== calculationId ||
      measurementId !== (currentWorkbench.selection.measurement?.id ?? null) ||
      (requestedExperimentId !== null
        ? requestedExperimentId !== currentWorkbench.experimentId
        : measurementId === null && requestedCalculationId === null && currentWorkbench.experimentId !== null)
    if (contextMayChange) setCalculationContextPending(true)
    void (async () => {
      try {
        const experimentId =
          requestedExperimentId ??
          (measurementId
            ? await measurementExperimentId(queryClient, queryScope, measurementId)
            : requestedCalculationId
              ? currentWorkbench.experimentId
              : null)
        if (navigationSequence !== externalNavigationSequenceRef.current) return
        const experimentChanges = experimentId !== currentWorkbench.experimentId
        const calculationChanges = requestedCalculationId !== calculationId
        if (
          (experimentChanges || calculationChanges) &&
          (currentWorkbench.hasUnsavedExperimentWork || hasUnsavedCalculationWork) &&
          !window.confirm(
            hasUnsavedCalculationWork
              ? '저장하지 않은 Calculation 편집을 바꾸고 URL의 선택을 열까요?'
              : '저장하지 않은 Experiment 편집을 바꾸고 URL의 Experiment를 열까요?',
          )
        ) {
          syncSelectionToUrl()
          return
        }
        if (experimentId) {
          if (experimentChanges) await currentWorkbench.loadExperiment(experimentId, measurementId)
          else if (measurementId) await currentWorkbench.selection.loadMeasurement(measurementId, experimentId)
          else currentWorkbench.selection.clearMeasurement()
          if (navigationSequence !== externalNavigationSequenceRef.current) return
          setCalculationId(requestedCalculationId)
          setLayout((current) => ({
            ...current,
            activeSection: requestedSection ?? (measurementId || requestedCalculationId ? 'measurement' : 'experiment'),
          }))
        } else {
          const starter = starterDraft()
          currentWorkbench.restoreDraft(starter)
          setCalculationId(null)
          setLayout({ ...starter.layout, activeSection: requestedSection ?? 'prediction' })
        }
      } catch (cause: unknown) {
        if (navigationSequence !== externalNavigationSequenceRef.current) return
        toast.error(cause instanceof Error ? cause.message : 'URL의 CAE 작업을 열지 못했습니다.')
        syncSelectionToUrl()
      } finally {
        if (navigationSequence === externalNavigationSequenceRef.current) {
          externalNavigationRef.current = false
          setCalculationContextPending(false)
        }
      }
    })()
  }, [
    calculationId,
    hasUnsavedCalculationWork,
    initialized,
    queryClient,
    queryScope,
    searchKey,
    searchParams,
    setLayout,
    syncSelectionToUrl,
  ])

  useEffect(() => {
    if (!initialized || externalNavigationRef.current || workbench.selectionRestoring) return
    syncSelectionToUrl()
  }, [initialized, syncSelectionToUrl, workbench.selectionRestoring])

  useEffect(() => {
    if (!initialized || !persistenceAvailable) return
    const timeout = window.setTimeout(() => {
      void saveWorkbenchDraft(queryScope, createDraft(layout)).catch((cause: unknown) => {
        setPersistenceAvailable(false)
        toast.error(cause instanceof Error ? cause.message : 'CAE draft를 sessionStorage에 저장하지 못했습니다.')
      })
    }, 500)
    return () => window.clearTimeout(timeout)
  }, [createDraft, initialized, layout, persistenceAvailable, queryScope])

  useEffect(() => {
    if (
      !workbench.hasUnsavedWork &&
      !hasUnsavedCalculationWork &&
      !workbench.measurementActions.pendingRecordMeasurementId
    )
      return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [hasUnsavedCalculationWork, workbench.hasUnsavedWork, workbench.measurementActions.pendingRecordMeasurementId])

  const requestRunSelected = useCallback(() => {
    const runId = workbenchRef.current.measurementActions.runSelected()
    if (!runId && !workbenchRef.current.measurementActions.error) {
      throw new Error('선택한 prepared Measurement를 실행하지 못했습니다.')
    }
  }, [])

  const setActiveExperimentFile = useCallback(
    (activeExperimentFile: string | null) => setLayout((current) => ({ ...current, activeExperimentFile })),
    [setLayout],
  )

  return {
    ...layout,
    calculationContextPending,
    calculationId,
    confirmation,
    dialog,
    guardReplacement,
    initialized,
    layout,
    requestRunSelected,
    runSafely,
    setActiveExperimentFile,
    setCalculationId,
    setConfirmation,
    setDialog,
    setLayout,
  }
}
