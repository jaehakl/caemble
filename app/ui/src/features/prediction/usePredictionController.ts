import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserPredictionExecution } from './browserExecution'
import { BrowserPredictionSamplingService } from './browserSampling'
import { predictionFingerprint } from './data'
import {
  PredictionInstanceInvalidatedError,
  type PredictionAlgorithm,
  type PredictionExecution,
  type PredictionInput,
  type PredictionModelDefinition,
  type PredictionRecordProfile,
  type PredictionRequest,
  type PreparedPredictionModel,
} from './execution'
import type { TrainingSnapshot } from './trainingSnapshot'
import {
  initialPredictionLifecycleState,
  predictionLifecycleReducer,
  type PredictionLifecycleAction,
  type PredictionOperation,
  type PredictionSamplingProgress,
} from './lifecycle'
import type { PredictionDirection, PredictionTensorSample } from './knn'
import type { PredictionSamplingOptions } from './sampling'

export type PredictionModelCache = PreparedPredictionModel
export type PredictionForwardModelBundle = PreparedPredictionModel
export type PredictionForwardRecordProfile = PredictionRecordProfile

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
  private execution: PredictionExecution | null = null
  private readonly sampling = new BrowserPredictionSamplingService()
  private readonly pending = new Map<string, () => void>()
  private readonly modelOwners = new Map<PreparedPredictionModel, PredictionExecution>()
  private snapshots: Partial<Record<PredictionDirection, Readonly<{ key: string; snapshot: TrainingSnapshot }>>> = {}
  private loadAbort: AbortController | null = null
  private loadRevision = 0
  private modelCache: Partial<Record<PredictionDirection, PredictionModelCache>> = {}
  private modelRevision: Record<PredictionDirection, number> = { forward: 0, inverse: 0 }
  private ownedCalculationDataOperation = false
  private primaryRevision = 0
  private samplingRevision = 0
  private transaction = 0
  private transactionAbort: AbortController | null = null
  private validationAbort: AbortController | null = null
  private validationActive = false
  private validationRevision = 0
  readonly emittedDiagnosticFingerprints = new Set<string>()

  constructor(private createExecution: () => PredictionExecution = () => new BrowserPredictionExecution()) {}

  start() {
    if (!this.execution) this.execution = this.createExecution()
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
    this.clearModelCaches()
    this.execution?.dispose()
    this.execution = null
    this.sampling.dispose()
    this.snapshots = {}
    this.emittedDiagnosticFingerprints.clear()
  }

  get executionAvailable() {
    return this.execution !== null
  }

  get trainingPolicy() {
    return this.execution?.trainingPolicy
  }

  setExecution(createExecution: () => PredictionExecution) {
    this.invalidateTransaction()
    this.clearModelCaches()
    this.execution?.dispose()
    this.createExecution = createExecution
    this.execution = createExecution()
  }

  /** Settle cancellation even if an execution ignores its AbortSignal. */
  private request<T>(
    transaction: number,
    run: (execution: PredictionExecution, request: PredictionRequest) => Promise<T>,
    releaseLate?: (execution: PredictionExecution, value: T) => void,
  ): Promise<T> {
    const execution = this.execution
    const signal = this.transactionAbort?.signal
    if (!execution || !signal || !this.transactionIsCurrent(transaction))
      return Promise.reject(new DOMException('Stale Prediction transaction', 'AbortError'))
    const sessionId = execution.sessionId
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = () => {
        settled = true
        signal.removeEventListener('abort', cancel)
        this.pending.delete(requestId)
      }
      const cancel = () => {
        if (settled) return
        finish()
        reject(new DOMException('Prediction 요청이 취소되었습니다.', 'AbortError'))
        execution.cancel(requestId)
      }
      this.pending.set(requestId, cancel)
      signal.addEventListener('abort', cancel, { once: true })
      void Promise.resolve()
        .then(() => {
          if (settled) throw new DOMException('Prediction 요청이 취소되었습니다.', 'AbortError')
          signal.throwIfAborted()
          return run(execution, { requestId, signal })
        })
        .then(
          (value) => {
            if (
              settled ||
              !this.transactionIsCurrent(transaction) ||
              this.execution !== execution ||
              execution.sessionId !== sessionId
            ) {
              releaseLate?.(execution, value)
              if (!settled) {
                finish()
                reject(new PredictionInstanceInvalidatedError('Prediction 실행 인스턴스가 변경되었습니다.'))
              }
              return
            }
            finish()
            resolve(value)
          },
          (error: unknown) => {
            if (settled) return
            finish()
            reject(error)
          },
        )
    })
  }

  async prepareModel(
    snapshot: TrainingSnapshot,
    algorithm: PredictionAlgorithm,
    transaction: number,
    executionId: string,
  ) {
    const execution = this.execution
    if (
      !execution ||
      execution.id !== executionId ||
      !execution.algorithms.includes(algorithm.kind) ||
      !execution.directions.includes(snapshot.direction)
    )
      throw new Error('선택한 알고리즘과 실행 위치의 조합을 지원하지 않습니다.')
    if (!this.transactionIsCurrent(transaction)) throw new DOMException('Stale Prediction transaction', 'AbortError')
    const meaning = {
      snapshotFingerprint: snapshot.fingerprint,
      algorithm: Object.freeze({
        ...algorithm,
        calculationWeights: Object.freeze({ ...algorithm.calculationWeights }),
      }),
      implementationId: execution.id,
      implementationVersion: execution.implementationVersion,
      preprocessingVersion: execution.preprocessingVersion,
    }
    const definition: PredictionModelDefinition = Object.freeze({
      ...meaning,
      fingerprint: predictionFingerprint([meaning]),
    })
    const cached = this.modelCache[snapshot.direction]
    if (cached?.fingerprint === definition.fingerprint && this.modelIsCurrent(cached)) return cached
    const revision = ++this.modelRevision[snapshot.direction]
    if (cached) this.releaseModel(cached)
    delete this.modelCache[snapshot.direction]
    const model = await this.request(
      transaction,
      (owner, request) => owner.prepare(snapshot, definition, request),
      (owner, late) => {
        void owner.release(late.instance).catch(() => undefined)
      },
    )
    if (
      !this.transactionIsCurrent(transaction) ||
      revision !== this.modelRevision[snapshot.direction] ||
      this.execution !== execution ||
      model.instance.sessionId !== execution.sessionId ||
      model.instance.executionId !== execution.id ||
      model.fingerprint !== definition.fingerprint
    ) {
      void execution.release(model.instance).catch(() => undefined)
      throw new DOMException('Stale Prediction model', 'AbortError')
    }
    this.modelOwners.set(model, execution)
    this.modelCache[snapshot.direction] = model
    return model
  }

  modelIsCurrent(model: PreparedPredictionModel) {
    const execution = this.execution
    return (
      execution !== null &&
      this.modelOwners.get(model) === execution &&
      model.instance.executionId === execution.id &&
      model.instance.sessionId === execution.sessionId
    )
  }

  async predict(model: PreparedPredictionModel, input: PredictionInput, transaction: number) {
    if (!this.modelIsCurrent(model))
      throw new PredictionInstanceInvalidatedError('Prediction 모델을 다시 준비해야 합니다.')
    const capturedInput = structuredClone(input)
    const result = await this.request(transaction, (execution, request) =>
      execution.predict(model.instance, capturedInput, request),
    )
    if (!this.modelIsCurrent(model) || !this.transactionIsCurrent(transaction))
      throw new DOMException('Stale Prediction result', 'AbortError')
    if (result.fingerprint !== model.fingerprint || result.direction !== input.direction)
      throw new Error('Prediction 결과가 요청한 모델과 일치하지 않습니다.')
    return result
  }

  async trainingSnapshot(
    direction: PredictionDirection,
    key: string,
    load: () => Promise<TrainingSnapshot>,
    transaction: number,
  ) {
    if (!this.transactionIsCurrent(transaction)) throw new DOMException('Stale Prediction transaction', 'AbortError')
    const cached = this.snapshots[direction]
    if (cached?.key === key) return cached.snapshot
    const snapshot = await load()
    if (!this.transactionIsCurrent(transaction)) throw new DOMException('Stale Prediction snapshot', 'AbortError')
    this.snapshots[direction] = { key, snapshot }
    return snapshot
  }

  startSampling(sessionId: string, options: PredictionSamplingOptions) {
    return this.sampling.startSampling(sessionId, options)
  }

  nextSample(sessionId: string, fingerprint: string, attempt: number) {
    return this.sampling.nextSample(sessionId, fingerprint, attempt)
  }

  acceptSample(sessionId: string, fingerprint: string, sample: readonly PredictionTensorSample[]) {
    return this.sampling.acceptSample(sessionId, fingerprint, sample)
  }

  dropSampling(sessionId: string) {
    return this.sampling.dropSampling(sessionId)
  }

  resetExecution() {
    this.invalidateTransaction()
    this.cancelPendingPrediction()
    this.clearModelCaches()
    this.execution?.dispose()
    this.execution = this.createExecution()
  }

  cancelPendingPrediction() {
    const hadPending = this.pending.size > 0
    for (const cancel of [...this.pending.values()]) cancel()
    return hadPending
  }

  async runWithExecutionRetry<T>(transaction: number, run: () => Promise<T>, onRestart: () => void) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await run()
      } catch (cause: unknown) {
        if (
          !(cause instanceof PredictionInstanceInvalidatedError) ||
          !cause.retryable ||
          attempt > 0 ||
          !this.transactionIsCurrent(transaction)
        ) {
          throw cause
        }
        this.clearModelCaches()
        onRestart()
      }
    }
    throw new Error('Prediction 실행 재시도에 실패했습니다.')
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
    return transaction === this.transaction && !this.transactionAbort?.signal.aborted
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
    return this.modelCache.forward
  }

  cachedModel(direction: PredictionDirection) {
    return this.modelCache[direction]
  }

  clearTrainingSnapshots() {
    this.snapshots = {}
  }

  private releaseModel(model: PreparedPredictionModel) {
    const owner = this.modelOwners.get(model)
    this.modelOwners.delete(model)
    if (owner) void owner.release(model.instance).catch(() => undefined)
  }

  clearModelCaches() {
    this.modelRevision.forward += 1
    this.modelRevision.inverse += 1
    for (const model of this.modelOwners.keys()) this.releaseModel(model)
    this.modelCache = {}
  }

  cancelCurrent({ cancelCalculationData, cancelMeasurement, samplingActive }: CancelResourcesOptions) {
    const validationActive = this.validationActive
    const predictionCanceled = this.pending.size > 0
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
    this.cancelPendingPrediction()
    this.sampling.reset()
    if (validationActive || samplingActive) {
      cancelMeasurement()
      if (!predictionCanceled) this.resetExecution()
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
  const [lifecycle, setLifecycle] = useState(initialPredictionLifecycleState)
  const lifecycleRef = useRef(lifecycle)
  const transition = useCallback((action: PredictionLifecycleAction) => {
    // Event handlers must observe the transition before React renders again.
    lifecycleRef.current = predictionLifecycleReducer(lifecycleRef.current, action)
    setLifecycle(lifecycleRef.current)
  }, [])

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
      transition({ type: 'operation-started', operation, status, ...options })
    },
    [transition],
  )

  const finishOperation = useCallback(
    (options: Readonly<{ status?: string; clearSampling?: boolean }> = {}) =>
      transition({ type: 'operation-finished', ...options }),
    [transition],
  )

  const cancelLifecycle = useCallback(
    (options: Readonly<{ dataStale: boolean; freshnessPending: boolean }>) =>
      transition({ type: 'cancelled', ...options }),
    [transition],
  )

  const setStatus = useCallback((status: string) => transition({ type: 'status-changed', status }), [transition])
  const setDirection = useCallback(
    (direction: PredictionDirection) => transition({ type: 'direction-changed', direction }),
    [transition],
  )
  const setSamplingProgress = useCallback(
    (progress: PredictionSamplingProgress | null) => transition({ type: 'sampling-progressed', progress }),
    [transition],
  )
  const setFreshnessPending = useCallback(
    (pending: boolean) => transition({ type: 'freshness-pending-changed', pending }),
    [transition],
  )
  const setDataStale = useCallback((stale: boolean) => transition({ type: 'data-stale-changed', stale }), [transition])

  return {
    busy: lifecycle.operation !== 'idle',
    cancelLifecycle,
    finishOperation,
    lifecycle,
    lifecycleRef,
    retryingValidation: lifecycle.operation === 'validation-retry',
    runtime,
    setDataStale,
    setDirection,
    setFreshnessPending,
    setSamplingProgress,
    setStatus,
    startOperation,
    validating: lifecycle.operation === 'validation' || lifecycle.operation === 'validation-retry',
  } as const
}
