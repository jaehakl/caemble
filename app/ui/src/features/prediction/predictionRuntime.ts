import {
  PredictionInstanceInvalidatedError,
  type PredictionExecution,
  type PredictionExecutionRoute,
  type PredictionInput,
  type PreparedPredictionModel,
  type SavedPredictionModel,
} from './execution'
import { predictionFingerprint } from './data'

export type PredictionExecutionBinding = Readonly<{ key: string; create: () => PredictionExecution }>

/** Session-owned model cache. Candidate transactions never own model preparation. */
export class PredictionRuntimeController {
  private execution: PredictionExecution | null = null
  private binding: PredictionExecutionBinding | null = null
  private model: PreparedPredictionModel | null = null
  private loading: Promise<PreparedPredictionModel> | null = null
  private modelKey: string | null = null
  private modelAbort: AbortController | null = null
  private modelRevision = 0
  private transaction = 0
  private transactionAbort: AbortController | null = null
  private calculationAbort: AbortController | null = null
  readonly emittedDiagnosticFingerprints = new Set<string>()

  constructor(private readonly initialExecution?: () => PredictionExecution) {}

  start() {
    if (!this.binding && this.initialExecution) this.setExecution({ key: 'initial', create: this.initialExecution })
  }

  get executionAvailable() {
    return this.execution !== null
  }
  get executionLocation() {
    return 'remote' as const
  }

  setExecution(binding: PredictionExecutionBinding | null) {
    if (this.binding?.key === binding?.key) return
    this.invalidateTransaction()
    this.clearModelCaches()
    this.execution?.dispose()
    this.binding = binding
    this.execution = binding?.create() ?? null
  }

  resetExecution() {
    const binding = this.binding
    this.setExecution(null)
    this.setExecution(binding)
  }

  beginTransaction() {
    this.invalidateTransaction()
    this.transactionAbort = new AbortController()
    return this.transaction
  }

  currentTransaction() {
    return this.transaction
  }
  transactionSignal() {
    return this.transactionAbort?.signal
  }
  transactionIsCurrent(transaction: number) {
    return transaction === this.transaction && this.transactionAbort !== null && !this.transactionAbort.signal.aborted
  }

  invalidateTransaction() {
    this.transactionAbort?.abort()
    this.transactionAbort = null
    this.transaction += 1
    this.abortCalculation()
  }

  /** Explicit stop also ends pending connection/load work; committed models stay reusable. */
  cancelCurrent() {
    const loading = this.loading !== null
    this.invalidateTransaction()
    if (loading) this.resetExecution()
  }

  private currentRequest<T>(transaction: number, promise: Promise<T>): Promise<T> {
    const signal = this.transactionAbort?.signal
    if (!signal || !this.transactionIsCurrent(transaction)) {
      void promise.catch(() => undefined)
      return Promise.reject(new DOMException('Prediction 요청이 취소되었습니다.', 'AbortError'))
    }
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(new DOMException('Prediction 요청이 취소되었습니다.', 'AbortError'))
      signal.addEventListener('abort', cancel, { once: true })
      void promise.then(
        (value) => {
          signal.removeEventListener('abort', cancel)
          if (!this.transactionIsCurrent(transaction)) cancel()
          else resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', cancel)
          reject(error)
        },
      )
    })
  }

  loadModel(reference: SavedPredictionModel, transaction: number, route?: PredictionExecutionRoute) {
    const execution = this.execution
    if (!execution?.load) return Promise.reject(new Error('연결할 Launcher를 선택하세요.'))
    if (!this.transactionIsCurrent(transaction))
      return Promise.reject(new DOMException('Stale prediction', 'AbortError'))
    const key = predictionFingerprint([
      reference.modelId,
      reference.modelRevision,
      reference.fingerprint,
      reference.manifestChecksum,
    ])
    if (this.modelKey === key && this.model && this.modelIsCurrent(this.model)) return Promise.resolve(this.model)
    if (this.modelKey === key && this.loading) return this.currentRequest(transaction, this.loading)
    this.clearModelCaches()
    this.modelKey = key
    const revision = this.modelRevision
    const sessionId = execution.sessionId
    const abort = new AbortController()
    this.modelAbort = abort
    const loading = execution
      .load(reference, { requestId: crypto.randomUUID(), signal: abort.signal }, route)
      .then(async (model) => {
        if (
          abort.signal.aborted ||
          revision !== this.modelRevision ||
          execution !== this.execution ||
          sessionId !== execution.sessionId
        ) {
          await execution.release(model.instance).catch(() => undefined)
          throw new DOMException('Stale prediction model', 'AbortError')
        }
        if (
          model.fingerprint !== reference.fingerprint ||
          model.instance.sessionId !== execution.sessionId ||
          model.profile.direction !== 'forward'
        ) {
          await execution.release(model.instance).catch(() => undefined)
          throw new Error('저장 모델 revision 또는 실행 세션이 요청과 다릅니다.')
        }
        this.model = model
        return model
      })
      .finally(() => {
        if (revision === this.modelRevision) {
          this.loading = null
          this.modelAbort = null
        }
      })
    this.loading = loading
    return this.currentRequest(transaction, loading)
  }

  modelIsCurrent(model: PreparedPredictionModel) {
    return (
      this.model === model &&
      this.execution?.sessionId === model.instance.sessionId &&
      this.execution.id === model.instance.executionId
    )
  }

  cachedModel() {
    return this.model
  }

  async predict(model: PreparedPredictionModel, input: PredictionInput, transaction: number) {
    const execution = this.execution
    const signal = this.transactionSignal()
    if (!execution || !signal || !this.modelIsCurrent(model))
      throw new PredictionInstanceInvalidatedError('저장 모델을 다시 로드하세요.')
    signal.throwIfAborted()
    const requestId = crypto.randomUUID()
    const cancel = () => execution.cancel(requestId)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const result = await this.currentRequest(
        transaction,
        execution.predict(model.instance, structuredClone(input), { requestId, signal }),
      )
      if (!this.modelIsCurrent(model) || result.fingerprint !== model.fingerprint || result.direction !== 'forward')
        throw new PredictionInstanceInvalidatedError('Prediction 결과의 모델 또는 세션이 변경되었습니다.')
      const expected = model.provenance
      const actual = result.provenance
      if (
        !actual ||
        (expected &&
          (actual.modelId !== expected.modelId ||
            actual.modelRevision !== expected.modelRevision ||
            actual.datasetId !== expected.datasetId ||
            actual.datasetRevision !== expected.datasetRevision))
      )
        throw new Error('Prediction 결과의 모델 출처가 요청과 다릅니다.')
      return result
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  beginCalculation() {
    this.abortCalculation()
    this.calculationAbort = new AbortController()
    return this.calculationAbort
  }

  abortCalculation() {
    this.calculationAbort?.abort()
    this.calculationAbort = null
  }

  clearModelCaches() {
    this.modelRevision += 1
    this.modelAbort?.abort()
    this.modelAbort = null
    this.loading = null
    this.modelKey = null
    const model = this.model
    this.model = null
    if (model && this.execution) void this.execution.release(model.instance).catch(() => undefined)
  }

  async releaseLoadedModels() {
    this.invalidateTransaction()
    const model = this.model
    const execution = this.execution
    this.model = null
    this.clearModelCaches()
    if (model && execution) await execution.release(model.instance)
  }

  dispose() {
    this.setExecution(null)
    this.emittedDiagnosticFingerprints.clear()
  }
}
