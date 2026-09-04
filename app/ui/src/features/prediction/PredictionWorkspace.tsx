import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import type { AvailableExperimentRecord, CalculationDataOutput, CalculationOutputLayout } from '@/api'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { calculationSourceHash } from '@/lib/calculation'
import {
  varsFingerprint as candidateFingerprint,
  varsTensorFromFlat,
  type Tensor,
  type Vars,
} from '@/lib/cad/model'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { compatibleVarsResetValues } from '../calculation/varsTensor'
import { availableExperimentsQueryOptions } from '../experiment/queryOptions'
import {
  predictionFingerprint,
  predictionForwardRefreshState,
  predictionForwardResultIsCurrent,
  predictionVarsLayouts,
  predictionVarsSamples,
} from './data'
import { emitPredictionCohortDiagnostics } from './diagnostics'
import {
  comparePredictionOutput,
  inverseValidationAggregateErrorFromScales,
  predictionOutputRange,
  type PredictionValidationMetric,
} from './metrics'
import {
  PredictionCalculationPane,
  PredictionDetailsDialog,
  PredictionSetupDialog,
  PredictionVarsPane,
  type PredictionCalculationPaneItem,
  type PredictionSetupBusyAction,
} from './PredictionPanels'
import type {
  PredictionCohortSummary,
  PredictionDirection,
  PredictionNeighbor,
  PredictionResult,
  PredictionTensorLayout,
} from './knn'
import type { PredictionWorkerModelProfile } from './protocol'
import {
  loadPredictionContextData,
  loadPredictionContextFingerprint,
  loadPredictionValidationData,
  type PredictionContext,
} from './predictionContextData'
import { predictionSamplingCandidateWaitResult, type PredictionSamplingRange } from './sampling'
import { usePredictionController, type PredictionForwardRecordProfile } from './usePredictionController'
import {
  defaultPredictionSetup as defaultSetup,
  usePredictionModels,
  type PredictionSetup,
  type PredictionVarsSchema as VarsSchema,
} from './usePredictionModels'

export type PredictionWorkspaceCommand = Readonly<{
  id: number
  type: 'settings' | 'details' | 'validate' | 'sample' | 'cancel'
  sampleCount?: number
}>

export type PredictionWorkspaceChromeState = Readonly<{
  busy: boolean
  canSample: boolean
  canValidate: boolean
  direction: PredictionDirection
  status: string
  sampleDisabledReason?: string
  validateDisabledReason?: string
}>

type ForwardRefreshFailure = Readonly<{
  fingerprint: string
  message: string
}>

type ValidationRow = Readonly<{
  actual: CalculationDataOutput | null
  calculationId: number
  metric: PredictionValidationMetric | null
  error: string | null
  reference: CalculationDataOutput
}>

type ValidationResult = Readonly<{
  aggregateError: number | null
  candidateVarsFingerprint: string
  calculationWeights: Readonly<Record<number, number>>
  direction: PredictionDirection
  experimentId: number
  inverseInputLayouts: readonly PredictionTensorLayout[] | null
  inverseInputScales: Float64Array | null
  measurementId: number
  primaryRevision: number
  repredicted: Readonly<Record<number, CalculationDataOutput>>
  rows: readonly ValidationRow[]
  snapshotFingerprint: string
  sourceFingerprints: Readonly<Record<number, string>>
  setupFingerprint: string
  summary: string
  transactionId: number
}>

const integerRanges: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  int8: [-128, 127],
  int16: [-32_768, 32_767],
  int32: [-2_147_483_648, 2_147_483_647],
  uint8: [0, 255],
  uint16: [0, 65_535],
  uint32: [0, 4_294_967_295],
})

function calculationPlaceholder(layout: CalculationOutputLayout): CalculationDataOutput {
  const size = layout.shape.reduce((total, length) => total * length, 1)
  return Object.freeze({
    dtype: layout.dtype,
    shape: Object.freeze([...layout.shape]),
    data: layout.shape.length === 0 ? 0 : Object.freeze(Array.from({ length: size }, () => 0)),
    axes: Object.freeze(
      layout.axes.map((axis) =>
        Object.freeze({
          name: axis.name,
          ticks: Object.freeze([...axis.ticks]),
          ...(axis.unit ? { unit: axis.unit } : {}),
        }),
      ),
    ),
  })
}

function cohortSummary(
  profile: PredictionWorkerModelProfile | null,
  totalRows: number,
): PredictionCohortSummary | null {
  if (!profile) return null
  return Object.freeze({
    totalRows,
    includedRows: profile.rowCount,
    includedMeasurementIds: profile.includedMeasurementIds,
    warningMeasurementIds: profile.warningMeasurementIds,
    dominantShapeSignature: profile.dominantShapeSignature,
    baselineMeasurementId: profile.baselineMeasurementId,
    diagnostics: profile.diagnostics,
    omittedDiagnosticGroups: profile.omittedDiagnosticGroups,
    excluded: profile.excluded,
  })
}

export function PredictionWorkspace({
  active,
  authenticated,
  dataReadable,
  command,
  onActivity,
  onChromeStateChange,
  onExperimentChange,
  onRequestLogin,
  selectedCalculationId,
  varsContainer,
  workbench,
}: {
  active: boolean
  authenticated: boolean
  dataReadable: boolean
  command: PredictionWorkspaceCommand | null
  onActivity?: RuntimeActivityCallback
  onChromeStateChange: (state: PredictionWorkspaceChromeState) => void
  onExperimentChange: (experiment: AvailableExperimentRecord) => void
  onRequestLogin: () => void
  selectedCalculationId: number | null
  varsContainer: HTMLDivElement | null
  workbench: CaeWorkbenchState
}) {
  const [forwardRecordProfiles, setForwardRecordProfiles] = useState<readonly PredictionForwardRecordProfile[]>([])
  const {
    busyRef,
    cancelLifecycle,
    dataStaleRef,
    finishOperation,
    freshnessPendingRef,
    lifecycle,
    runtime,
    samplingProgressRef,
    setDataStale,
    setDirection,
    setFreshnessPending,
    setSamplingProgress,
    setStatus,
    startOperation,
  } = usePredictionController()
  const { busy, dataStale, direction, freshnessPending, retryingValidation, samplingProgress, status, validating } =
    lifecycle
  const autoLoadAttemptRef = useRef<string | null>(null)
  const previousActiveRef = useRef(active)
  const previousPredictionBusyRef = useRef(false)
  const skipNextPredictionBusyCheckRef = useRef(false)
  const previousMutableDataBusyRef = useRef(workbench.measurementActions.busy || workbench.calculationDataActions.busy)
  const suppressedCandidateRef = useRef<string | null>(null)
  const activeForwardVarsFingerprintRef = useRef<string | null>(null)
  const userChangedVarsRef = useRef(false)
  const cancelMeasurementRef = useRef(workbench.measurementActions.cancel)
  const cancelCalculationDataRef = useRef(workbench.calculationDataActions.cancel)
  const clearModelCaches = useCallback(() => {
    runtime.clearModelCaches()
    setForwardRecordProfiles([])
  }, [runtime])

  const [context, setContext] = useState<PredictionContext | null>(null)
  const contextRef = useRef(context)
  const [setup, setSetup] = useState<PredictionSetup>(defaultSetup)
  const [setupDraft, setSetupDraft] = useState<PredictionSetup>(defaultSetup)
  const [setupAppliedRevision, setSetupAppliedRevision] = useState(0)
  const [setupOpen, setSetupOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailsDirection, setDetailsDirection] = useState<PredictionDirection>('forward')
  const [setupBusyAction, setSetupBusyAction] = useState<PredictionSetupBusyAction>(null)
  const [guideProgress, setGuideProgress] = useState(() => {
    try {
      const complete = sessionStorage.getItem('caemble.prediction-guide-complete') === '1'
      return { forward: complete, inverse: complete }
    } catch {
      return { forward: false, inverse: false }
    }
  })
  const [calculationValues, setCalculationValues] = useState<Readonly<Record<number, CalculationDataOutput>>>({})
  const [calculationPrimaryRevision, setCalculationPrimaryRevision] = useState(0)
  const [calculationErrors, setCalculationErrors] = useState<Readonly<Record<number, string>>>({})
  const [surrogateValues, setSurrogateValues] = useState<Readonly<Record<number, CalculationDataOutput>>>({})
  const [surrogateErrors, setSurrogateErrors] = useState<Readonly<Record<number, string>>>({})
  const [neighborsByDirection, setNeighborsByDirection] = useState<
    Partial<Record<PredictionDirection, readonly PredictionNeighbor[]>>
  >({})
  const [profiles, setProfiles] = useState<Partial<Record<PredictionDirection, PredictionWorkerModelProfile>>>({})
  const [lastResult, setLastResult] = useState<PredictionResult | null>(null)
  const [forwardVarsFingerprint, setForwardVarsFingerprint] = useState<string | null>(null)
  const [forwardFailure, setForwardFailure] = useState<ForwardRefreshFailure | null>(null)
  const [inverseVarsFingerprint, setInverseVarsFingerprint] = useState<string | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [samplingRanges, setSamplingRanges] = useState<Readonly<Record<string, PredictionSamplingRange>>>({})
  const calculationValuesRef = useRef(calculationValues)
  calculationValuesRef.current = calculationValues
  cancelMeasurementRef.current = workbench.measurementActions.cancel
  cancelCalculationDataRef.current = workbench.calculationDataActions.cancel

  const experimentId = workbench.experimentId
  const experimentIdRef = useRef(experimentId)
  const queryScope = usePrivateQueryScope()
  const queryClient = useQueryClient()
  const availableQuery = useQuery(availableExperimentsQueryOptions(queryScope))
  const contextExperimentMatches = context?.experimentId === experimentId
  const varsSchema = workbench.experimentDocument.varsSchema as VarsSchema | null
  const candidateVars = workbench.candidateVars
  const currentCandidateFingerprint = candidateFingerprint(candidateVars)
  const candidateEvaluationReady = Boolean(
    workbench.experimentDocument.status === 'Ready' &&
    workbench.experimentDocument.successfulRevision === workbench.experimentDocument.revision &&
    workbench.experimentDocument.variables &&
    candidateFingerprint(workbench.experimentDocument.variables) === currentCandidateFingerprint,
  )
  const currentForwardFailure = forwardFailure?.fingerprint === currentCandidateFingerprint ? forwardFailure : null
  const forwardRefreshState = predictionForwardRefreshState({
    candidateReady: candidateEvaluationReady,
    completedFingerprint: forwardVarsFingerprint,
    currentFingerprint: currentCandidateFingerprint,
    failureFingerprint: currentForwardFailure?.fingerprint ?? null,
  })
  const forwardRefreshing =
    direction === 'forward' &&
    active &&
    contextExperimentMatches &&
    !freshnessPending &&
    !dataStale &&
    candidateVars !== null &&
    setup.calculationIds.length > 0 &&
    (forwardRefreshState === 'waiting-candidate' || forwardRefreshState === 'updating')
  const predictionUpdating = busy || forwardRefreshing
  const profile = profiles[direction] ?? null
  const candidateFingerprintRef = useRef(currentCandidateFingerprint)
  const candidateVarsRef = useRef(candidateVars)
  const experimentDocumentRef = useRef(workbench.experimentDocument)
  const measurementActionsRef = useRef(workbench.measurementActions)
  const setCandidateVariablesRef = useRef(workbench.setCandidateVariables)
  const sourceIdentity = predictionFingerprint([
    experimentId,
    workbench.experiment?.sourceBundle.files ?? null,
    workbench.experimentRecord?.source_hash ?? null,
  ])
  const sourceIdentityRef = useRef(sourceIdentity)
  const selectedCalculations = useMemo(
    () =>
      contextExperimentMatches
        ? context.calculations.filter((calculation) => setup.calculationIds.includes(calculation.id))
        : [],
    [context, contextExperimentMatches, setup.calculationIds],
  )
  contextRef.current = context
  experimentIdRef.current = experimentId
  candidateFingerprintRef.current = currentCandidateFingerprint
  candidateVarsRef.current = candidateVars
  experimentDocumentRef.current = workbench.experimentDocument
  measurementActionsRef.current = workbench.measurementActions
  setCandidateVariablesRef.current = workbench.setCandidateVariables
  sourceIdentityRef.current = sourceIdentity

  const samplingRangeResetKey = predictionFingerprint([
    experimentId,
    Object.entries(varsSchema ?? {}).map(([key, entry]) => [key, entry.shape, entry.min, entry.max]),
  ])
  const defaultSamplingRanges = useMemo(
    () =>
      Object.freeze(
        Object.fromEntries(
          Object.entries(varsSchema ?? {}).map(([key, entry]) => [
            key,
            Object.freeze({ min: entry.min, max: entry.max }),
          ]),
        ),
      ),
    [samplingRangeResetKey],
  )
  useEffect(() => setSamplingRanges(defaultSamplingRanges), [defaultSamplingRanges, samplingRangeResetKey])
  const effectiveSamplingRanges =
    Object.keys(samplingRanges).length === Object.keys(defaultSamplingRanges).length
      ? samplingRanges
      : defaultSamplingRanges
  const resetValues = useMemo(
    () =>
      compatibleVarsResetValues(
        contextExperimentMatches
          ? context.measurements.flatMap((measurement) =>
              measurement.vars ? [measurement.vars as Readonly<Vars>] : [],
            )
          : [],
        varsSchema ?? {},
      ),
    [context, contextExperimentMatches, varsSchema],
  )

  useEffect(() => {
    if (!guideProgress.forward || !guideProgress.inverse) return
    try {
      sessionStorage.setItem('caemble.prediction-guide-complete', '1')
    } catch {
      // Session storage can be unavailable in hardened browser contexts.
    }
  }, [guideProgress])

  const rememberProfile = useCallback(
    (next: PredictionWorkerModelProfile, fingerprint: string) => {
      setProfiles((current) => ({ ...current, [next.direction]: next }))
      emitPredictionCohortDiagnostics(next, fingerprint, runtime.emittedDiagnosticFingerprints, onActivity)
    },
    [onActivity, runtime],
  )

  const cancelCurrent = useCallback(() => {
    const samplingAtCancellation = samplingProgressRef.current
    const outcome = runtime.cancelCurrent({
      cancelCalculationData: cancelCalculationDataRef.current,
      cancelMeasurement: cancelMeasurementRef.current,
      samplingActive: samplingAtCancellation !== null,
    })
    activeForwardVarsFingerprintRef.current = null
    if (outcome.modelsCleared) setForwardRecordProfiles([])
    if (outcome.validationActive) {
      setForwardVarsFingerprint(null)
      setInverseVarsFingerprint(null)
    }
    cancelLifecycle({
      dataStale: dataStaleRef.current || outcome.validationActive,
      freshnessPending: freshnessPendingRef.current || Boolean(samplingAtCancellation?.recorded),
    })
  }, [cancelLifecycle, dataStaleRef, freshnessPendingRef, runtime, samplingProgressRef])

  useEffect(() => {
    const wasActive = previousActiveRef.current
    previousActiveRef.current = active
    if (!active) {
      autoLoadAttemptRef.current = null
      runtime.invalidateFingerprintCheck()
      skipNextPredictionBusyCheckRef.current = false
      setFreshnessPending(true)
    }
    if (wasActive && !active && (busyRef.current || runtime.hasOwnedCalculationDataOperation())) cancelCurrent()
  }, [active, busyRef, cancelCurrent, runtime, setFreshnessPending])

  const reloadData = useCallback(
    async (options: Readonly<{ automatic?: boolean; preserveValidation?: boolean }> = {}) => {
      if (!dataReadable || experimentId === null) {
        setContext(null)
        setStatus(
          experimentId === null
            ? 'Prediction 가능한 Experiment를 선택하세요.'
            : '이 Experiment의 데이터를 읽을 수 없습니다.',
        )
        return
      }
      cancelCurrent()
      const revision = runtime.beginLoad()
      const signal = runtime.loadSignal()
      setFreshnessPending(true)
      startOperation('loading', 'Measurement와 CalculationData를 불러오는 중…')
      try {
        const nextContext = await loadPredictionContextData({
          experimentId,
          queryClient,
          queryScope,
          signal,
        })
        if (!runtime.loadIsCurrent(revision)) return
        runtime.invalidateTransaction()
        runtime.advancePrimaryRevision()
        runtime.abortCalculation()
        runtime.resetWorker()
        const { calculations, measurements } = nextContext
        const readyCalculations = calculations.filter(
          (row) => row.contract_status === 'ready' && row.output_layout && row.source_hash,
        )
        setContext(nextContext)
        clearModelCaches()
        runtime.clearInverseRows()
        setProfiles({})
        setNeighborsByDirection({})
        setLastResult(null)
        setForwardVarsFingerprint(null)
        setForwardFailure(null)
        setInverseVarsFingerprint(null)
        setSurrogateValues({})
        setSurrogateErrors({})
        setCalculationErrors({})
        setDataStale(false)
        setFreshnessPending(false)
        skipNextPredictionBusyCheckRef.current = true
        if (!options.preserveValidation) setValidation(null)
        setSetup((current) => {
          const valid = current.calculationIds.filter((id) => readyCalculations.some((row) => row.id === id))
          const fallback =
            valid.length > 0
              ? valid
              : [
                  selectedCalculationId && readyCalculations.some((row) => row.id === selectedCalculationId)
                    ? selectedCalculationId
                    : readyCalculations[0]?.id,
                ].filter((id): id is number => typeof id === 'number')
          return Object.freeze({
            ...current,
            calculationIds: Object.freeze(fallback),
            calculationWeights: Object.freeze(
              Object.fromEntries(fallback.map((id) => [id, current.calculationWeights[id] ?? 1])),
            ),
          })
        })
        setSetupDraft((current) => {
          const valid = current.calculationIds.filter((id) => readyCalculations.some((row) => row.id === id))
          return Object.freeze({
            ...current,
            calculationIds: Object.freeze(valid),
            calculationWeights: Object.freeze(
              Object.fromEntries(valid.map((id) => [id, current.calculationWeights[id] ?? 1])),
            ),
          })
        })
        setStatus(
          measurements.length
            ? `${measurements.length.toLocaleString()}개 Measurement 준비됨`
            : 'Recorded Measurement가 없습니다.',
        )
        setSetupAppliedRevision((current) => current + 1)
      } catch (cause: unknown) {
        if (!runtime.loadIsCurrent(revision)) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setStatus(message)
        if (options.automatic) setDataStale(true)
        setFreshnessPending(false)
        toast.error(message)
      } finally {
        if (runtime.loadIsCurrent(revision)) finishOperation()
      }
    },
    [
      cancelCurrent,
      clearModelCaches,
      dataReadable,
      experimentId,
      finishOperation,
      queryClient,
      queryScope,
      runtime,
      selectedCalculationId,
      setDataStale,
      setFreshnessPending,
      setStatus,
      startOperation,
    ],
  )

  useLayoutEffect(() => {
    runtime.invalidateValidation()
    runtime.resetWorker()
    clearModelCaches()
    runtime.clearInverseRows()
    setContext(null)
    setValidation(null)
    setDetailsOpen(false)
    calculationValuesRef.current = {}
    setCalculationValues({})
    setCalculationPrimaryRevision((current) => current + 1)
    setCalculationErrors({})
    setSurrogateValues({})
    setSurrogateErrors({})
    setDirection('forward')
    setProfiles({})
    setNeighborsByDirection({})
    activeForwardVarsFingerprintRef.current = null
    setForwardFailure(null)
    if (active) {
      autoLoadAttemptRef.current = `${dataReadable}:${experimentId ?? 'none'}`
      void reloadData()
    }
  }, [experimentId])

  useEffect(() => {
    const loadKey = `${dataReadable}:${experimentId ?? 'none'}`
    if (!active || !dataReadable || context || busy || autoLoadAttemptRef.current === loadKey) return
    autoLoadAttemptRef.current = loadKey
    void reloadData()
  }, [active, busy, context, dataReadable, experimentId, reloadData])

  useEffect(() => {
    if (dataReadable) return
    autoLoadAttemptRef.current = null
    runtime.invalidateLoad()
    cancelCurrent()
    runtime.resetWorker()
    clearModelCaches()
    runtime.clearInverseRows()
    setContext(null)
    calculationValuesRef.current = {}
    setCalculationValues({})
    setCalculationPrimaryRevision((current) => current + 1)
    setCalculationErrors({})
    setSurrogateValues({})
    setSurrogateErrors({})
    setProfiles({})
    setNeighborsByDirection({})
    setLastResult(null)
    setForwardVarsFingerprint(null)
    setForwardFailure(null)
    setInverseVarsFingerprint(null)
    setStatus('Prediction 가능한 Experiment를 선택하세요.')
  }, [cancelCurrent, clearModelCaches, dataReadable, runtime, setStatus])

  const checkDataFingerprint = useCallback(async () => {
    if (!dataReadable || experimentId === null || !context || context.experimentId !== experimentId || busyRef.current)
      return
    setFreshnessPending(true)
    const checkRevision = runtime.nextFingerprintCheck()
    const loadRevision = runtime.currentLoadRevision()
    const signal = runtime.fingerprintSignal()
    try {
      const fingerprint = await loadPredictionContextFingerprint({
        experimentId,
        queryClient,
        queryScope,
        signal,
      })
      if (
        !runtime.fingerprintCheckIsCurrent(checkRevision) ||
        !runtime.loadIsCurrent(loadRevision) ||
        experimentIdRef.current !== experimentId ||
        contextRef.current !== context
      )
        return
      if (fingerprint !== context.fingerprint) {
        setStatus('Measurement 또는 Calculation 변경 감지 · 모델을 자동 갱신하는 중…')
        await reloadData({ automatic: true, preserveValidation: true })
        return
      }
      setFreshnessPending(false)
    } catch {
      if (
        runtime.fingerprintCheckIsCurrent(checkRevision) &&
        runtime.loadIsCurrent(loadRevision) &&
        experimentIdRef.current === experimentId &&
        contextRef.current === context
      ) {
        setDataStale(true)
        setFreshnessPending(false)
        setStatus('Prediction 데이터 최신성을 확인하지 못했습니다. Reload Data를 실행하세요.')
      }
    }
  }, [
    busyRef,
    context,
    dataReadable,
    experimentId,
    queryClient,
    queryScope,
    reloadData,
    runtime,
    setDataStale,
    setFreshnessPending,
    setStatus,
  ])

  useEffect(() => {
    if (!active) return
    void checkDataFingerprint()
    const onFocus = () => void checkDataFingerprint()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, checkDataFingerprint])

  useEffect(() => {
    const mutableDataBusy = workbench.measurementActions.busy || workbench.calculationDataActions.busy
    const wasBusy = previousMutableDataBusyRef.current
    previousMutableDataBusyRef.current = mutableDataBusy
    if (!active) return
    if (mutableDataBusy) {
      runtime.invalidateFingerprintCheck()
      setFreshnessPending(true)
    } else if (wasBusy) void checkDataFingerprint()
  }, [
    active,
    checkDataFingerprint,
    runtime,
    setFreshnessPending,
    workbench.calculationDataActions.busy,
    workbench.measurementActions.busy,
  ])

  useEffect(() => {
    const wasBusy = previousPredictionBusyRef.current
    previousPredictionBusyRef.current = busy
    if (active && wasBusy && !busy && !workbench.measurementActions.busy && !workbench.calculationDataActions.busy) {
      if (skipNextPredictionBusyCheckRef.current) skipNextPredictionBusyCheckRef.current = false
      else void checkDataFingerprint()
    }
  }, [active, busy, checkDataFingerprint, workbench.calculationDataActions.busy, workbench.measurementActions.busy])

  const { forwardOutputs, predictInverse } = usePredictionModels({
    clearModelCaches,
    context,
    experimentId,
    onActivity,
    onForwardRecordProfilesChange: setForwardRecordProfiles,
    onProfile: rememberProfile,
    recordedData: workbench.experimentDocument.simulationProgram?.recordedData ?? Object.freeze({}),
    runtime,
    selectedCalculations,
    setup,
    varsSchema,
  })

  const runForward = useCallback(
    async (vars: Readonly<Vars>) => {
      const expectedFingerprint = candidateFingerprint(vars)
      const document = experimentDocumentRef.current
      if (
        freshnessPendingRef.current ||
        dataStaleRef.current ||
        !context ||
        context.experimentId !== experimentId ||
        !setup.calculationIds.length ||
        document.status !== 'Ready' ||
        document.successfulRevision !== document.revision ||
        candidateFingerprint(document.variables) !== expectedFingerprint ||
        candidateFingerprintRef.current !== expectedFingerprint ||
        activeForwardVarsFingerprintRef.current === expectedFingerprint
      )
        return
      runtime.advancePrimaryRevision()
      const transaction = runtime.beginTransaction()
      activeForwardVarsFingerprintRef.current = expectedFingerprint
      runtime.abortCalculation()
      if (runtime.cancelPendingPrediction()) clearModelCaches()
      setForwardVarsFingerprint(null)
      setForwardFailure(null)
      setInverseVarsFingerprint(null)
      setCalculationErrors({})
      startOperation('forward', 'Forward · RecordedData를 예측하는 중…', { direction: 'forward' })
      try {
        const completed = await forwardOutputs(vars, transaction)
        const completedDocument = experimentDocumentRef.current
        if (
          !predictionForwardResultIsCurrent({
            candidateReady:
              completedDocument.status === 'Ready' &&
              completedDocument.successfulRevision === completedDocument.revision &&
              candidateFingerprint(completedDocument.variables) === expectedFingerprint,
            currentCandidateFingerprint: candidateFingerprintRef.current,
            currentTransaction: runtime.currentTransaction(),
            expectedFingerprint,
            transaction,
          })
        )
          return
        calculationValuesRef.current = completed.calculated.values
        setCalculationValues(completed.calculated.values)
        setCalculationPrimaryRevision((current) => current + 1)
        setCalculationErrors(completed.calculated.errors)
        setSurrogateValues({})
        setSurrogateErrors({})
        setNeighborsByDirection((current) => ({ ...current, forward: completed.result.neighbors }))
        setLastResult(completed.result)
        rememberProfile(completed.model.profile, completed.model.fingerprint)
        const calculationFailure = setup.calculationIds
          .map((id) => completed.calculated.errors[id])
          .find((message): message is string => Boolean(message))
        if (calculationFailure) {
          setForwardFailure(Object.freeze({ fingerprint: expectedFingerprint, message: calculationFailure }))
          setStatus(`Forward 결과 갱신 실패 · ${calculationFailure}`)
          return
        }
        setForwardVarsFingerprint(expectedFingerprint)
        setForwardFailure(null)
        if (userChangedVarsRef.current) setGuideProgress((current) => ({ ...current, forward: true }))
        setInverseVarsFingerprint(null)
        setStatus('Forward 완료 · CalculationData가 최신입니다.')
      } catch (cause: unknown) {
        if (!runtime.transactionIsCurrent(transaction)) return
        if ((cause as { name?: string })?.name === 'AbortError') {
          setStatus('현재 Vars의 Forward 갱신을 다시 예약하는 중…')
          return
        }
        clearModelCaches()
        const message = cause instanceof Error ? cause.message : String(cause)
        setForwardFailure(Object.freeze({ fingerprint: expectedFingerprint, message }))
        setStatus(`Forward 결과 갱신 실패 · ${message}`)
        toast.error(message)
      } finally {
        if (activeForwardVarsFingerprintRef.current === expectedFingerprint) {
          activeForwardVarsFingerprintRef.current = null
        }
        if (runtime.transactionIsCurrent(transaction)) finishOperation()
      }
    },
    [
      clearModelCaches,
      context,
      experimentId,
      finishOperation,
      forwardOutputs,
      rememberProfile,
      runtime,
      setStatus,
      setup.calculationIds,
      startOperation,
    ],
  )

  const runInverse = useCallback(
    async (targets: Readonly<Record<number, CalculationDataOutput>>) => {
      if (
        freshnessPendingRef.current ||
        dataStaleRef.current ||
        !context ||
        context.experimentId !== experimentId ||
        !varsSchema ||
        setup.calculationIds.some((id) => !targets[id])
      )
        return
      runtime.advancePrimaryRevision()
      const transaction = runtime.beginTransaction()
      activeForwardVarsFingerprintRef.current = null
      runtime.abortCalculation()
      if (runtime.cancelPendingPrediction()) clearModelCaches()
      setInverseVarsFingerprint(null)
      setForwardVarsFingerprint(null)
      setForwardFailure(null)
      setSurrogateValues({})
      setSurrogateErrors({})
      startOperation('inverse', 'Inverse · Vars를 예측하는 중…', { direction: 'inverse' })
      try {
        const prediction = await predictInverse(targets, transaction)
        const { model, result } = prediction
        const nextVars = Object.freeze(
          Object.fromEntries(
            result.output.map((sample) => [sample.layout.key, varsTensorFromFlat(sample.values, sample.layout.shape)]),
          ),
        ) as Readonly<Vars>
        const nextFingerprint = candidateFingerprint(nextVars)
        if (!workbench.setCandidateVariables(nextVars, 'prediction-inverse')) {
          throw new Error('Inverse Vars가 현재 varsSchema를 통과하지 못했습니다.')
        }
        suppressedCandidateRef.current = nextFingerprint
        setInverseVarsFingerprint(nextFingerprint)
        setGuideProgress((current) => ({ ...current, inverse: true }))
        setForwardVarsFingerprint(null)
        setNeighborsByDirection((current) => ({ ...current, inverse: result.neighbors }))
        setLastResult(result)
        rememberProfile(model.profile, model.fingerprint)
        setStatus('Inverse 완료 · Viewer를 갱신하고 surrogate를 계산하는 중…')
        try {
          const surrogate = await forwardOutputs(nextVars, transaction)
          if (!runtime.transactionIsCurrent(transaction)) return
          setSurrogateValues(surrogate.calculated.values)
          setSurrogateErrors(surrogate.calculated.errors)
          setStatus(
            Object.keys(surrogate.calculated.errors).length
              ? 'Inverse 완료 · 일부 Forward surrogate Calculation이 실패했습니다.'
              : 'Inverse 완료 · Target은 유지되고 Vars가 적용되었습니다.',
          )
        } catch (cause: unknown) {
          if (!runtime.transactionIsCurrent(transaction)) return
          clearModelCaches()
          setSurrogateValues({})
          setSurrogateErrors({})
          setStatus(`Inverse 완료 · surrogate unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      } catch (cause: unknown) {
        if (!runtime.transactionIsCurrent(transaction) || (cause as { name?: string })?.name === 'AbortError') return
        clearModelCaches()
        const message = cause instanceof Error ? cause.message : String(cause)
        setStatus(message)
        toast.error(message)
      } finally {
        if (runtime.transactionIsCurrent(transaction)) finishOperation()
      }
    },
    [
      clearModelCaches,
      context,
      experimentId,
      finishOperation,
      forwardOutputs,
      predictInverse,
      rememberProfile,
      runtime,
      setStatus,
      setup.calculationIds,
      varsSchema,
      workbench,
      startOperation,
    ],
  )

  useEffect(() => {
    if (
      !active ||
      freshnessPending ||
      dataStale ||
      !contextExperimentMatches ||
      !candidateVars ||
      !setup.calculationIds.length ||
      direction !== 'forward' ||
      validating ||
      retryingValidation ||
      samplingProgress !== null ||
      forwardVarsFingerprint === currentCandidateFingerprint ||
      currentForwardFailure ||
      activeForwardVarsFingerprintRef.current === currentCandidateFingerprint ||
      !candidateEvaluationReady
    )
      return
    if (suppressedCandidateRef.current === currentCandidateFingerprint) {
      suppressedCandidateRef.current = null
      return
    }
    void runForward(candidateVars)
  }, [
    active,
    candidateVars,
    contextExperimentMatches,
    currentCandidateFingerprint,
    currentForwardFailure,
    candidateEvaluationReady,
    dataStale,
    direction,
    forwardVarsFingerprint,
    freshnessPending,
    retryingValidation,
    runForward,
    samplingProgress,
    setup.calculationIds.length,
    validating,
  ])

  const changeCalculationOutput = useCallback(
    (calculationId: number, output: CalculationDataOutput) => {
      if (freshnessPendingRef.current || dataStaleRef.current) return
      runtime.advancePrimaryRevision()
      runtime.invalidateTransaction()
      activeForwardVarsFingerprintRef.current = null
      runtime.abortCalculation()
      if (runtime.cancelPendingPrediction()) clearModelCaches()
      setDirection('inverse')
      setInverseVarsFingerprint(null)
      setForwardVarsFingerprint(null)
      setForwardFailure(null)
      setValidation(null)
      setSurrogateValues({})
      setSurrogateErrors({})
      const next = Object.freeze({ ...calculationValuesRef.current, [calculationId]: output })
      calculationValuesRef.current = next
      setCalculationValues(next)
      if (setup.calculationIds.every((id) => next[id])) void runInverse(next)
      else {
        finishOperation({ status: 'Inverse 대기 · 선택한 모든 CalculationData Target을 채우세요.' })
      }
    },
    [
      clearModelCaches,
      dataStaleRef,
      finishOperation,
      freshnessPendingRef,
      runInverse,
      runtime,
      setDirection,
      setup.calculationIds,
    ],
  )

  const validationDisabledReason = useMemo(() => {
    if (!authenticated) return '로그인 후 검증할 수 있습니다.'
    if (!workbench.experimentManageable) return '이 Experiment의 데이터를 변경할 권한이 없습니다.'
    if (!contextExperimentMatches) return '현재 Experiment의 Prediction 데이터를 불러오는 중입니다.'
    if (freshnessPending) return 'Prediction 데이터 최신성을 확인하는 중입니다.'
    if (!workbench.experimentClean || experimentId === null) return '저장되고 수정되지 않은 Experiment가 필요합니다.'
    if (
      validating ||
      retryingValidation ||
      samplingProgress !== null ||
      workbench.measurementActions.busy ||
      workbench.calculationDataActions.busy
    )
      return '진행 중인 작업이 있습니다.'
    if (dataStale) return 'Prediction 데이터를 Reload하세요.'
    if (!candidateEvaluationReady) return '현재 Candidate를 평가하는 중입니다.'
    if (direction === 'forward' && currentForwardFailure)
      return `Forward 결과 갱신 실패: ${currentForwardFailure.message}`
    if (direction === 'forward' && forwardRefreshState === 'updating')
      return '현재 Vars의 Forward 결과를 갱신하는 중입니다.'
    if (busy) return '진행 중인 작업이 있습니다.'
    if (!workbench.experimentDocument.materialParameters) return '현재 Candidate의 평가 결과가 준비되지 않았습니다.'
    if (workbench.experimentDocument.draftTaskNames.length > 0) {
      return 'Solver가 선택되지 않은 Draft Task가 있어 검증할 수 없습니다.'
    }
    if (setup.calculationIds.some((id) => !calculationValues[id])) return '모든 선택 Calculation의 값이 필요합니다.'
    if (direction === 'inverse' && inverseVarsFingerprint !== currentCandidateFingerprint)
      return '현재 Vars가 최신 Inverse 결과가 아닙니다.'
    return undefined
  }, [
    authenticated,
    busy,
    candidateEvaluationReady,
    calculationValues,
    contextExperimentMatches,
    currentForwardFailure,
    currentCandidateFingerprint,
    dataStale,
    direction,
    experimentId,
    forwardRefreshState,
    freshnessPending,
    inverseVarsFingerprint,
    retryingValidation,
    samplingProgress,
    setup.calculationIds,
    validating,
    workbench.calculationDataActions.busy,
    workbench.experimentDocument.draftTaskNames,
    workbench.experimentDocument.materialParameters,
    workbench.experimentClean,
    workbench.measurementActions.busy,
    workbench.experimentManageable,
  ])

  const samplingDisabledReason = useMemo(() => {
    if (!authenticated) return '로그인 후 sampling할 수 있습니다.'
    if (!workbench.experimentManageable) return '이 Experiment의 데이터를 변경할 권한이 없습니다.'
    if (!contextExperimentMatches || !varsSchema) return '현재 Experiment의 Prediction 데이터를 불러오는 중입니다.'
    if (freshnessPending) return 'Prediction 데이터 최신성을 확인하는 중입니다.'
    if (!workbench.experimentClean || experimentId === null) return '저장되고 수정되지 않은 Experiment가 필요합니다.'
    if (busy || workbench.measurementActions.busy || workbench.calculationDataActions.busy)
      return '진행 중인 작업이 있습니다.'
    if (dataStale) return 'Prediction 데이터를 Reload하세요.'
    if (workbench.measurementActions.pendingRecordMeasurementId) return 'RecordedData 저장을 먼저 다시 시도하세요.'
    if (workbench.experimentDocument.draftTaskNames.length > 0) return 'Solver가 선택되지 않은 Draft Task가 있습니다.'
    let active = false
    for (const [key, entry] of Object.entries(varsSchema)) {
      const range = effectiveSamplingRanges[key]
      if (
        !range ||
        !Number.isFinite(range.min) ||
        !Number.isFinite(range.max) ||
        range.min < entry.min ||
        range.max > entry.max ||
        range.min > range.max
      ) {
        return `${key} sampling 범위가 schema 범위 안의 올바른 Min/Max여야 합니다.`
      }
      if (range.min < range.max) active = true
    }
    if (!active) return 'Sampling 범위가 고정되지 않은 Vars가 하나 이상 필요합니다.'
    return undefined
  }, [
    authenticated,
    busy,
    contextExperimentMatches,
    dataStale,
    effectiveSamplingRanges,
    experimentId,
    freshnessPending,
    varsSchema,
    workbench.calculationDataActions.busy,
    workbench.experimentClean,
    workbench.experimentDocument.draftTaskNames,
    workbench.experimentManageable,
    workbench.measurementActions.busy,
    workbench.measurementActions.pendingRecordMeasurementId,
  ])

  const sampleAndRun = useCallback(
    async (total: number) => {
      if (samplingDisabledReason) {
        toast.error(samplingDisabledReason)
        return
      }
      if (!Number.isSafeInteger(total) || total <= 0 || !runtime.workerAvailable || !context || !varsSchema) {
        toast.error('Sampling N은 양의 JavaScript safe integer여야 합니다.')
        return
      }
      const revision = runtime.beginSampling()
      const sessionId = crypto.randomUUID()
      const fingerprint = predictionFingerprint([
        'prediction-sampling',
        context.fingerprint,
        sourceIdentity,
        effectiveSamplingRanges,
        total,
      ])
      const centers = context.measurements.flatMap((measurement) => {
        try {
          return [predictionVarsSamples(measurement.vars as Readonly<Vars>, varsSchema)]
        } catch {
          return []
        }
      })
      let successes = 0
      let failures = 0
      let recorded = 0
      let attempted = 0
      let stoppedReason: string | null = null
      activeForwardVarsFingerprintRef.current = null
      runtime.resetWorker()
      clearModelCaches()
      setForwardFailure(null)
      startOperation('sampling', 'Sampling 후보 안전 예산을 확인하는 중…', {
        samplingProgress: {
          attempt: 0,
          failures: 0,
          phase: 'sampling',
          recorded: 0,
          sessionId,
          successes: 0,
          total,
        },
      })
      setValidation(null)
      try {
        const profile = await runtime.startSampling(sessionId, {
          fingerprint,
          totalAttempts: total,
          layouts: predictionVarsLayouts(varsSchema),
          ranges: effectiveSamplingRanges,
          centers,
        })
        if (!runtime.samplingIsCurrent(revision)) return
        onActivity?.({
          source: 'prediction',
          level: 'info',
          phase: 'sampling',
          message: `[Sampling] ${profile.existingCenterCount.toLocaleString()} centers · ${profile.candidateCount.toLocaleString()} candidates/window · ${profile.activeComponentCount.toLocaleString()} active components`,
        })
        for (let attempt = 1; attempt <= total; attempt += 1) {
          if (!runtime.samplingIsCurrent(revision)) break
          if (sourceIdentityRef.current !== sourceIdentity) {
            stoppedReason = 'Experiment 또는 source가 변경되었습니다.'
            break
          }
          attempted = attempt
          setSamplingProgress({ attempt, failures, phase: 'sampling', recorded, sessionId, successes, total })
          setStatus(`${attempt}/${total} · Sampling 후보 선택 · 성공 ${successes} · 실패 ${failures}`)
          let sample: readonly import('./knn').PredictionTensorSample[] | null = null
          try {
            sample = await runtime.nextSample(sessionId, fingerprint, attempt)
            if (!runtime.samplingIsCurrent(revision)) break
            const nextVars = Object.freeze(
              Object.fromEntries(
                sample.map((entry) => [entry.layout.key, varsTensorFromFlat(entry.values, entry.layout.shape)]),
              ),
            ) as Readonly<Vars>
            const expectedFingerprint = candidateFingerprint(nextVars)
            const baselineRevision = experimentDocumentRef.current.revision
            setSamplingProgress({ attempt, failures, phase: 'candidate', recorded, sessionId, successes, total })
            setStatus(`${attempt}/${total} · Candidate 평가 · 성공 ${successes} · 실패 ${failures}`)
            suppressedCandidateRef.current = expectedFingerprint
            if (!setCandidateVariablesRef.current(nextVars, 'prediction-sampling')) {
              throw new Error('Sampling Candidate Vars를 적용하지 못했습니다.')
            }
            await new Promise<void>((resolve, reject) => {
              const deadline = Date.now() + Math.max(30_000, experimentDocumentRef.current.evaluationTimeoutMs + 15_000)
              let observedExpectedCandidate = false
              let timer: number | null = null
              let settled = false
              const finish = (callback: () => void) => {
                if (settled) return
                settled = true
                if (timer !== null) window.clearTimeout(timer)
                runtime.clearSamplingCandidateWait(cancelWait)
                callback()
              }
              const cancelWait = () =>
                finish(() => reject(new DOMException('Sampling이 취소되었습니다.', 'AbortError')))
              runtime.setSamplingCandidateWait(cancelWait)
              const poll = () => {
                timer = null
                const document = experimentDocumentRef.current
                const currentVars = candidateVarsRef.current
                const waitResult = predictionSamplingCandidateWaitResult({
                  baselineRevision,
                  cancelRequested: !runtime.samplingIsCurrent(revision),
                  currentCandidateFingerprint: candidateFingerprint(currentVars),
                  deadline,
                  documentCandidateFingerprint: candidateFingerprint(document.variables),
                  documentRevision: document.revision,
                  documentStatus: document.status,
                  expectedFingerprint,
                  now: Date.now(),
                  observedExpectedCandidate,
                  sourceChanged: sourceIdentityRef.current !== sourceIdentity,
                  successfulRevision: document.successfulRevision,
                })
                observedExpectedCandidate = waitResult.observedExpectedCandidate
                if (waitResult.state === 'ready') {
                  finish(() => resolve())
                  return
                }
                if (waitResult.state === 'cancelled') {
                  cancelWait()
                  return
                }
                if (waitResult.state === 'source-changed') {
                  finish(() => reject(new Error('Experiment 또는 source가 변경되어 Sampling을 중단합니다.')))
                  return
                }
                if (waitResult.state === 'error') {
                  finish(() => reject(new Error(document.error?.message ?? 'Sampling Candidate 평가에 실패했습니다.')))
                  return
                }
                if (waitResult.state === 'replaced') {
                  finish(() => reject(new Error('Sampling Candidate가 다른 Candidate로 교체되었습니다.')))
                  return
                }
                if (waitResult.state === 'timeout') {
                  finish(() => reject(new Error('Sampling Candidate 평가 제한 시간을 초과했습니다.')))
                  return
                }
                timer = window.setTimeout(poll, 50)
              }
              poll()
            })
            if (!runtime.samplingIsCurrent(revision)) break
            setSamplingProgress({ attempt, failures, phase: 'simulation', recorded, sessionId, successes, total })
            setStatus(`${attempt}/${total} · Simulation 및 RecordedData 저장 · 성공 ${successes} · 실패 ${failures}`)
            const completion = await measurementActionsRef.current.saveAndRunCurrentAsync()
            if (!runtime.samplingIsCurrent(revision)) break
            recorded += 1
            await runtime.acceptSample(sessionId, fingerprint, sample)
            if (completion.calculationSummary.failed === 0 && !completion.calculationSummary.cancelled) successes += 1
            else failures += 1
            setSamplingProgress({ attempt, failures, phase: 'sampling', recorded, sessionId, successes, total })
            setStatus(`${attempt}/${total} · 시도 완료 · 성공 ${successes} · 실패 ${failures}`)
          } catch (cause: unknown) {
            if (!runtime.samplingIsCurrent(revision) || (cause as { name?: string })?.name === 'AbortError') break
            failures += 1
            const message = cause instanceof Error ? cause.message : String(cause)
            const saveBlocked =
              Boolean(measurementActionsRef.current.pendingRecordMeasurementId) ||
              /RecordedData.*저장|저장.*RecordedData/.test(message)
            onActivity?.({
              source: 'prediction',
              level: 'error',
              phase: 'sampling',
              message: `[Sampling ${attempt}/${total}] ${message}`,
            })
            setSamplingProgress({ attempt, failures, phase: 'candidate', recorded, sessionId, successes, total })
            setStatus(`${attempt}/${total} · Candidate 실패 · 성공 ${successes} · 실패 ${failures} · ${message}`)
            if (saveBlocked || sourceIdentityRef.current !== sourceIdentity) {
              stoppedReason = message
              setStatus(`${attempt}/${total} · Sampling 중단 · ${message}`)
              break
            }
          }
        }
      } catch (cause: unknown) {
        if (runtime.samplingIsCurrent(revision) && (cause as { name?: string })?.name !== 'AbortError') {
          const message = cause instanceof Error ? cause.message : String(cause)
          setStatus(`Sampling 실패 · ${message}`)
          toast.error(message)
        }
      } finally {
        if (runtime.finishSampling(revision)) {
          setSamplingProgress({
            attempt: Math.min(total, samplingProgressRef.current?.attempt ?? total),
            failures,
            phase: 'stopping',
            recorded,
            sessionId,
            successes,
            total,
          })
          await runtime.dropSampling(sessionId).catch(() => undefined)
          clearModelCaches()
          setForwardVarsFingerprint(null)
          setForwardFailure(null)
          setInverseVarsFingerprint(null)
          if (recorded > 0) setFreshnessPending(true)
          else setFreshnessPending(false)
          finishOperation({
            clearSampling: true,
            status: stoppedReason
              ? `Sampling 중단 · ${attempted}/${total}회 · 성공 ${successes} · 실패 ${failures} · ${stoppedReason}`
              : `Sampling 완료 · ${attempted}/${total}회 · 성공 ${successes} · 실패 ${failures} · Recorded ${recorded}`,
          })
          if (recorded === 0) skipNextPredictionBusyCheckRef.current = true
          if (recorded === 0 && candidateVarsRef.current) {
            window.setTimeout(() => void runForward(candidateVarsRef.current!), 0)
          }
        }
      }
    },
    [
      clearModelCaches,
      context,
      effectiveSamplingRanges,
      finishOperation,
      onActivity,
      runForward,
      runtime,
      samplingDisabledReason,
      setFreshnessPending,
      setSamplingProgress,
      setStatus,
      sourceIdentity,
      startOperation,
      varsSchema,
      workbench,
    ],
  )

  useEffect(() => {
    if (!samplingProgress || samplingProgress.phase !== 'simulation' || !workbench.measurementActions.stage) return
    setStatus(
      `${samplingProgress.attempt}/${samplingProgress.total} · ${workbench.measurementActions.stage} · 성공 ${samplingProgress.successes} · 실패 ${samplingProgress.failures}`,
    )
  }, [samplingProgress, workbench.measurementActions.stage])

  const validatePrediction = useCallback(async () => {
    if (freshnessPendingRef.current) {
      toast.error('Prediction 데이터 최신성을 확인하는 중입니다.')
      return
    }
    if (validationDisabledReason) {
      toast.error(validationDisabledReason)
      return
    }
    const validationRevision = runtime.beginValidation()
    const validationSignal = runtime.validationSignal()
    const calculationIds = Object.freeze([...setup.calculationIds])
    const reference = Object.freeze({ ...calculationValues })
    const frozenDirection = direction
    const frozenProfile = profile
    const frozenModelFingerprint = runtime.cachedModel(direction)?.fingerprint ?? null
    const frozenPrimaryRevision = runtime.currentPrimaryRevision()
    const frozenRepredicted = Object.freeze(frozenDirection === 'inverse' ? { ...surrogateValues } : {})
    const frozenSetup = setup
    const frozenTransactionId = runtime.currentTransaction()
    startOperation('validation', 'Validation · Candidate 저장과 Simulation 실행 중…')
    setSetupOpen(false)
    setDetailsDirection(frozenDirection)
    let datasetMutated = false
    try {
      const sourceFingerprintEntries = Object.freeze(
        await Promise.all(
          selectedCalculations.map(
            async (calculation) => [calculation.id, await calculationSourceHash(calculation.source_code)] as const,
          ),
        ),
      )
      if (!runtime.validationIsCurrent(validationRevision)) return
      if (candidateFingerprintRef.current !== currentCandidateFingerprint) {
        throw new Error('Validation 준비 중 Candidate Vars가 변경되었습니다. 다시 시도하세요.')
      }
      const sourceFingerprints = new Map(sourceFingerprintEntries)
      const snapshotFingerprint = predictionFingerprint([
        frozenDirection,
        currentCandidateFingerprint,
        frozenPrimaryRevision,
        frozenTransactionId,
        calculationIds,
        reference,
        frozenRepredicted,
        sourceFingerprintEntries,
        frozenSetup,
        frozenModelFingerprint,
      ])
      const completion = await workbench.measurementActions.saveAndRunCurrentAsync()
      if (!runtime.validationIsCurrent(validationRevision)) return
      datasetMutated = true
      const { actual, currentSourceFingerprints } = await loadPredictionValidationData({
        calculationIds,
        experimentId: experimentId!,
        measurementId: completion.measurementId,
        queryClient,
        queryScope,
        signal: validationSignal,
      })
      if (!runtime.validationIsCurrent(validationRevision)) return
      const byCalculation = new Map(actual.map((record) => [record.calculation_id, record]))
      const rows = calculationIds.map((calculationId): ValidationRow => {
        const record = byCalculation.get(calculationId)
        if (sourceFingerprints.get(calculationId) !== currentSourceFingerprints.get(calculationId)) {
          return Object.freeze({
            actual: record?.data ?? null,
            calculationId,
            metric: null,
            error: 'Calculation source가 Validation snapshot과 다릅니다.',
            reference: reference[calculationId],
          })
        }
        if (!record) {
          return Object.freeze({
            actual: null,
            calculationId,
            metric: null,
            error: '실제 CalculationData가 저장되지 않았습니다.',
            reference: reference[calculationId],
          })
        }
        return Object.freeze({
          actual: record.data,
          calculationId,
          metric: comparePredictionOutput(reference[calculationId], record.data),
          error: null,
          reference: reference[calculationId],
        })
      })
      const failed = rows.filter((row) => row.error || !row.metric?.compatible).length
      const aggregateError =
        frozenDirection === 'inverse' && frozenProfile?.direction === 'inverse'
          ? inverseValidationAggregateErrorFromScales(
              rows,
              frozenSetup.calculationWeights,
              frozenProfile.inputLayouts,
              frozenProfile.inputScales,
            )
          : null
      const summary = `Measurement #${completion.measurementId} · ${frozenDirection} 검증 · ${rows.length - failed}/${rows.length}개 비교 완료${aggregateError === null ? '' : ` · Aggregate ${aggregateError.toPrecision(5)}`}`
      setValidation(
        Object.freeze({
          aggregateError,
          candidateVarsFingerprint: currentCandidateFingerprint,
          calculationWeights: frozenSetup.calculationWeights,
          direction: frozenDirection,
          experimentId: experimentId!,
          inverseInputLayouts:
            frozenDirection === 'inverse' && frozenProfile?.direction === 'inverse' ? frozenProfile.inputLayouts : null,
          inverseInputScales:
            frozenDirection === 'inverse' && frozenProfile?.direction === 'inverse' ? frozenProfile.inputScales : null,
          measurementId: completion.measurementId,
          primaryRevision: frozenPrimaryRevision,
          repredicted: frozenRepredicted,
          rows: Object.freeze(rows),
          snapshotFingerprint,
          sourceFingerprints: Object.freeze(Object.fromEntries(sourceFingerprintEntries)),
          setupFingerprint: predictionFingerprint([frozenSetup]),
          summary,
          transactionId: frozenTransactionId,
        }),
      )
      setStatus(summary)
      runtime.resetWorker()
      clearModelCaches()
      setForwardVarsFingerprint(null)
      setForwardFailure(null)
      setInverseVarsFingerprint(null)
      setFreshnessPending(true)
    } catch (cause: unknown) {
      if (!runtime.validationIsCurrent(validationRevision)) return
      if (datasetMutated) {
        runtime.resetWorker()
        clearModelCaches()
        setForwardVarsFingerprint(null)
        setForwardFailure(null)
        setInverseVarsFingerprint(null)
        setFreshnessPending(true)
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      setStatus(`Validation 실패 · ${message}`)
      toast.error(message)
    } finally {
      if (runtime.finishValidation(validationRevision)) finishOperation()
    }
  }, [
    calculationValues,
    clearModelCaches,
    direction,
    experimentId,
    finishOperation,
    profile,
    queryClient,
    queryScope,
    runtime,
    selectedCalculations,
    setFreshnessPending,
    setStatus,
    setup,
    setup.calculationIds,
    startOperation,
    surrogateValues,
    validationDisabledReason,
    workbench.measurementActions,
  ])

  const retryValidationCalculations = useCallback(async () => {
    if (
      !validation ||
      experimentId === null ||
      validation.experimentId !== experimentId ||
      !contextExperimentMatches ||
      !workbench.experimentManageable ||
      busyRef.current ||
      freshnessPendingRef.current ||
      !validation.rows.some((row) => row.error)
    )
      return
    const validationRevision = runtime.beginValidation()
    const validationSignal = runtime.validationSignal()
    const calculationIds = Object.freeze(validation.rows.map((row) => row.calculationId))
    startOperation('validation-retry', `Validation · Measurement #${validation.measurementId} Calculation 재시도 중…`)
    try {
      runtime.setCalculationDataOperationOwned(true)
      await workbench.calculationDataActions.calculateMeasurement(validation.measurementId, { announce: true })
      runtime.setCalculationDataOperationOwned(false)
      if (!runtime.validationIsCurrent(validationRevision)) return
      const { actual, currentSourceFingerprints } = await loadPredictionValidationData({
        calculationIds,
        experimentId,
        measurementId: validation.measurementId,
        queryClient,
        queryScope,
        signal: validationSignal,
      })
      if (!runtime.validationIsCurrent(validationRevision)) return
      const byCalculation = new Map(actual.map((record) => [record.calculation_id, record]))
      const rows = validation.rows.map((previous): ValidationRow => {
        const record = byCalculation.get(previous.calculationId)
        if (
          validation.sourceFingerprints[previous.calculationId] !==
          currentSourceFingerprints.get(previous.calculationId)
        ) {
          return Object.freeze({
            ...previous,
            actual: record?.data ?? null,
            metric: null,
            error: 'Calculation source가 Validation snapshot과 다릅니다.',
          })
        }
        if (!record) {
          return Object.freeze({
            ...previous,
            actual: null,
            metric: null,
            error: '실제 CalculationData가 저장되지 않았습니다.',
          })
        }
        return Object.freeze({
          ...previous,
          actual: record.data,
          metric: comparePredictionOutput(previous.reference, record.data),
          error: null,
        })
      })
      const failed = rows.filter((row) => row.error || !row.metric?.compatible).length
      const aggregateError =
        validation.direction === 'inverse' && validation.inverseInputLayouts && validation.inverseInputScales
          ? inverseValidationAggregateErrorFromScales(
              rows,
              validation.calculationWeights,
              validation.inverseInputLayouts,
              validation.inverseInputScales,
            )
          : null
      const summary = `Measurement #${validation.measurementId} · ${validation.direction} 검증 · ${rows.length - failed}/${rows.length}개 비교 완료${aggregateError === null ? '' : ` · Aggregate ${aggregateError.toPrecision(5)}`}`
      setValidation(
        Object.freeze({
          ...validation,
          aggregateError,
          rows: Object.freeze(rows),
          summary,
        }),
      )
      setStatus(summary)
    } catch (cause: unknown) {
      if (!runtime.validationIsCurrent(validationRevision)) return
      const message = cause instanceof Error ? cause.message : String(cause)
      setStatus(`Calculation 재시도 실패 · ${message}`)
      toast.error(message)
    } finally {
      if (runtime.finishValidation(validationRevision)) {
        runtime.setCalculationDataOperationOwned(false)
        finishOperation()
      }
    }
  }, [
    contextExperimentMatches,
    experimentId,
    finishOperation,
    freshnessPendingRef,
    queryClient,
    queryScope,
    runtime,
    setStatus,
    startOperation,
    validation,
    workbench.calculationDataActions,
    workbench.experimentManageable,
  ])

  useEffect(() => {
    if (!command) return
    if (command.type === 'settings') {
      setSetupDraft(setup)
      setSetupOpen(true)
    } else if (command.type === 'details') {
      setDetailsDirection(direction)
      setDetailsOpen(true)
    } else if (command.type === 'cancel') {
      suppressedCandidateRef.current = currentCandidateFingerprint
      if (direction === 'forward' && forwardVarsFingerprint !== currentCandidateFingerprint) {
        setForwardFailure(
          Object.freeze({ fingerprint: currentCandidateFingerprint, message: '사용자가 Forward 갱신을 취소했습니다.' }),
        )
      }
      cancelCurrent()
    } else if (command.type === 'sample') void sampleAndRun(command.sampleCount ?? 10)
    else void validatePrediction()
  }, [command?.id])

  const setupDraftError = useMemo(() => {
    if (!setupDraft.calculationIds.length) return 'Calculation을 하나 이상 선택하세요.'
    if (
      setupDraft.calculationIds.some(
        (id) => context?.calculations.find((calculation) => calculation.id === id)?.contract_status !== 'ready',
      )
    ) {
      return '선택한 Calculation을 Calculation 탭에서 preflight 후 다시 저장하세요.'
    }
    const weights = setupDraft.calculationIds.map((id) => setupDraft.calculationWeights[id] ?? 1)
    if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
      return 'Calculation weight는 유한한 0 이상의 수여야 합니다.'
    }
    if (!weights.some((weight) => weight > 0)) return 'Calculation weight 중 하나 이상은 양수여야 합니다.'
    if (
      setupDraft.kMode === 'manual' &&
      (!Number.isSafeInteger(setupDraft.manualK) ||
        setupDraft.manualK < 1 ||
        setupDraft.manualK > (context?.measurements.length ?? 0))
    ) {
      return `Manual k는 1..${(context?.measurements.length ?? 0).toLocaleString()} 범위의 정수여야 합니다.`
    }
    return null
  }, [context?.measurements.length, setupDraft])
  const setupDraftApplied = predictionFingerprint([setupDraft]) === predictionFingerprint([setup])

  const initializeMissingInverseTargets = useCallback(async () => {
    const missingIds = setup.calculationIds.filter((id) => !calculationValuesRef.current[id])
    if (!missingIds.length) {
      await runInverse(calculationValuesRef.current)
      return
    }
    if (!candidateVars) {
      setCalculationErrors(Object.freeze(Object.fromEntries(missingIds.map((id) => [id, 'Target이 필요합니다.']))))
      setStatus('새 Calculation의 Target을 초기화할 Candidate가 없습니다.')
      return
    }
    const transaction = runtime.beginTransaction()
    activeForwardVarsFingerprintRef.current = null
    runtime.abortCalculation()
    if (runtime.cancelPendingPrediction()) clearModelCaches()
    setForwardFailure(null)
    startOperation('initializing-targets', '새 Calculation Target을 현재 Candidate의 Forward 예측으로 초기화하는 중…')
    try {
      const completed = await forwardOutputs(candidateVars, transaction)
      if (!runtime.transactionIsCurrent(transaction)) return
      const nextValues = { ...calculationValuesRef.current }
      const nextErrors: Record<number, string> = {}
      missingIds.forEach((id) => {
        if (completed.calculated.values[id]) nextValues[id] = completed.calculated.values[id]
        else nextErrors[id] = completed.calculated.errors[id] ?? 'Forward 예측 Target을 만들지 못했습니다.'
      })
      const frozen = Object.freeze(nextValues)
      calculationValuesRef.current = frozen
      setCalculationValues(frozen)
      setCalculationErrors(Object.freeze(nextErrors))
      if (setup.calculationIds.every((id) => frozen[id])) await runInverse(frozen)
      else setStatus('일부 새 Calculation Target을 초기화하지 못했습니다. 해당 Calculation을 확인하세요.')
    } catch (cause: unknown) {
      if (!runtime.transactionIsCurrent(transaction) || (cause as { name?: string })?.name === 'AbortError') return
      const message = cause instanceof Error ? cause.message : String(cause)
      setCalculationErrors(Object.freeze(Object.fromEntries(missingIds.map((id) => [id, message]))))
      setStatus(message)
      toast.error(message)
    } finally {
      if (runtime.transactionIsCurrent(transaction)) finishOperation()
    }
  }, [
    candidateVars,
    clearModelCaches,
    finishOperation,
    forwardOutputs,
    runInverse,
    runtime,
    setStatus,
    setup.calculationIds,
    startOperation,
  ])

  const applySetup = useCallback(() => {
    if (freshnessPendingRef.current || dataStaleRef.current) return
    if (setupDraftError) {
      toast.error(setupDraftError)
      return
    }
    cancelCurrent()
    runtime.resetWorker()
    setSetup(setupDraft)
    setSetupOpen(false)
    clearModelCaches()
    setProfiles({})
    setNeighborsByDirection({})
    runtime.clearInverseRows()
    activeForwardVarsFingerprintRef.current = null
    setForwardFailure(null)
    setSetupAppliedRevision((current) => current + 1)
  }, [cancelCurrent, clearModelCaches, dataStaleRef, freshnessPendingRef, runtime, setupDraft, setupDraftError])

  useEffect(() => {
    if (!setupAppliedRevision || !context) return
    if (direction === 'inverse') {
      void initializeMissingInverseTargets()
    } else if (candidateVars) {
      void runForward(candidateVars)
    }
  }, [setupAppliedRevision])

  const calculateMissing = useCallback(async () => {
    if (
      busyRef.current ||
      freshnessPendingRef.current ||
      dataStaleRef.current ||
      !contextExperimentMatches ||
      !workbench.experimentManageable ||
      workbench.measurementActions.busy ||
      workbench.calculationDataActions.busy
    )
      return
    const operationRevision = runtime.currentLoadRevision()
    setSetupBusyAction('calculate-missing')
    startOperation('calculating-missing', 'Prediction cohort의 누락 CalculationData를 계산하는 중…')
    runtime.setCalculationDataOperationOwned(true)
    try {
      for (const calculationId of setupDraft.calculationIds) {
        const summary = await workbench.calculationDataActions.calculateSelected(calculationId)
        if (!runtime.loadIsCurrent(operationRevision) || summary.cancelled) return
      }
      runtime.setCalculationDataOperationOwned(false)
      if (!runtime.loadIsCurrent(operationRevision)) return
      await reloadData()
    } finally {
      runtime.setCalculationDataOperationOwned(false)
      setSetupBusyAction(null)
      if (runtime.loadIsCurrent(operationRevision)) finishOperation()
    }
  }, [
    busyRef,
    contextExperimentMatches,
    dataStaleRef,
    finishOperation,
    freshnessPendingRef,
    reloadData,
    runtime,
    setupDraft.calculationIds,
    startOperation,
    workbench.calculationDataActions,
    workbench.experimentManageable,
    workbench.measurementActions.busy,
  ])

  const reloadFromSetup = useCallback(async () => {
    setSetupBusyAction('reload')
    try {
      await reloadData()
    } finally {
      setSetupBusyAction(null)
    }
  }, [reloadData])

  useEffect(() => {
    onChromeStateChange({
      busy,
      canSample: samplingDisabledReason === undefined,
      canValidate: validationDisabledReason === undefined,
      direction,
      sampleDisabledReason: samplingDisabledReason,
      status,
      validateDisabledReason: validationDisabledReason,
    })
  }, [busy, direction, onChromeStateChange, samplingDisabledReason, status, validationDisabledReason])

  const paneItems = useMemo<readonly PredictionCalculationPaneItem[]>(
    () =>
      selectedCalculations.map((calculation) => {
        const committedOutput = calculationValues[calculation.id] ?? null
        const output =
          committedOutput ?? (calculation.output_layout ? calculationPlaceholder(calculation.output_layout) : null)
        const validationSnapshotCurrent =
          validation?.direction === direction &&
          validation.experimentId === experimentId &&
          validation.candidateVarsFingerprint === currentCandidateFingerprint &&
          validation.setupFingerprint === predictionFingerprint([setup])
            ? validation
            : null
        const candidateValidationRow = validationSnapshotCurrent?.rows.find(
          (row) => row.calculationId === calculation.id,
        )
        const validationRow =
          committedOutput &&
          candidateValidationRow &&
          predictionFingerprint([candidateValidationRow.reference]) === predictionFingerprint([committedOutput])
            ? candidateValidationRow
            : null
        const repredictedOutput =
          direction === 'inverse'
            ? (validationSnapshotCurrent?.repredicted[calculation.id] ?? surrogateValues[calculation.id] ?? null)
            : null
        const repredictedMetric =
          committedOutput && repredictedOutput ? comparePredictionOutput(committedOutput, repredictedOutput) : null
        const repredictedStatus =
          direction !== 'inverse'
            ? 'unavailable'
            : repredictedOutput
              ? repredictedMetric?.compatible
                ? 'ready'
                : 'incompatible'
              : busy
                ? 'updating'
                : 'unavailable'
        const actualStatus =
          validating || retryingValidation
            ? 'updating'
            : validationRow?.error
              ? 'unavailable'
              : validationRow?.actual
                ? validationRow.metric?.compatible
                  ? 'ready'
                  : 'incompatible'
                : 'unavailable'
        const actualOutput = actualStatus === 'ready' ? validationRow?.actual : null
        const [minimum, maximum] = predictionOutputRange([output])
        const [constraintMinimum, constraintMaximum] = output
          ? (integerRanges[output.dtype] ??
            (output.dtype === 'float32'
              ? [-3.402_823_466_385_288_6e38, 3.402_823_466_385_288_6e38]
              : [-Number.MAX_VALUE, Number.MAX_VALUE]))
          : [-Number.MAX_VALUE, Number.MAX_VALUE]
        const primaryStatus =
          direction === 'forward'
            ? forwardRefreshState === 'ready'
              ? committedOutput
                ? ('ready' as const)
                : ('unavailable' as const)
              : forwardRefreshState === 'failed'
                ? ('unavailable' as const)
                : ('updating' as const)
            : committedOutput
              ? ('ready' as const)
              : busy
                ? ('updating' as const)
                : ('unavailable' as const)
        const primaryError =
          calculationErrors[calculation.id] ??
          (direction === 'forward'
            ? forwardRefreshState === 'waiting-candidate'
              ? '현재 Candidate를 평가하는 중입니다.'
              : forwardRefreshState === 'updating'
                ? '현재 Vars의 Forward 결과를 갱신하는 중입니다.'
                : forwardRefreshState === 'failed'
                  ? (currentForwardFailure?.message ?? 'Forward 결과 갱신에 실패했습니다.')
                  : committedOutput
                    ? null
                    : 'Prediction 결과가 없습니다.'
            : committedOutput
              ? null
              : busy
                ? 'Prediction 결과를 계산하는 중입니다.'
                : 'Prediction 결과가 없습니다.')
        return Object.freeze({
          actual: Object.freeze({
            error:
              validating || retryingValidation
                ? null
                : (validationRow?.error ?? validationRow?.metric?.message ?? null),
            metric: validationRow?.metric ?? null,
            output: actualOutput ?? null,
            snapshotKey: validationSnapshotCurrent?.snapshotFingerprint ?? null,
            status: actualStatus,
          }),
          calculationId: calculation.id,
          constraintMinimum,
          constraintMaximum,
          name: calculation.name,
          primary: Object.freeze({
            output,
            role: direction === 'forward' ? 'predicted' : 'target',
            status: primaryStatus,
          }),
          error: primaryError,
          extrapolated:
            direction === 'inverse' &&
            Boolean(lastResult?.extrapolatedInputKeys.includes(`calculation:${calculation.id}`)),
          minimum,
          maximum,
          ...(direction === 'inverse'
            ? {
                repredicted: Object.freeze({
                  error:
                    repredictedStatus === 'incompatible'
                      ? repredictedMetric?.message
                      : (surrogateErrors[calculation.id] ?? null),
                  metric: repredictedMetric,
                  output: repredictedStatus === 'ready' ? repredictedOutput : null,
                  snapshotKey:
                    validationSnapshotCurrent?.snapshotFingerprint ?? `transaction:${runtime.currentTransaction()}`,
                  status: repredictedStatus,
                }),
              }
            : {}),
        })
      }),
    [
      busy,
      calculationErrors,
      calculationValues,
      currentCandidateFingerprint,
      currentForwardFailure,
      direction,
      experimentId,
      forwardRefreshState,
      lastResult,
      retryingValidation,
      runtime,
      selectedCalculations,
      setup,
      surrogateErrors,
      surrogateValues,
      validation,
      validating,
    ],
  )

  const validationText = validation
    ? [
        validation.summary,
        ...(validation.aggregateError === null
          ? []
          : [`Inverse normalized aggregate error: ${validation.aggregateError.toPrecision(7)}`]),
        ...validation.rows.map((row) => {
          const calculation = context?.calculations.find((item) => item.id === row.calculationId)
          if (row.error) return `${calculation?.name ?? `#${row.calculationId}`}: ${row.error}`
          if (!row.metric?.compatible) return `${calculation?.name ?? `#${row.calculationId}`}: ${row.metric?.message}`
          if (row.reference.shape.length === 0) {
            return `${calculation?.name ?? `#${row.calculationId}`}: Reference ${String(row.reference.data)}, Actual ${String(row.actual?.data)}, Abs ${row.metric.maxAbsoluteError?.toPrecision(5)}${row.metric.relativeError === null ? '' : `, Rel ${(row.metric.relativeError! * 100).toPrecision(5)}%`}`
          }
          return `${calculation?.name ?? `#${row.calculationId}`}: MAE ${row.metric.mae?.toPrecision(5)}, RMSE ${row.metric.rmse?.toPrecision(5)}, Max ${row.metric.maxAbsoluteError?.toPrecision(5)}`
        }),
      ].join('\n')
    : null

  const modelWarningText = useMemo(() => {
    const warnings: string[] = []
    if (profile && profile.rowCount < 3) {
      warnings.push(`신뢰도 경고: compatible Measurement가 ${profile.rowCount}개뿐입니다.`)
    }
    if (profile?.activeInputBlockCount === 0) {
      warnings.push('신뢰도 경고: 선택한 cohort의 모든 입력 component가 상수라 전체 cohort 평균을 사용합니다.')
    }
    if (lastResult?.extrapolatedInputKeys.length) {
      warnings.push(`학습 범위 밖 입력: ${lastResult.extrapolatedInputKeys.join(', ')}`)
    }
    if (lastResult?.constantInputKeysChanged.length) {
      warnings.push(`학습 cohort에서 상수였던 입력이 변경됨: ${lastResult.constantInputKeysChanged.join(', ')}`)
    }
    if (lastResult?.queryDiagnostics.length) {
      warnings.push(
        `현재 query의 metadata 차이 ${lastResult.queryDiagnostics.length.toLocaleString()}개를 무시하고 같은 shape의 cell index 기준으로 예측했습니다.`,
      )
    }
    if (context && profile && workbench.experimentDocument.materialParameters) {
      const currentMaterial = predictionFingerprint([workbench.experimentDocument.materialParameters])
      const differentMaterials = context.measurements.filter(
        (measurement) =>
          profile.includedMeasurementIds.includes(measurement.id) &&
          predictionFingerprint([measurement.material_parameters]) !== currentMaterial,
      ).length
      if (differentMaterials > 0) {
        warnings.push(
          `Material은 모델 입력에서 제외됩니다. cohort 중 ${differentMaterials.toLocaleString()}개 Measurement의 Material snapshot이 현재 Candidate와 다릅니다.`,
        )
      }
    }
    return warnings.length ? warnings.join('\n') : null
  }, [context, lastResult, profile, workbench.experimentDocument.materialParameters])

  const varsPane = (
    <PredictionVarsPane
      currentExperimentId={experimentId}
      candidateSessionKey={`${experimentId ?? 'none'}:prediction`}
      demos={availableQuery.data?.demos ?? []}
      direction={direction}
      disabled={
        validating || samplingProgress !== null || dataStale || freshnessPending || !varsSchema || !candidateVars
      }
      guideVisible={workbench.experimentIsDemo && (!guideProgress.forward || !guideProgress.inverse)}
      isDemo={workbench.experimentIsDemo}
      manageable={workbench.experimentManageable}
      loadingExperiments={availableQuery.isPending}
      mine={availableQuery.data?.mine ?? []}
      resetValues={resetValues}
      samplingRanges={effectiveSamplingRanges}
      schema={varsSchema}
      status={status}
      updating={predictionUpdating}
      vars={candidateVars}
      onDismissGuide={() => setGuideProgress({ forward: true, inverse: true })}
      onExperimentChange={(id) => {
        const row = [...(availableQuery.data?.mine ?? []), ...(availableQuery.data?.demos ?? [])].find(
          (item) => item.id === id,
        )
        if (row && row.id !== experimentId) onExperimentChange(row)
      }}
      onSamplingRangeChange={(key, range) =>
        setSamplingRanges((current) => Object.freeze({ ...current, [key]: Object.freeze(range) }))
      }
      onVariableChange={(key: string, value: Tensor) => {
        if (freshnessPendingRef.current || dataStaleRef.current) return
        if (!candidateVars) return
        const nextVars = Object.freeze({ ...candidateVars, [key]: value })
        if (candidateFingerprint(nextVars) === currentCandidateFingerprint) return
        if (!workbench.setCandidateVariables(nextVars, 'user-vars')) return
        userChangedVarsRef.current = true
        suppressedCandidateRef.current = null
        runtime.advancePrimaryRevision()
        runtime.invalidateTransaction()
        activeForwardVarsFingerprintRef.current = null
        runtime.abortCalculation()
        if (runtime.cancelPendingPrediction()) clearModelCaches()
        setDirection('forward')
        setForwardVarsFingerprint(null)
        setForwardFailure(null)
        setInverseVarsFingerprint(null)
        setCalculationErrors({})
        setValidation(null)
        setSurrogateValues({})
        setSurrogateErrors({})
        setStatus('현재 Candidate를 평가하는 중…')
      }}
    />
  )

  if (!dataReadable) {
    return (
      <>
        {varsContainer ? createPortal(varsPane, varsContainer) : null}
        <div className="grid h-full place-items-center p-6 text-center">
          <div>
            <p className="font-medium">왼쪽에서 공개 Demo를 선택하거나 로그인하세요.</p>
            <button className="mt-3 text-sm font-medium text-primary underline" type="button" onClick={onRequestLogin}>
              로그인
            </button>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      {varsContainer ? createPortal(varsPane, varsContainer) : null}
      <PredictionCalculationPane
        disabled={validating || dataStale || freshnessPending}
        items={paneItems}
        mode={direction === 'forward' ? 'prediction' : 'target'}
        resetKey={`${experimentId ?? 'none'}:${calculationPrimaryRevision}`}
        status={status}
        updating={predictionUpdating}
        onOutputChange={changeCalculationOutput}
      />
      <PredictionSetupDialog
        applyDisabled={Boolean(setupDraftError) || dataStale || freshnessPending || validating}
        autoK={
          setupDraftApplied && profile?.rowCount
            ? Math.min(15, Math.max(1, Math.round(Math.sqrt(profile.rowCount))))
            : null
        }
        busyAction={setupBusyAction}
        calculateMissingDisabled={
          !setupDraft.calculationIds.length ||
          busy ||
          dataStale ||
          freshnessPending ||
          !contextExperimentMatches ||
          !workbench.experimentManageable ||
          workbench.measurementActions.busy ||
          workbench.calculationDataActions.busy
        }
        calculateMissingLabel={
          authenticated
            ? workbench.experimentManageable
              ? '누락 데이터 계산'
              : '데이터 변경 권한 없음'
            : '로그인하여 데이터 계산'
        }
        calculations={
          contextExperimentMatches
            ? context.calculations.map((calculation) => ({
                id: calculation.id,
                name: calculation.name,
                description: calculation.description,
                dependencyNames: calculation.experiment_record_ids.map(
                  (recordId) =>
                    context.experimentRecords.find((record) => record.id === recordId)?.name ?? `#${recordId}`,
                ),
                disabled: calculation.contract_status !== 'ready' || !calculation.output_layout,
                disabledReason:
                  calculation.contract_status !== 'ready' || !calculation.output_layout
                    ? 'Calculation 탭에서 성공한 preflight 후 다시 저장해야 합니다.'
                    : undefined,
                missingCount: Math.max(
                  0,
                  (context.measurements.length ?? 0) -
                    new Set(
                      context.analysis.items
                        .filter((item) => item.calculation_id === calculation.id)
                        .map((item) => item.measurement_id),
                    ).size,
                ),
              }))
            : []
        }
        calculationWeights={setupDraft.calculationWeights}
        cohortSummaries={
          setupDraftApplied && contextExperimentMatches
            ? Object.freeze({
                ...(profiles.forward ? { forward: cohortSummary(profiles.forward, context.measurements.length)! } : {}),
                ...(profiles.inverse ? { inverse: cohortSummary(profiles.inverse, context.measurements.length)! } : {}),
              })
            : {}
        }
        kMode={setupDraft.kMode}
        manualK={setupDraft.manualK}
        manualKMaximum={context?.measurements.length ?? 0}
        open={setupOpen}
        reloadDisabled={busy}
        selectedCalculationIds={setupDraft.calculationIds}
        validationMessage={
          setupDraftError ?? (dataStale ? '새 Measurement를 반영하려면 Reload Data가 필요합니다.' : null)
        }
        weighting={setupDraft.weighting}
        onApply={applySetup}
        onCalculateMissing={() => (authenticated ? void calculateMissing() : onRequestLogin())}
        onCalculationSelectedChange={(calculationId, selected) =>
          setSetupDraft((current) => {
            const calculationIds = selected
              ? [...current.calculationIds, calculationId]
              : current.calculationIds.filter((id) => id !== calculationId)
            return Object.freeze({
              ...current,
              calculationIds: Object.freeze([...new Set(calculationIds)]),
              calculationWeights: Object.freeze({
                ...current.calculationWeights,
                [calculationId]: current.calculationWeights[calculationId] ?? 1,
              }),
            })
          })
        }
        onCalculationWeightChange={(calculationId, weight) =>
          setSetupDraft((current) =>
            Object.freeze({
              ...current,
              calculationWeights: Object.freeze({ ...current.calculationWeights, [calculationId]: weight }),
            }),
          )
        }
        onCancel={() => setSetupOpen(false)}
        onKModeChange={(kMode) => setSetupDraft((current) => Object.freeze({ ...current, kMode }))}
        onManualKChange={(manualK) => setSetupDraft((current) => Object.freeze({ ...current, manualK }))}
        onOpenChange={setSetupOpen}
        onReload={() => void reloadFromSetup()}
        onWeightingChange={(weighting) => setSetupDraft((current) => Object.freeze({ ...current, weighting }))}
      />
      <PredictionDetailsDialog
        direction={detailsDirection}
        forwardRecordProfiles={forwardRecordProfiles}
        neighbors={neighborsByDirection[detailsDirection] ?? []}
        open={detailsOpen}
        profiles={profiles}
        resultText={modelWarningText}
        retryCalculationsDisabled={
          busy ||
          freshnessPending ||
          !contextExperimentMatches ||
          validation?.experimentId !== experimentId ||
          !validation?.rows.some((row) => row.error)
        }
        retryingCalculations={retryingValidation}
        validationComparisons={
          validation?.rows.map((row) => ({
            actual: row.actual,
            calculationId: row.calculationId,
            direction: validation.direction,
            error: row.error,
            metric: row.metric,
            name:
              context?.calculations.find((calculation) => calculation.id === row.calculationId)?.name ??
              `#${row.calculationId}`,
            repredicted: validation.repredicted[row.calculationId] ?? null,
            reference: row.reference,
          })) ?? []
        }
        validationText={validationText}
        onDirectionChange={setDetailsDirection}
        onOpenChange={setDetailsOpen}
        onRetryCalculations={
          validation && workbench.experimentManageable ? () => void retryValidationCalculations() : undefined
        }
      />
    </>
  )
}
