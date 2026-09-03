import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useBlocker, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import type { PendingConfirmation } from '@/features/cae-workbench/caePageTypes'
import { calculationDetailQueryOptions } from '@/features/calculation/queryOptions'
import { loadWorkbenchDraft, saveWorkbenchDraft } from '@/features/cae-workbench/storage/draftStorage'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { defaultWorkbenchLayoutState, type WorkbenchDraft } from '@/features/cae-workbench/types'
import {
  draftNeedsPredictionLandingPreservation,
  predictionLandingExperiment,
} from '@/features/cae-workbench/predictionLandingPolicy'
import { availableExperimentsQueryOptions, experimentDetailQueryOptions } from '@/features/experiment/queryOptions'
import { measurementDetailQueryOptions } from '@/features/measurement/queryOptions'
import { createCadSourceDocument } from '@/lib/cad/source'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import { useWorkbenchShell } from '@/workbench/state/workbenchShellStore'
import { readWorkbenchUrlExperiment, replacementDisposition, writeWorkbenchUrlExperiment } from './sessionPolicy'

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
  const createDraft = workbench.draft
  const navigationBlocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasUnsavedCalculationWork &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.hash !== nextLocation.hash),
  )
  const initializingRef = useRef(false)
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
  }, [allowAdminSection, layout.activeSection, setLayout])

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
    const currentWorkbench = workbenchRef.current
    initializingRef.current = true
    setInitialized(false)
    setPersistenceAvailable(true)
    setLayout(defaultWorkbenchLayoutState)
    currentWorkbench.restoreDraft({
      savedAt: Date.now(),
      experiment: {
        record: null,
        baselineBundle: starterExperimentSourceBundle,
        document: createCadSourceDocument('experiment', starterExperimentSourceBundle),
        name: 'Starter Experiment',
        description: '브라우저에서 바로 편집하고 렌더링할 수 있는 로컬 Starter입니다.',
      },
      candidate: { vars: null, materialParameters: null },
      selection: { experimentId: null, measurementId: null, calculationId: null },
      layout: defaultWorkbenchLayoutState,
    })

    let cancelled = false
    void (async () => {
      let draft: WorkbenchDraft | null = null
      try {
        try {
          draft = await loadWorkbenchDraft(queryScope, () =>
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

        const urlExperimentId = readWorkbenchUrlExperiment(initialSearchParams)
        const draftExperimentId = draft?.experiment.record?.id ?? null
        const draftNeedsPreservation = draftNeedsPredictionLandingPreservation(draft, starterExperimentSourceBundle)
        let restoreLocalDraft = false
        let openedUrlExperiment = false

        if (urlExperimentId !== null) {
          const sameExperiment = urlExperimentId === draftExperimentId
          const openUrlExperiment =
            sameExperiment ||
            !draft ||
            !draftNeedsPreservation ||
            window.confirm('URL의 Experiment와 마지막 로컬 작업이 다릅니다. 확인을 누르면 URL 선택을 엽니다.')
          if (!openUrlExperiment) {
            restoreLocalDraft = true
          } else {
            try {
              const row = await queryClient.fetchQuery(experimentDetailQueryOptions(queryScope, urlExperimentId))
              if (cancelled) return
              if (sameExperiment && draft) {
                restoreLocalDraft = true
              } else {
                await currentWorkbench.loadExperiment(row)
                if (cancelled) return
                setLayout({ ...defaultWorkbenchLayoutState, activeSection: 'prediction' })
                openedUrlExperiment = true
              }
            } catch (cause: unknown) {
              if (cancelled) return
              toast.error(cause instanceof Error ? cause.message : 'URL의 Experiment를 열지 못했습니다.')
              if (draft && draftExperimentId === urlExperimentId) {
                draft = {
                  ...draft,
                  experiment: { ...draft.experiment, record: null, baselineBundle: null },
                  selection: { experimentId: null, measurementId: null, calculationId: null },
                  layout: { ...draft.layout, activeSection: 'prediction' },
                }
              }
              if (draft) restoreLocalDraft = true
            }
          }
        }

        if (!openedUrlExperiment) {
          const shouldRestoreDraft = Boolean(
            draft && (restoreLocalDraft || draft.experiment.record || draftNeedsPreservation),
          )
          if (draft && shouldRestoreDraft) {
            const experimentId = draft.selection.experimentId
            if (experimentId !== null) {
              const requestedMeasurementId = draft.selection.measurementId
              const requestedCalculationId = draft.selection.calculationId
              const [measurementResult, calculationResult] = await Promise.allSettled([
                requestedMeasurementId === null
                  ? Promise.resolve(null)
                  : queryClient.fetchQuery(measurementDetailQueryOptions(queryScope, requestedMeasurementId)),
                requestedCalculationId === null
                  ? Promise.resolve(null)
                  : queryClient.fetchQuery(
                      calculationDetailQueryOptions(queryScope, experimentId, requestedCalculationId),
                    ),
              ])
              if (cancelled) return
              const measurementId =
                measurementResult.status === 'fulfilled' && measurementResult.value?.experiment_id === experimentId
                  ? requestedMeasurementId
                  : null
              const calculationId =
                calculationResult.status === 'fulfilled' && calculationResult.value?.experiment_id === experimentId
                  ? requestedCalculationId
                  : null
              if (
                (requestedMeasurementId !== null && measurementId === null) ||
                (requestedCalculationId !== null && calculationId === null)
              ) {
                toast.info('저장된 자식 선택이 없거나 현재 Experiment에 속하지 않아 해당 선택만 해제했습니다.')
              }
              draft = { ...draft, selection: { experimentId, measurementId, calculationId } }
            }
            currentWorkbench.restoreDraft(draft)
            setLayout(draft.layout)
          } else {
            const available = await queryClient.ensureQueryData(availableExperimentsQueryOptions(queryScope))
            if (cancelled) return
            const selected = predictionLandingExperiment(available, draftExperimentId)
            if (selected) {
              await currentWorkbench.loadExperiment(selected)
              if (cancelled) return
            }
            setLayout(defaultWorkbenchLayoutState)
          }
        }
      } catch (cause: unknown) {
        if (cancelled) return
        toast.error(cause instanceof Error ? cause.message : 'CAE 작업을 복원하지 못했습니다.')
      }
      if (cancelled) return
      setInitialized(true)
    })()

    return () => {
      cancelled = true
      initializingRef.current = false
    }
  }, [authPending, queryClient, queryScope, setLayout])

  useEffect(() => {
    if (!initialized) return
    setSearchParams(
      (current) => {
        const next = writeWorkbenchUrlExperiment(current, workbench.experimentId)
        return next.toString() === current.toString() ? current : next
      },
      { replace: true },
    )
  }, [initialized, searchKey, setSearchParams, workbench.experimentId])

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
