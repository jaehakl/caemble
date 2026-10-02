import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { recordedDataRules } from '@/features/measurement/recordedData'
import { varsFingerprint, type Vars } from '@caemble/execution/cad/model'
import { materialVarsHash } from '@caemble/execution/material/resolution'
import { calculationSourceHash } from '@/lib/calculation'
import { predictionFingerprint } from './data'
import { comparePredictionOutput } from './metrics'
import { RemotePredictionExecution, type RemotePredictionState } from './remoteExecution'
import { usePredictionAssets } from './usePredictionAssets'
import { RemotePredictionSettings } from './RemotePredictionSettings'
import { PredictionModelSummary } from './PredictionModelSummary'
import { modelExecutionRoutes, preferredModelRoute, reconcileRemoteAssets, setupUsingSavedModel } from './remoteAssets'
import { persistPredictionSetup, restorePredictionSetup } from './setupPersistence'
import {
  loadPredictionContextData,
  loadPredictionCalculations,
  loadPredictionValidationData,
  type PredictionContext,
} from './predictionContextData'
import { usePredictionController } from './usePredictionController'
import {
  calculatePrediction,
  defaultPredictionSetup,
  predictCandidate,
  predictionSetupFingerprint,
  type PredictionRecordedPreview,
  type PredictionSetup,
} from './usePredictionModels'
import { PredictionCalculationPane, PredictionVarsPane } from './PredictionPanels'
import { initialPredictionResults, predictionResultsReducer, type ValidationRow } from './results'

export type PredictionWorkspaceCommand = Readonly<{
  id: number
  type: 'settings' | 'details' | 'predict' | 'validate' | 'cancel'
}>
export type PredictionWorkspaceChromeState = Readonly<{
  busy: boolean
  canPredict: boolean
  canValidate: boolean
  status: string
  predictDisabledReason?: string
  validateDisabledReason?: string
}>
export type PredictionViewerState = Readonly<{
  experimentId: number | null
  varsFingerprint: string
  sourceHash: string | null
  varsHash: string
  contextKey: string
  transaction: number
  preview: PredictionRecordedPreview
}>

export function PredictionWorkspace({
  active,
  authenticated,
  dataReadable,
  command,
  onActivity,
  onChromeStateChange,
  onViewerStateChange,
  onRequestLogin,
  varsContainer,
  executionContainer = null,
  workbench,
}: {
  active: boolean
  authenticated: boolean
  dataReadable: boolean
  command: PredictionWorkspaceCommand | null
  onActivity?: RuntimeActivityCallback
  onChromeStateChange: (state: PredictionWorkspaceChromeState) => void
  onViewerStateChange?: (state: PredictionViewerState | null) => void
  onRequestLogin: () => void
  selectedCalculationId?: number | null
  varsContainer: HTMLDivElement | null
  executionContainer?: HTMLDivElement | null
  workbench: CaeWorkbenchState
}) {
  const runtime = usePredictionController()
  const queryClient = useQueryClient()
  const queryScope = usePrivateQueryScope()
  const experimentId = workbench.experimentId
  const setPredictionRecords = workbench.setPredictionRecords
  const assets = usePredictionAssets(authenticated ? queryScope : null, experimentId, onActivity)
  const assetState = useSyncExternalStore(assets.subscribe, assets.getSnapshot)
  const [setup, setSetup] = useState<PredictionSetup>(defaultPredictionSetup)
  const [draft, setDraft] = useState<PredictionSetup>(defaultPredictionSetup)
  const [context, setContext] = useState<PredictionContext | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [viewer, setViewer] = useState<PredictionViewerState | null>(null)
  const [results, dispatchResults] = useReducer(predictionResultsReducer, initialPredictionResults)
  const [predicting, setPredicting] = useState(false)
  const [calculating, setCalculating] = useState(false)
  const [validating, setValidating] = useState(false)
  const [status, setStatus] = useState('모델과 예측할 BoxGrid를 선택하세요.')
  const [remoteState, setRemoteState] = useState<RemotePredictionState>('disconnected')
  const [remoteMessage, setRemoteMessage] = useState<string | null>(null)
  const [retryRevision, setRetryRevision] = useState(0)
  const [deletedRoute, setDeletedRoute] = useState<string | null>(null)
  const attempted = useRef<string | null>(null)
  const running = useRef<string | null>(null)
  const cancelledCalculation = useRef<string | null>(null)
  const validationAbort = useRef<AbortController | null>(null)

  const reference = setup.models?.forward
  const route = setup.routes?.forward
  const selectedModel = assetState.models.find((model) => model.id === reference?.modelId)
  const selectedRevision = selectedModel?.revisions.find((revision) => revision.revision === reference?.modelRevision)
  const storedAlgorithm = selectedRevision?.definition.algorithm as { kind?: unknown } | undefined
  const algorithm = typeof storedAlgorithm?.kind === 'string' ? storedAlgorithm.kind : undefined
  const routeKey = predictionFingerprint([route, queryScope, reference?.modelId, reference?.modelRevision])
  const routes = selectedModel ? modelExecutionRoutes(selectedModel, reference!.modelRevision, assetState.storages) : []
  const selectedRoute = routes.find(
    (value) => value.storageId === route?.storageId && value.launcherId === route.launcherId,
  )
  const availableModels = assetState.models.filter(
    (model) =>
      model.direction === 'forward' &&
      model.state === 'active' &&
      model.revisions.some(
        (revision) =>
          revision.state === 'ready' &&
          revision.support_status !== 'unsupported' &&
          revision.support_status !== 'retired',
      ),
  )
  useLayoutEffect(() => {
    assets.currentSelectionKey = crypto.randomUUID()
  }, [assets, reference, route, setup.recordIds])
  const document = workbench.experimentDocument
  const candidateVars = workbench.candidateVars
  const candidateFingerprint = varsFingerprint(candidateVars)
  const sourceHash =
    document.predictionCandidate?.sourceHash ??
    document.evaluatedSnapshot?.sourceHash ??
    workbench.experimentRecord?.source_hash ??
    ''
  const sourceIdentity = predictionFingerprint([experimentId, workbench.experiment?.sourceBundle.files])
  const contextReady = context?.experimentId === experimentId
  const selectedNames = useMemo(
    () =>
      contextReady
        ? context.experimentRecords
            .filter((record) => setup.recordIds.includes(record.id))
            .map((record) => record.name)
            .sort()
        : [],
    [context, contextReady, setup.recordIds],
  )
  const namesKey = JSON.stringify(selectedNames)
  const candidateReady = Boolean(
    candidateVars &&
    document.variables &&
    document.successfulRevision === document.revision &&
    varsFingerprint(document.variables) === candidateFingerprint &&
    (document.predictionCandidate
      ? JSON.stringify([...document.predictionCandidate.records].sort()) === namesKey
      : document.status === 'Ready') &&
    selectedNames.every((name) => document.simulationProgram?.boxGrids?.[name]),
  )
  const predictionKey = predictionFingerprint([
    sourceIdentity,
    candidateFingerprint,
    predictionSetupFingerprint(setup),
    context?.fingerprint,
  ])
  const currentViewer = viewer?.contextKey === predictionKey && candidateReady ? viewer : null
  const selectedCalculations = useMemo(
    () =>
      contextReady ? context.calculations.filter((calculation) => setup.calculationIds.includes(calculation.id)) : [],
    [context, contextReady, setup.calculationIds],
  )
  const calculationKey = predictionFingerprint([
    selectedCalculations.map((calculation) => [
      calculation.id,
      calculation.source_hash,
      calculation.source_code,
      calculation.output_layout,
      calculation.experiment_record_ids,
    ]),
    currentViewer?.contextKey,
    currentViewer?.transaction,
  ])
  const missingModelOutputs = selectedCalculations
    .flatMap((calculation) => calculation.experiment_record_ids)
    .filter((id) => !reference?.contract?.records[id])
  const busy = predicting || calculating || validating

  let unavailable: string | undefined
  if (!authenticated) unavailable = '로그인 후 내 Launcher에서 예측할 수 있습니다.'
  else if (!dataReadable || experimentId === null) unavailable = 'Prediction에 사용할 저장 Experiment를 여세요.'
  else if (contextError) unavailable = contextError
  else if (!contextReady) unavailable = 'Experiment 출력 계약을 불러오는 중입니다.'
  else if (!reference) unavailable = '모델을 선택하거나 데이터·모델 관리에서 만드세요.'
  else if (selectedRevision?.support_status === 'unsupported' || selectedRevision?.support_status === 'retired')
    unavailable = '이 모델 버전의 알고리즘은 현재 지원하지 않습니다.'
  else if (!route) unavailable = '접근 가능한 모델 복사본을 가진 Launcher를 선택하세요.'
  else if (deletedRoute === routeKey) unavailable = '선택한 복사본을 해제했습니다. 다른 복사본을 선택하거나 복원하세요.'
  else if (selectedRoute && !selectedRoute.connected) unavailable = 'Launcher 연결 끊김'
  else if (selectedRevision && !selectedRoute) unavailable = '접근 가능한 모델 복사본 없음'
  else if (selectedRoute && !['present', 'unverified'].includes(selectedRoute.state))
    unavailable = '접근 가능한 모델 복사본 없음 · 복원 또는 파일 검증이 필요합니다.'
  else if (!setup.recordIds.length) unavailable = '예측할 BoxGrid를 하나 이상 선택하세요.'
  else if (!candidateReady)
    unavailable =
      document.status === 'Error'
        ? 'Candidate BoxGrid 평가 실패 · Experiment 오류를 확인하세요.'
        : '현재 Candidate의 BoxGrid를 준비하는 중입니다.'

  const validationDisabledReason = !authenticated
    ? '로그인 후 저장하고 실제 해석을 실행할 수 있습니다.'
    : !workbench.experimentManageable
      ? '이 Experiment의 데이터를 변경할 권한이 없습니다.'
      : !workbench.experimentClean || experimentId === null
        ? '저장되고 수정되지 않은 Experiment가 필요합니다.'
        : busy || workbench.measurementActions.busy || workbench.calculationDataActions.busy
          ? '진행 중인 작업이 있습니다.'
          : !currentViewer
            ? '현재 Candidate의 예측 결과가 필요합니다.'
            : document.draftTaskNames.length
              ? 'Solver가 선택되지 않은 Draft Task가 있습니다.'
              : undefined

  const latest = useRef({
    active,
    setup,
    context,
    document,
    candidateVars,
    candidateReady,
    predictionKey,
    sourceHash,
    experimentId,
    onActivity,
    unavailable,
    remoteState,
    currentViewer,
    validationDisabledReason,
    selectedCalculations,
    calculationKey,
    results,
    workbench,
  })
  latest.current = {
    active,
    setup,
    context,
    document,
    candidateVars,
    candidateReady,
    predictionKey,
    sourceHash,
    experimentId,
    onActivity,
    unavailable,
    remoteState,
    currentViewer,
    validationDisabledReason,
    selectedCalculations,
    calculationKey,
    results,
    workbench,
  }

  useLayoutEffect(() => {
    runtime.setExecution(null)
    validationAbort.current?.abort()
    const restored = authenticated && experimentId !== null ? restorePredictionSetup(queryScope, experimentId) : null
    setSetup(restored ?? defaultPredictionSetup)
    setDraft(restored ?? defaultPredictionSetup)
    setContext(null)
    setContextError(null)
    setViewer(null)
    dispatchResults({ type: 'cleared' })
    attempted.current = null
    running.current = null
    setDeletedRoute(null)
    setPredicting(false)
    setCalculating(false)
    setValidating(false)
  }, [authenticated, experimentId, queryScope, runtime])

  useEffect(() => {
    if (!authenticated || !dataReadable || experimentId === null) return
    const abort = new AbortController()
    setContextError(null)
    void loadPredictionContextData({ experimentId, queryClient, queryScope, signal: abort.signal }).then(
      (loaded) => {
        if (abort.signal.aborted) return
        setContext(loaded)
        void loadPredictionCalculations({ experimentId, queryClient, queryScope, signal: abort.signal }).then(
          (calculations) => {
            if (!abort.signal.aborted)
              setContext((current) =>
                current?.experimentId === experimentId
                  ? { ...current, calculations, calculationError: undefined }
                  : current,
              )
          },
          () => {
            if (!abort.signal.aborted)
              setContext((current) =>
                current?.experimentId === experimentId
                  ? {
                      ...current,
                      calculationError: 'Calculation 목록을 불러오지 못했습니다. BoxGrid 예측은 사용할 수 있습니다.',
                    }
                  : current,
              )
          },
        )
      },
      (error: unknown) => {
        if (!abort.signal.aborted) setContextError(error instanceof Error ? error.message : String(error))
      },
    )
    return () => abort.abort()
  }, [authenticated, dataReadable, experimentId, queryClient, queryScope, reload])

  useEffect(() => {
    if (active) setPredictionRecords(selectedNames)
  }, [active, selectedNames, setPredictionRecords])

  useLayoutEffect(() => {
    runtime.invalidateTransaction()
    running.current = null
    attempted.current = null
    setPredicting(false)
  }, [routeKey, runtime])

  useEffect(() => {
    if (!authenticated || !route) {
      runtime.setExecution(null)
      return
    }
    const binding = {
      key: routeKey,
      create: () =>
        new RemotePredictionExecution(route.launcherId, {
          storageId: route.storageId,
          algorithm,
          modelId: reference?.modelId,
          modelRevision: reference?.modelRevision,
          onState: (state, message) => {
            setRemoteState(state)
            setRemoteMessage(message ?? null)
          },
          onHello: reconcileRemoteAssets,
          onWarning: (message) => onActivity?.({ source: 'prediction', level: 'warning', phase: 'remote', message }),
        }),
    }
    runtime.setExecution(binding)
  }, [authenticated, onActivity, route, routeKey, runtime, algorithm, reference?.modelId, reference?.modelRevision])

  useLayoutEffect(() => {
    runtime.invalidateTransaction()
    validationAbort.current?.abort()
    running.current = null
    attempted.current = null
    setPredicting(false)
    setCalculating(false)
    setValidating(false)
    dispatchResults({ type: 'cleared' })
  }, [predictionKey, runtime])

  useEffect(() => {
    if (active) return
    runtime.invalidateTransaction()
    if (running.current) attempted.current = null
    running.current = null
    setPredicting(false)
    setCalculating(false)
  }, [active, runtime])

  useEffect(() => {
    onViewerStateChange?.(active && dataReadable ? currentViewer : null)
  }, [active, currentViewer, dataReadable, onViewerStateChange])
  useEffect(() => () => onViewerStateChange?.(null), [onViewerStateChange])

  const applySetup = useCallback(
    (next: PredictionSetup) => {
      setSetup(next)
      setDraft(next)
      if (authenticated && experimentId !== null) persistPredictionSetup(queryScope, experimentId, next)
      setSettingsOpen(false)
      setDeletedRoute(null)
    },
    [authenticated, experimentId, queryScope],
  )

  const runPrediction = useCallback(async () => {
    const state = latest.current
    if (
      !state.active ||
      state.unavailable ||
      !state.context ||
      !state.candidateVars ||
      !state.document.varsSchema ||
      !state.document.simulationProgram?.boxGrids ||
      running.current === state.predictionKey
    )
      return
    const key = state.predictionKey
    attempted.current = key
    running.current = key
    const transaction = runtime.beginTransaction()
    setPredicting(true)
    setStatus('원격 모델 로드·BoxGrid 예측 중…')
    try {
      const preview = await predictCandidate({
        runtime,
        transaction,
        setup: state.setup,
        context: state.context,
        varsSchema: state.document.varsSchema,
        vars: state.candidateVars,
        sourceHash: state.sourceHash,
        candidateBoxGrids: state.document.simulationProgram.boxGrids,
        resultContracts: state.document.simulationProgram.resultContracts,
        onActivity: state.onActivity,
      })
      if (!runtime.transactionIsCurrent(transaction) || latest.current.predictionKey !== key || !latest.current.active)
        return
      setViewer({
        experimentId: state.experimentId,
        varsFingerprint: varsFingerprint(state.candidateVars),
        sourceHash: state.sourceHash,
        varsHash: materialVarsHash(state.candidateVars),
        contextKey: key,
        transaction,
        preview,
      })
      setStatus('예측 BoxGrid 준비됨')
    } catch (error) {
      if (!runtime.transactionIsCurrent(transaction)) return
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      if (running.current === key) {
        running.current = null
        setPredicting(false)
      }
    }
  }, [runtime])

  useEffect(() => {
    if (!active || unavailable || validating || attempted.current === predictionKey || currentViewer) return
    void runPrediction()
  }, [active, unavailable, validating, predictionKey, currentViewer, runPrediction, retryRevision, routeKey])

  useEffect(() => {
    runtime.abortCalculation()
    if (
      !active ||
      !currentViewer ||
      !context ||
      !selectedCalculations.length ||
      cancelledCalculation.current === calculationKey
    ) {
      setCalculating(false)
      return
    }
    const abort = runtime.beginCalculation()
    setCalculating(true)
    void calculatePrediction(currentViewer.preview, selectedCalculations, context, abort.signal, onActivity)
      .then(
        (calculated) => {
          if (!abort.signal.aborted) dispatchResults({ type: 'calculated', calculations: calculated })
        },
        (error: unknown) => {
          if (!abort.signal.aborted) setStatus(error instanceof Error ? error.message : String(error))
        },
      )
      .finally(() => {
        if (!abort.signal.aborted) setCalculating(false)
      })
    return () => abort.abort()
  }, [active, calculationKey, context, currentViewer, onActivity, runtime, selectedCalculations])

  const retry = useCallback(() => {
    if (latest.current.remoteState === 'failed') runtime.resetExecution()
    attempted.current = null
    cancelledCalculation.current = null
    setViewer(null)
    setRetryRevision((value) => value + 1)
  }, [runtime])

  const cancel = useCallback(() => {
    attempted.current = latest.current.predictionKey
    cancelledCalculation.current = latest.current.calculationKey
    running.current = null
    runtime.cancelCurrent()
    validationAbort.current?.abort()
    if (validating) latest.current.workbench.measurementActions.cancel()
    setPredicting(false)
    setCalculating(false)
    setValidating(false)
    setStatus('Prediction 작업을 취소했습니다. 다시 예측하거나 Vars를 바꾸세요.')
  }, [runtime, validating])

  const validate = useCallback(async () => {
    const state = latest.current
    if (state.validationDisabledReason || !state.currentViewer || state.experimentId === null) return
    const preview = state.currentViewer
    const predictedValues =
      state.results.calculations?.source === preview.preview.source ? state.results.calculations.values : {}
    const selected = state.selectedCalculations.filter((item) => predictedValues[item.id])
    const abort = new AbortController()
    validationAbort.current?.abort()
    validationAbort.current = abort
    setValidating(true)
    setStatus('Candidate 저장·실제 해석 실행 중…')
    try {
      const sourceHashes = new Map(
        await Promise.all(
          selected.map(async (item) => [item.id, await calculationSourceHash(item.source_code)] as const),
        ),
      )
      abort.signal.throwIfAborted()
      const completion = await state.workbench.measurementActions.saveAndRunCurrentAsync()
      abort.signal.throwIfAborted()
      const actual = await loadPredictionValidationData({
        calculationIds: selected.map((item) => item.id),
        experimentId: state.experimentId,
        measurementId: completion.measurementId,
        queryClient,
        queryScope,
        signal: abort.signal,
      })
      abort.signal.throwIfAborted()
      if (latest.current.predictionKey !== preview.contextKey) return
      const rows = selected.map((calculation): ValidationRow => {
        const record = actual.actual.find((item) => item.calculation_id === calculation.id)
        const error =
          sourceHashes.get(calculation.id) !== actual.currentSourceFingerprints.get(calculation.id)
            ? 'Calculation source가 검증 snapshot과 다릅니다.'
            : !record
              ? '실제 Calculation 결과가 없습니다.'
              : null
        return {
          calculationId: calculation.id,
          reference: predictedValues[calculation.id],
          actual: record?.data ?? null,
          error,
          metric: record && !error ? comparePredictionOutput(predictedValues[calculation.id], record.data) : null,
        }
      })
      dispatchResults({ type: 'validated', rows, measurementId: completion.measurementId })
      setStatus(`Measurement #${completion.measurementId} 실제 해석 완료`)
    } catch (error) {
      if (!abort.signal.aborted) setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      if (validationAbort.current === abort) {
        validationAbort.current = null
        setValidating(false)
      }
    }
  }, [queryClient, queryScope])

  useEffect(
    () =>
      assets.registerDeletionHandler(async (target) => {
        const state = latest.current.setup
        const model = state.models?.forward
        if (
          model?.modelId !== target.modelId ||
          (target.revision !== undefined && target.revision !== model.modelRevision) ||
          (target.storageId !== undefined && target.storageId !== state.routes?.forward?.storageId)
        )
          return
        attempted.current = latest.current.predictionKey
        setDeletedRoute(predictionFingerprint([state.routes?.forward, queryScope]))
        await runtime.releaseLoadedModels()
        setPredicting(false)
        setStatus('선택한 모델 인스턴스를 해제했습니다.')
      }),
    [assets, queryScope, runtime],
  )

  const commands = useRef({ setup, retry, cancel, validate })
  commands.current = { setup, retry, cancel, validate }
  useEffect(() => {
    if (!command) return
    if (command.type === 'settings') {
      setDraft(commands.current.setup)
      setSettingsOpen(true)
    } else if (command.type === 'details') setDetailsOpen(true)
    else if (command.type === 'predict') commands.current.retry()
    else if (command.type === 'cancel') commands.current.cancel()
    else void commands.current.validate()
  }, [command])

  useEffect(
    () =>
      onChromeStateChange({
        busy,
        canPredict: !unavailable && !validating,
        canValidate: !validationDisabledReason,
        status: unavailable ?? remoteMessage ?? status,
        predictDisabledReason: unavailable,
        validateDisabledReason: validationDisabledReason,
      }),
    [busy, unavailable, validating, validationDisabledReason, status, remoteMessage, onChromeStateChange],
  )

  const varsPane = (
    <PredictionVarsPane
      candidateSessionKey={`${workbench.workspaceSession}:prediction`}
      schema={document.varsSchema}
      vars={candidateVars}
      disabled={validating}
      status={unavailable ?? remoteMessage ?? status}
      onVarsChange={(vars: Readonly<Vars>) => {
        if (varsFingerprint(vars) === candidateFingerprint) return
        runtime.invalidateTransaction()
        workbench.setCandidateVariables(vars, 'user-vars')
      }}
    />
  )

  const executionPane = (
    <section className="flex flex-wrap items-end gap-3 border-b px-3 py-2" aria-label="원격 Prediction 실행">
      <label className="block min-w-48 text-xs">
        모델
        <select
          aria-label="Prediction 모델"
          className="mt-1 w-full rounded border bg-background p-2"
          value={reference?.modelId ?? ''}
          onChange={(event) => {
            const model = availableModels.find((item) => item.id === event.target.value)
            if (!model) {
              applySetup({ ...setup, models: {}, routes: {}, recordIds: [] })
              return
            }
            const revision = model.revisions
              .filter(
                (item) =>
                  item.state === 'ready' && item.support_status !== 'unsupported' && item.support_status !== 'retired',
              )
              .reduce((latest, item) => Math.max(latest, item.revision), 0)
            applySetup(
              setupUsingSavedModel(setup, model, revision, preferredModelRoute(model, revision, assetState.storages)),
            )
          }}
        >
          <option value="">모델 선택</option>
          {reference && !availableModels.some((item) => item.id === reference.modelId) ? (
            <option value={reference.modelId}>저장된 모델 · 목록 확인 필요</option>
          ) : null}
          {availableModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
      {reference ? (
        <p className="text-xs text-muted-foreground">
          {selectedRevision?.definition.algorithm &&
          typeof selectedRevision.definition.algorithm === 'object' &&
          'kind' in selectedRevision.definition.algorithm
            ? String(selectedRevision.definition.algorithm.kind)
            : '알고리즘 확인 중'}{' '}
          · revision {reference.modelRevision}
        </p>
      ) : null}
      <label className="block min-w-48 text-xs">
        실행할 Launcher
        <select
          aria-label="Prediction Launcher"
          className="mt-1 w-full rounded border bg-background p-2"
          value={route ? `${route.storageId}:${route.launcherId}` : ''}
          onChange={(event) => {
            const next = routes.find((item) => `${item.storageId}:${item.launcherId}` === event.target.value)
            applySetup({
              ...setup,
              routes: {
                forward: next
                  ? { replicaId: next.replicaId, storageId: next.storageId, launcherId: next.launcherId }
                  : undefined,
              },
            })
          }}
        >
          <option value="">Launcher 선택</option>
          {route && !selectedRoute ? (
            <option value={`${route.storageId}:${route.launcherId}`}>저장된 Launcher · 연결 확인 필요</option>
          ) : null}
          {routes.map((item) => (
            <option key={`${item.storageId}:${item.launcherId}`} value={`${item.storageId}:${item.launcherId}`}>
              {assetState.launchers.find((launcher) => launcher.id === item.launcherId)?.launcher_name ?? item.name}
              {item.connected ? '' : ' · 연결 끊김'}
            </option>
          ))}
        </select>
      </label>
      <p role="status" className="text-xs">
        {unavailable ?? remoteMessage ?? status}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={Boolean(unavailable) || validating || predicting} onClick={retry}>
          예측
        </Button>
        <Button size="sm" variant="outline" disabled={!busy} onClick={cancel}>
          취소
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setReload((value) => value + 1)
            void assets.refresh()
          }}
        >
          목록 새로고침
        </Button>
      </div>
      {!authenticated ? (
        <Button size="sm" onClick={onRequestLogin}>
          로그인
        </Button>
      ) : null}
    </section>
  )

  return (
    <>
      {varsContainer ? createPortal(varsPane, varsContainer) : null}
      <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
        {executionContainer ? createPortal(executionPane, executionContainer) : executionPane}
        <section className="space-y-2 rounded border p-3" aria-label="예측할 BoxGrid">
          <h3 className="text-sm font-medium">예측할 BoxGrid</h3>
          {(context?.experimentRecords ?? [])
            .filter((record) => !reference || Boolean(reference.contract?.records[record.id]))
            .map((record) => (
              <label className="flex gap-2 text-xs" key={record.id}>
                <input
                  type="checkbox"
                  checked={setup.recordIds.includes(record.id)}
                  onChange={(event) =>
                    applySetup({
                      ...setup,
                      recordIds: event.target.checked
                        ? [...setup.recordIds, record.id]
                        : setup.recordIds.filter((id) => id !== record.id),
                    })
                  }
                />
                {record.name}
              </label>
            ))}
          {!reference ? (
            <p className="text-xs text-muted-foreground">모델을 선택하면 지원하는 출력을 확인할 수 있습니다.</p>
          ) : null}
        </section>
        <PredictionModelSummary
          manager={assets}
          setup={setup}
          onManage={() => {
            setDraft(setup)
            setSettingsOpen(true)
          }}
        />
        <details open={setup.calculationIds.length > 0} className="space-y-2 rounded border p-3">
          <summary className="cursor-pointer text-sm font-medium">Calculation · 선택적 분석</summary>
          <p className="text-xs text-muted-foreground">
            예측 BoxGrid에 적용합니다. 분석 선택은 모델을 변경하지 않습니다.
          </p>
          {context?.calculationError ? <p className="text-xs">{context.calculationError}</p> : null}
          {(context?.calculations ?? []).map((calculation) => (
            <label className="flex gap-2 text-xs" key={calculation.id}>
              <input
                type="checkbox"
                checked={setup.calculationIds.includes(calculation.id)}
                disabled={calculation.contract_status !== 'ready'}
                onChange={(event) =>
                  applySetup({
                    ...setup,
                    calculationIds: event.target.checked
                      ? [...setup.calculationIds, calculation.id]
                      : setup.calculationIds.filter((id) => id !== calculation.id),
                  })
                }
              />
              {calculation.name}
            </label>
          ))}
          {selectedCalculations.length ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                applySetup({
                  ...setup,
                  recordIds: [
                    ...new Set([
                      ...setup.recordIds,
                      ...selectedCalculations
                        .flatMap((item) => item.experiment_record_ids)
                        .filter((id) => Boolean(reference?.contract?.records[id])),
                    ]),
                  ],
                })
              }
            >
              분석에 필요한 BoxGrid 선택
            </Button>
          ) : null}
          {missingModelOutputs.length ? (
            <p className="text-xs text-amber-700">
              선택한 분석에 이 모델이 지원하지 않는 출력이 있습니다. 해당 BoxGrid를 포함한 모델을 선택하거나 만드세요.
            </p>
          ) : null}
          <PredictionCalculationPane
            calculations={selectedCalculations}
            result={results.calculations?.source === currentViewer?.preview.source ? results.calculations : null}
            actual={results.actual}
            busy={calculating}
          />
        </details>
      </div>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>데이터·모델 관리</DialogTitle>
          </DialogHeader>
          <RemotePredictionSettings
            authenticated={authenticated}
            open={settingsOpen}
            manager={assets}
            context={context}
            sourceHash={workbench.experimentRecord?.source_hash ?? null}
            varsSchema={document.varsSchema}
            rules={recordedDataRules(document.simulationProgram?.recordedData ?? {}, 'prediction.forward')}
            resultContracts={document.simulationProgram?.resultContracts ?? {}}
            setup={draft}
            onChange={setDraft}
            onUse={applySetup}
            onActivity={onActivity}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>예측 출처</DialogTitle>
          </DialogHeader>
          {currentViewer ? (
            <div className="space-y-2 text-xs break-all">
              <p>Candidate {currentViewer.preview.source.candidate.fingerprint}</p>
              <p>
                Model {currentViewer.preview.source.model.modelId} · r{currentViewer.preview.source.model.modelRevision}
              </p>
              <p>
                Dataset {currentViewer.preview.source.model.datasetId} · r
                {currentViewer.preview.source.model.datasetRevision}
              </p>
              <p>예측 결과 · 실제 RecordedData 및 학습 관측값으로 저장되지 않습니다.</p>
              {currentViewer.preview.result.extrapolatedInputKeys.length ? (
                <p>학습 범위 밖 입력: {currentViewer.preview.result.extrapolatedInputKeys.join(', ')}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm">현재 Candidate의 예측 결과가 없습니다.</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
