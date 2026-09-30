import { PredictionWorkerClient } from './client'
import type { PredictionTensorSample } from './knn'
import type { PredictionSamplingOptions } from './sampling'

/** Sampling is an independent browser service, not a required Predictor capability. */
export class BrowserPredictionSamplingService {
  private client: PredictionWorkerClient | null = null

  startSampling(sessionId: string, options: PredictionSamplingOptions) {
    this.client ??= new PredictionWorkerClient()
    return this.client.startSampling(sessionId, options)
  }

  nextSample(sessionId: string, fingerprint: string, attempt: number) {
    if (!this.client) return Promise.reject(new Error('Prediction sampling이 준비되지 않았습니다.'))
    return this.client.nextSample(sessionId, fingerprint, attempt)
  }

  acceptSample(sessionId: string, fingerprint: string, sample: readonly PredictionTensorSample[]) {
    if (!this.client) return Promise.reject(new Error('Prediction sampling이 준비되지 않았습니다.'))
    return this.client.acceptSample(sessionId, fingerprint, sample)
  }

  async dropSampling(sessionId: string) {
    if (!this.client) return
    const client = this.client
    try {
      await client.dropSampling(sessionId)
    } finally {
      if (this.client === client) this.client = null
      client.dispose()
    }
  }

  cancelPending() {
    if (!this.client) return false
    this.client.dispose()
    this.client = null
    return true
  }

  reset() {
    this.dispose()
  }

  dispose() {
    this.client?.dispose()
    this.client = null
  }
}
