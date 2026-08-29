import type {
  PredictionCohortOptions,
  PredictionResult,
  PredictionTensorSample,
  PredictionWorkerModelProfile,
  PredictionWorkerRequest,
  PredictionWorkerResponse,
} from '.'

type PendingRequest = Readonly<{
  reject: (reason?: unknown) => void
  resolve: (value: PredictionWorkerResponse) => void
}>

export class PredictionWorkerRestartError extends Error {
  override readonly name = 'PredictionWorkerRestartError'
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
    worker.onmessage = (event: MessageEvent<PredictionWorkerResponse>) => {
      if (this.worker !== worker) return
      const pending = this.pending.get(event.data.requestId)
      if (!pending) return
      this.pending.delete(event.data.requestId)
      if (event.data.type === 'error') pending.reject(new Error(event.data.message))
      else if (event.data.type === 'stale') {
        pending.reject(new PredictionWorkerRestartError('Prediction 요청이 최신 모델과 일치하지 않습니다.'))
        this.reset()
      } else pending.resolve(event.data)
    }
    worker.onerror = (event) => {
      if (this.worker !== worker) return
      const error = new PredictionWorkerRestartError(event.message || 'Prediction Worker가 중단되었습니다.')
      this.pending.forEach(({ reject }) => reject(error))
      this.pending.clear()
      worker.terminate()
      this.worker = this.createWorker()
    }
    return worker
  }

  get epoch() {
    return this.workerEpoch
  }

  private request(request: PredictionWorkerRequest) {
    return new Promise<PredictionWorkerResponse>((resolve, reject) => {
      this.pending.set(request.requestId, { reject, resolve })
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
