import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { ExperimentRecordedDataRecord } from '@/api'
import type { recordedDataRules } from '../measurement/recordedData'
import { PredictionWorkerClient, PredictionWorkerRestartError } from './client'
import {
  initialPredictionLifecycleState,
  predictionLifecycleReducer,
  type PredictionOperation,
  type PredictionSamplingProgress,
} from './lifecycle'
import type { PredictionCohortOptions, PredictionDirection, PredictionTensorSample, PredictionTrainingRow } from './knn'
import type { PredictionWorkerModelProfile } from './protocol'
import type { PredictionSamplingOptions } from './sampling'

export type PredictionModelCache = Readonly<{
  fingerprint: string
  generation: number
  profile: PredictionWorkerModelProfile
  workerEpoch: number
}>

export type PredictionForwardModelEntry = PredictionModelCache &
  Readonly<{
    record: ExperimentRecordedDataRecord
    rule: ReturnType<typeof recordedDataRules>[number]
  }>

export type PredictionForwardModelBundle = Readonly<{
  errors: Readonly<Record<number, string>>
  fingerprint: string
  models: readonly PredictionForwardModelEntry[]
  profile: PredictionWorkerModelProfile
  rules: ReturnType<typeof recordedDataRules>
}>

export type PredictionForwardRecordProfile = Readonly<{
  error: string | null
  name: string
  profile: PredictionWorkerModelProfile | null
  recordId: number
}>

type CancelResourcesOptions = Readonly<{
  cancelCalculationData: () => void
  cancelMeasurement: () => void
  samplingActive: boolean
}>

export class PredictionRuntimeController {
  private calculationAbort: AbortController | null = null
  private cancelSamplingCandidateWait: (() => void) | null = null
  private checkingFingerprint = 0
  private fingerprintAbort: AbortController | null = null
  private client: PredictionWorkerClient | null = null
  private forwardModelCache: PredictionForwardModelBundle | null = null
  private generation = 0
  private inverseRows: Readonly<{ key: string; rows: readonly PredictionTrainingRow[] }> | null = null
  private loadAbort: AbortController | null = null
  private loadRevision = 0
  private modelCache: Partial<Record<PredictionDirection, PredictionModelCache>> = {}
  private ownedCalculationDataOperation = false
  private primaryRevision = 0
  private samplingRevision = 0
  private transaction = 0
  private transactionAbort: AbortController | null = null
  private validationAbort: AbortController | null = null
  private validationActive = false
  private validationRevision = 0
  readonly emittedDiagnosticFingerprints = new Set<string>()

  start() {
    if (!this.client) this.client = new PredictionWorkerClient()
  }

  dispose() {
    this.invalidateLoad()
    this.invalidateTransaction()
    this.invalidateValidation()
    this.samplingRevision += 1
    this.invalidateFingerprintCheck()
    this.ownedCalculationDataOperation = false
    this.cancelCandidateWait()
    this.abortCalculation()
    this.client?.dispose()
    this.client = null
    this.clearModelCaches()
    this.inverseRows = null
  }

  get workerAvailable() {
    return this.client !== null
  }

  get workerEpoch() {
    return this.client?.epoch ?? 0
  }

  buildModel(modelId: string, generation: number, fingerprint: string, options: PredictionCohortOptions) {
    if (!this.client) return Promise.reject(new Error('Prediction Worker가 준비되지 않았습니다.'))
    return this.client.build(modelId, generation, fingerprint, options)
  }

  predict(modelId: string, generation: number, fingerprint: string, query: readonly PredictionTensorSample[]) {
    if (!this.client) return Promise.reject(new Error('Prediction Worker가 준비되지 않았습니다.'))
    return this.client.predict(modelId, generation, fingerprint, query)
  }

  startSampling(sessionId: string, options: PredictionSamplingOptions) {
    if (!this.client) return Promise.reject(new Error('Prediction Worker가 준비되지 않았습니다.'))
    return this.client.startSampling(sessionId, options)
  }

  nextSample(sessionId: string, fingerprint: string, attempt: number) {
    if (!this.client) return Promise.reject(new Error('Prediction Worker가 준비되지 않았습니다.'))
    return this.client.nextSample(sessionId, fingerprint, attempt)
  }

  acceptSample(sessionId: string, fingerprint: string, sample: readonly PredictionTensorSample[]) {
    if (!this.client) return Promise.reject(new Error('Prediction Worker가 준비되지 않았습니다.'))
    return this.client.acceptSample(sessionId, fingerprint, sample)
  }

  dropSampling(sessionId: string) {
    if (!this.client) return Promise.resolve()
    return this.client.dropSampling(sessionId)
  }

  resetWorker() {
    this.client?.reset()
  }

  cancelPendingPrediction() {
    return this.client?.cancelPending() ?? false
  }

  async runWithWorkerRestartRetry<T>(transaction: number, run: () => Promise<T>, onRestart: () => void) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await run()
      } catch (cause: unknown) {
        if (
          !(cause instanceof PredictionWorkerRestartError) ||
          attempt > 0 ||
          !this.transactionIsCurrent(transaction)
        ) {
          throw cause
        }
        this.clearModelCaches()
        onRestart()
      }
    }
    throw new Error('Prediction Worker 재시도에 실패했습니다.')
  }

  nextGeneration() {
    this.generation += 1
    return this.generation
  }

  beginLoad() {
    this.loadAbort?.abort()
    this.loadAbort = new AbortController()
    this.loadRevision += 1
    return this.loadRevision
  }

  invalidateLoad() {
    this.loadAbort?.abort()
    this.loadAbort = null
    this.loadRevision += 1
  }

  loadSignal() {
    return this.loadAbort?.signal
  }

  loadIsCurrent(revision: number) {
    return revision === this.loadRevision
  }

  currentLoadRevision() {
    return this.loadRevision
  }

  beginTransaction() {
    this.transactionAbort?.abort()
    this.transactionAbort = new AbortController()
    this.transaction += 1
    return this.transaction
  }

  invalidateTransaction() {
    this.transactionAbort?.abort()
    this.transactionAbort = null
    this.transaction += 1
  }

  transactionSignal() {
    return this.transactionAbort?.signal
  }

  transactionIsCurrent(transaction: number) {
    return transaction === this.transaction
  }

  currentTransaction() {
    return this.transaction
  }

  advancePrimaryRevision() {
    this.primaryRevision += 1
  }

  currentPrimaryRevision() {
    return this.primaryRevision
  }

  beginValidation() {
    this.validationAbort?.abort()
    this.validationAbort = new AbortController()
    this.validationRevision += 1
    this.validationActive = true
    return this.validationRevision
  }

  invalidateValidation() {
    this.validationAbort?.abort()
    this.validationAbort = null
    this.validationRevision += 1
    this.validationActive = false
  }

  validationIsCurrent(revision: number) {
    return revision === this.validationRevision
  }

  finishValidation(revision: number) {
    if (!this.validationIsCurrent(revision)) return false
    this.validationActive = false
    this.validationAbort = null
    return true
  }

  validationSignal() {
    return this.validationAbort?.signal
  }

  beginSampling() {
    this.samplingRevision += 1
    return this.samplingRevision
  }

  samplingIsCurrent(revision: number) {
    return revision === this.samplingRevision
  }

  finishSampling(revision: number) {
    if (!this.samplingIsCurrent(revision)) return false
    return true
  }

  nextFingerprintCheck() {
    this.fingerprintAbort?.abort()
    this.fingerprintAbort = new AbortController()
    this.checkingFingerprint += 1
    return this.checkingFingerprint
  }

  invalidateFingerprintCheck() {
    this.fingerprintAbort?.abort()
    this.fingerprintAbort = null
    this.checkingFingerprint += 1
  }

  fingerprintSignal() {
    return this.fingerprintAbort?.signal
  }

  fingerprintCheckIsCurrent(revision: number) {
    return revision === this.checkingFingerprint
  }

  beginCalculation() {
    this.abortCalculation()
    const controller = new AbortController()
    this.calculationAbort = controller
    return controller
  }

  abortCalculation() {
    this.calculationAbort?.abort()
    this.calculationAbort = null
  }

  setSamplingCandidateWait(cancel: () => void) {
    this.cancelSamplingCandidateWait = cancel
  }

  clearSamplingCandidateWait(cancel: () => void) {
    if (this.cancelSamplingCandidateWait === cancel) this.cancelSamplingCandidateWait = null
  }

  private cancelCandidateWait() {
    this.cancelSamplingCandidateWait?.()
    this.cancelSamplingCandidateWait = null
  }

  setCalculationDataOperationOwned(owned: boolean) {
    this.ownedCalculationDataOperation = owned
  }

  hasOwnedCalculationDataOperation() {
    return this.ownedCalculationDataOperation
  }

  cachedForwardModel() {
    return this.forwardModelCache
  }

  cacheForwardModel(model: PredictionForwardModelBundle) {
    this.forwardModelCache = model
  }

  cachedModel(direction: PredictionDirection) {
    return this.modelCache[direction]
  }

  cacheModel(direction: PredictionDirection, model: PredictionModelCache) {
    this.modelCache = { ...this.modelCache, [direction]: model }
  }

  cachedInverseRows(key: string) {
    return this.inverseRows?.key === key ? this.inverseRows.rows : null
  }

  cacheInverseRows(key: string, rows: readonly PredictionTrainingRow[]) {
    this.inverseRows = Object.freeze({ key, rows })
  }

  releaseInverseRows(rows: readonly PredictionTrainingRow[]) {
    if (this.inverseRows?.rows === rows) this.inverseRows = null
  }

  clearInverseRows() {
    this.inverseRows = null
  }

  clearModelCaches() {
    this.modelCache = {}
    this.forwardModelCache = null
  }

  cancelCurrent({ cancelCalculationData, cancelMeasurement, samplingActive }: CancelResourcesOptions) {
    const validationActive = this.validationActive
    this.invalidateLoad()
    this.invalidateTransaction()
    this.invalidateValidation()
    this.invalidateFingerprintCheck()
    this.samplingRevision += 1
    this.primaryRevision += 1
    this.cancelCandidateWait()
    this.abortCalculation()
    if (this.ownedCalculationDataOperation) cancelCalculationData()
    this.ownedCalculationDataOperation = false
    const predictionCanceled = this.cancelPendingPrediction()
    if (validationActive || samplingActive) {
      cancelMeasurement()
      if (!predictionCanceled) this.resetWorker()
    }
    const modelsCleared = predictionCanceled || validationActive || samplingActive
    if (modelsCleared) this.clearModelCaches()
    return Object.freeze({ modelsCleared, samplingActive, validationActive })
  }
}

export function usePredictionController() {
  const runtimeRef = useRef<PredictionRuntimeController | null>(null)
  if (!runtimeRef.current) runtimeRef.current = new PredictionRuntimeController()
  const runtime = runtimeRef.current
  const [lifecycle, dispatch] = useReducer(predictionLifecycleReducer, initialPredictionLifecycleState)
  const busyRef = useRef(lifecycle.busy)
  const dataStaleRef = useRef(lifecycle.dataStale)
  const freshnessPendingRef = useRef(lifecycle.freshnessPending)
  const samplingProgressRef = useRef(lifecycle.samplingProgress)

  useEffect(() => {
    runtime.start()
    return () => runtime.dispose()
  }, [runtime])

  const startOperation = useCallback(
    (
      operation: Exclude<PredictionOperation, 'idle'>,
      status: string,
      options: Readonly<{
        direction?: PredictionDirection
        samplingProgress?: PredictionSamplingProgress
      }> = {},
    ) => {
      busyRef.current = true
      if (options.samplingProgress) samplingProgressRef.current = options.samplingProgress
      dispatch({ type: 'operation-started', operation, status, ...options })
    },
    [],
  )

  const finishOperation = useCallback((options: Readonly<{ status?: string; clearSampling?: boolean }> = {}) => {
    busyRef.current = false
    if (options.clearSampling) samplingProgressRef.current = null
    dispatch({ type: 'operation-finished', ...options })
  }, [])

  const cancelLifecycle = useCallback((options: Readonly<{ dataStale: boolean; freshnessPending: boolean }>) => {
    busyRef.current = false
    dataStaleRef.current = options.dataStale
    freshnessPendingRef.current = options.freshnessPending
    samplingProgressRef.current = null
    dispatch({ type: 'cancelled', ...options })
  }, [])

  const setStatus = useCallback((status: string) => dispatch({ type: 'status-changed', status }), [])
  const setDirection = useCallback(
    (direction: PredictionDirection) => dispatch({ type: 'direction-changed', direction }),
    [],
  )
  const setSamplingProgress = useCallback((progress: PredictionSamplingProgress | null) => {
    samplingProgressRef.current = progress
    dispatch({ type: 'sampling-progressed', progress })
  }, [])
  const setFreshnessPending = useCallback((pending: boolean) => {
    freshnessPendingRef.current = pending
    dispatch({ type: 'freshness-pending-changed', pending })
  }, [])
  const setDataStale = useCallback((stale: boolean) => {
    dataStaleRef.current = stale
    dispatch({ type: 'data-stale-changed', stale })
  }, [])

  return {
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
  } as const
}
