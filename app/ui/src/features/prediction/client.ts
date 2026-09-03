import type {
  PredictionCohortOptions,
  PredictionResult,
  PredictionSamplingOptions,
  PredictionSamplingProfile,
  PredictionTensorSample,
  PredictionWorkerModelProfile,
  PredictionWorkerRequest,
  PredictionWorkerResponse,
} from '.'
import { parsePredictionWorkerResponseForRequest, predictionWorkerMessageRequestId } from './protocolValidation'

type PendingRequest = Readonly<{
  request: PredictionWorkerRequest
  reject: (reason?: unknown) => void
  resolve: (value: PredictionWorkerResponse) => void
}>

export class PredictionWorkerRestartError extends Error {
  override readonly name: string = 'PredictionWorkerRestartError'
}

export class PredictionWorkerContractError extends PredictionWorkerRestartError {
  override readonly name = 'PredictionWorkerContractError'
  readonly validationError: unknown

  constructor(validationError: unknown) {
    super('Prediction Worker 응답 계약이 일치하지 않습니다.')
    this.validationError = validationError
  }
}

export class PredictionWorkerClient {
  private readonly pending = new Map<string, PendingRequest>()
  private workerEpoch = 0
  private worker: Worker

  constructor() {
    this.worker = this.createWorker()
  }

  private createWorker() {
    this.workerEpoch += 1
    const worker = new Worker(new URL('./prediction.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (this.worker !== worker) return
      const requestId = predictionWorkerMessageRequestId(event.data)
      if (requestId === null) {
        if (this.pending.size > 0) {
          this.rejectPendingAndRestart(worker, new PredictionWorkerContractError(new TypeError('Missing requestId.')))
        }
        return
      }
      const pending = this.pending.get(requestId)
      if (!pending) return
      let response: PredictionWorkerResponse
      try {
        response = parsePredictionWorkerResponseForRequest(event.data, pending.request)
      } catch (error) {
        this.rejectPendingAndRestart(worker, new PredictionWorkerContractError(error))
        return
      }
      this.pending.delete(requestId)
      if (response.type === 'error') pending.reject(new Error(response.message))
      else if (response.type === 'stale') {
        pending.reject(new PredictionWorkerRestartError('Prediction 요청이 최신 모델과 일치하지 않습니다.'))
        this.reset()
      } else pending.resolve(response)
    }
    worker.onerror = (event) => {
      if (this.worker !== worker) return
      const error = new PredictionWorkerRestartError(event.message || 'Prediction Worker가 중단되었습니다.')
      this.rejectPendingAndRestart(worker, error)
    }
    return worker
  }

  private rejectPendingAndRestart(worker: Worker, error: PredictionWorkerRestartError) {
    if (this.worker !== worker) return
    this.pending.forEach(({ reject }) => reject(error))
    this.pending.clear()
    worker.terminate()
    this.worker = this.createWorker()
  }

  get epoch() {
    return this.workerEpoch
  }

  private request(request: PredictionWorkerRequest) {
    return new Promise<PredictionWorkerResponse>((resolve, reject) => {
      this.pending.set(request.requestId, { request, reject, resolve })
      this.worker.postMessage(request)
    })
  }

  async build(
    modelId: string,
    generation: number,
    fingerprint: string,
    options: PredictionCohortOptions,
  ): Promise<PredictionWorkerModelProfile> {
    const response = await this.request({
      type: 'build-model',
      requestId: crypto.randomUUID(),
      modelId,
      generation,
      fingerprint,
      options,
    })
    if (response.type !== 'model-ready') throw new Error('Prediction 모델 준비 응답이 올바르지 않습니다.')
    return response.profile
  }

  async predict(
    modelId: string,
    generation: number,
    fingerprint: string,
    query: readonly PredictionTensorSample[],
  ): Promise<PredictionResult> {
    const response = await this.request({
      type: 'predict',
      requestId: crypto.randomUUID(),
      modelId,
      generation,
      fingerprint,
      query,
    })
    if (response.type !== 'prediction') throw new Error('Prediction 결과 응답이 올바르지 않습니다.')
    return response.result
  }

  async startSampling(sessionId: string, options: PredictionSamplingOptions): Promise<PredictionSamplingProfile> {
    const response = await this.request({ type: 'start-sampling', requestId: crypto.randomUUID(), sessionId, options })
    if (response.type !== 'sampling-ready') throw new Error('Prediction sampling 준비 응답이 올바르지 않습니다.')
    return response.profile
  }

  async nextSample(sessionId: string, fingerprint: string, attempt: number) {
    const response = await this.request({
      type: 'next-sample',
      requestId: crypto.randomUUID(),
      sessionId,
      fingerprint,
      attempt,
    })
    if (response.type !== 'sampling-candidate') throw new Error('Prediction sampling 후보 응답이 올바르지 않습니다.')
    return response.sample
  }

  async acceptSample(sessionId: string, fingerprint: string, sample: readonly PredictionTensorSample[]) {
    const response = await this.request({
      type: 'accept-sample',
      requestId: crypto.randomUUID(),
      sessionId,
      fingerprint,
      sample,
    })
    if (response.type !== 'sampling-accepted') throw new Error('Prediction sampling center 응답이 올바르지 않습니다.')
    return response.centerCount
  }

  async dropSampling(sessionId: string) {
    const response = await this.request({ type: 'drop-sampling', requestId: crypto.randomUUID(), sessionId })
    if (response.type !== 'sampling-dropped') throw new Error('Prediction sampling 종료 응답이 올바르지 않습니다.')
  }

  cancelPending() {
    if (this.pending.size === 0) return false
    this.reset()
    return true
  }

  reset() {
    this.pending.forEach(({ reject }) => reject(new DOMException('Prediction 요청이 취소되었습니다.', 'AbortError')))
    this.pending.clear()
    this.worker.terminate()
    this.worker = this.createWorker()
  }

  dispose() {
    this.pending.forEach(({ reject }) => reject(new DOMException('Prediction Worker가 종료되었습니다.', 'AbortError')))
    this.pending.clear()
    this.worker.terminate()
  }
}
