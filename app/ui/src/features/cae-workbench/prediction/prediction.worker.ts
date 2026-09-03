/// <reference lib="webworker" />

import {
  buildPredictionKnnModel,
  predictWithKnn,
  PredictionModelError,
  PREDICTION_PERSISTENT_ARRAY_LIMIT_BYTES,
  PREDICTION_WORKING_SET_LIMIT_BYTES,
  type PredictionKnnModel,
} from './knn'
import {
  acceptPredictionSamplingCenter,
  createPredictionSamplingSession,
  nextPredictionSamplingCandidate,
  type PredictionSamplingSession,
} from './sampling'
import type { PredictionWorkerRequest, PredictionWorkerResponse } from './protocol'

const models = new Map<string, Readonly<{ generation: number; model: PredictionKnnModel }>>()
const samplingSessions = new Map<string, PredictionSamplingSession>()

function respond(response: PredictionWorkerResponse) {
  self.postMessage(response)
}

function identity(request: Extract<PredictionWorkerRequest, Readonly<{ modelId: string }>>) {
  return {
    requestId: request.requestId,
    modelId: request.modelId,
    generation: request.generation,
    fingerprint: request.fingerprint,
  }
}

self.onmessage = (event: MessageEvent<PredictionWorkerRequest>) => {
  const request = event.data
  try {
    if (request.type === 'dispose') {
      models.clear()
      samplingSessions.clear()
      respond({ type: 'disposed', requestId: request.requestId })
      return
    }
    if (request.type === 'start-sampling') {
      const created = createPredictionSamplingSession(request.options)
      samplingSessions.set(request.sessionId, created.session)
      respond({
        type: 'sampling-ready',
        requestId: request.requestId,
        sessionId: request.sessionId,
        fingerprint: request.options.fingerprint,
        profile: created.profile,
      })
      return
    }
    if (request.type === 'next-sample') {
      const session = samplingSessions.get(request.sessionId)
      if (!session || session.fingerprint !== request.fingerprint) {
        throw new PredictionModelError('stale-model', 'Sampling session이 현재 Experiment와 일치하지 않습니다.')
      }
      respond({
        type: 'sampling-candidate',
        requestId: request.requestId,
        sessionId: request.sessionId,
        fingerprint: request.fingerprint,
        sample: nextPredictionSamplingCandidate(session, request.attempt),
      })
      return
    }
    if (request.type === 'accept-sample') {
      const session = samplingSessions.get(request.sessionId)
      if (!session || session.fingerprint !== request.fingerprint) {
        throw new PredictionModelError('stale-model', 'Sampling session이 현재 Experiment와 일치하지 않습니다.')
      }
      respond({
        type: 'sampling-accepted',
        requestId: request.requestId,
        sessionId: request.sessionId,
        fingerprint: request.fingerprint,
        centerCount: acceptPredictionSamplingCenter(session, request.sample),
      })
      return
    }
    if (request.type === 'drop-sampling') {
      samplingSessions.delete(request.sessionId)
      respond({ type: 'sampling-dropped', requestId: request.requestId, sessionId: request.sessionId })
      return
    }
    if (request.type === 'drop-model') {
      const current = models.get(request.modelId)
      if (current && (current.generation !== request.generation || current.model.fingerprint !== request.fingerprint)) {
        respond({ ...identity(request), type: 'stale' })
        return
      }
      models.delete(request.modelId)
      respond({ ...identity(request), type: 'model-dropped' })
      return
    }
    if (request.type === 'build-model') {
      const current = models.get(request.modelId)
      if (current && request.generation < current.generation) {
        respond({ ...identity(request), type: 'stale' })
        return
      }
      if (request.options.fingerprint !== request.fingerprint) {
        respond({ ...identity(request), type: 'stale' })
        return
      }
      models.delete(request.modelId)
      const retainedBytes = [...models.values()].reduce((total, entry) => total + entry.model.memory.persistentBytes, 0)
      const model = buildPredictionKnnModel({
        ...request.options,
        persistentArrayLimitBytes: Math.min(
          request.options.persistentArrayLimitBytes ?? PREDICTION_PERSISTENT_ARRAY_LIMIT_BYTES,
          PREDICTION_PERSISTENT_ARRAY_LIMIT_BYTES - retainedBytes,
        ),
        workingSetLimitBytes: Math.min(
          request.options.workingSetLimitBytes ?? PREDICTION_WORKING_SET_LIMIT_BYTES,
          PREDICTION_WORKING_SET_LIMIT_BYTES - retainedBytes,
        ),
      })
      if (
        [...models.values()].some(
          (entry) =>
            entry.model.memory.workingSetBytes + model.memory.persistentBytes > PREDICTION_WORKING_SET_LIMIT_BYTES,
        )
      ) {
        throw new PredictionModelError('memory-limit', 'Prediction Worker models exceed the shared working-set limit.')
      }
      models.set(request.modelId, { generation: request.generation, model })
      respond({
        ...identity(request),
        type: 'model-ready',
        profile: {
          direction: model.direction,
          activeInputBlockCount: model.activeInputBlockCount,
          rowCount: model.rowCount,
          k: model.k,
          weighting: model.weighting,
          inputScaling: model.inputScaling,
          inputLayouts: model.direction === 'inverse' ? model.inputLayouts : [],
          inputScales: model.direction === 'inverse' ? model.inputScales : new Float64Array(),
          inputBlockWeights: model.inputBlockWeights,
          inputSize: model.inputSize,
          outputSize: model.outputSize,
          persistentBytes: model.memory.persistentBytes,
          workingSetBytes: model.memory.workingSetBytes,
          includedMeasurementIds: model.cohort.includedMeasurementIds,
          warningMeasurementIds: model.cohort.warningMeasurementIds,
          dominantShapeSignature: model.cohort.dominantShapeSignature,
          baselineMeasurementId: model.cohort.baselineMeasurementId,
          diagnostics: model.cohort.diagnostics,
          omittedDiagnosticGroups: model.cohort.omittedDiagnosticGroups,
          excluded: model.cohort.excluded,
        },
      })
      return
    }
    const current = models.get(request.modelId)
    if (!current || current.generation !== request.generation || current.model.fingerprint !== request.fingerprint) {
      respond({ ...identity(request), type: 'stale' })
      return
    }
    respond({
      ...identity(request),
      type: 'prediction',
      result: predictWithKnn(current.model, request.query, request.fingerprint),
    })
  } catch (error) {
    respond({
      type: 'error',
      requestId: request.requestId,
      ...('modelId' in request
        ? { modelId: request.modelId, generation: request.generation, fingerprint: request.fingerprint }
        : {}),
      code: error instanceof PredictionModelError ? error.code : 'runtime',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
