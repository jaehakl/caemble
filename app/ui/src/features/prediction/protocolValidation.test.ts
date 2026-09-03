import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PredictionWorkerClient, PredictionWorkerContractError } from './client'
import type { PredictionCohortOptions, PredictionTensorLayout, PredictionTensorSample } from './knn'
import type { PredictionWorkerRequest } from './protocol'
import {
  parsePredictionWorkerRequest,
  parsePredictionWorkerResponse,
  parsePredictionWorkerResponseForRequest,
} from './protocolValidation'

const layout: PredictionTensorLayout = {
  key: 'temperature',
  dtype: 'float64',
  shape: [],
  tensorOrder: 0,
  minimum: 0,
  maximum: 100,
}
const sample: PredictionTensorSample = { layout, values: [25] }
const buildOptions: PredictionCohortOptions = {
  direction: 'inverse',
  fingerprint: 'fingerprint-v1',
  inputKeys: ['temperature'],
  outputKeys: ['vars'],
  rows: [],
}
const buildRequest: PredictionWorkerRequest = {
  type: 'build-model',
  requestId: 'request-1',
  modelId: 'inverse',
  generation: 3,
  fingerprint: 'fingerprint-v1',
  options: buildOptions,
}
const profile = {
  direction: 'inverse' as const,
  activeInputBlockCount: 1,
  rowCount: 2,
  k: 1,
  weighting: 'distance' as const,
  inputScaling: 'range' as const,
  inputLayouts: [layout],
  inputScales: new Float64Array([100]),
  inputBlockWeights: { temperature: 1 },
  inputSize: 1,
  outputSize: 1,
  persistentBytes: 64,
  workingSetBytes: 96,
  includedMeasurementIds: [11, 12],
  warningMeasurementIds: [],
  dominantShapeSignature: JSON.stringify([{ key: 'temperature', shape: [] }]),
  baselineMeasurementId: 11,
  diagnostics: [],
  omittedDiagnosticGroups: 0,
  excluded: {
    'missing-block': 0,
    'extra-block': 0,
    'invalid-tensor': 0,
    'fixed-layout-mismatch': 0,
    'layout-mismatch': 0,
  },
}

class FakePredictionWorker {
  static instances: FakePredictionWorker[] = []

  onerror: ((event: ErrorEvent) => void) | null = null
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  postMessage = vi.fn<(message: PredictionWorkerRequest) => void>()
  terminate = vi.fn()

  constructor() {
    FakePredictionWorker.instances.push(this)
  }

  respond(response: unknown) {
    this.onmessage?.({ data: response } as MessageEvent<unknown>)
  }
}

beforeEach(() => {
  let requestId = 0
  FakePredictionWorker.instances = []
  vi.stubGlobal('Worker', FakePredictionWorker)
  vi.stubGlobal('crypto', { randomUUID: () => `request-${(requestId += 1)}` })
})

afterEach(() => vi.unstubAllGlobals())

describe('Prediction Worker protocol validation', () => {
  it('accepts a complete model profile, preserves extensions, and retains its typed array', () => {
    const response = parsePredictionWorkerResponseForRequest(
      {
        type: 'model-ready',
        requestId: buildRequest.requestId,
        modelId: buildRequest.modelId,
        generation: buildRequest.generation,
        fingerprint: buildRequest.fingerprint,
        profile: { ...profile, futureProfileField: true },
        futureEnvelopeField: 'preserved',
      },
      buildRequest,
    )

    expect(response.type).toBe('model-ready')
    if (response.type !== 'model-ready') throw new Error('Expected a model-ready response.')
    expect(response.profile.inputScales).toBe(profile.inputScales)
    expect(Reflect.get(response, 'futureEnvelopeField')).toBe('preserved')
    expect(Reflect.get(response.profile, 'futureProfileField')).toBe(true)
  })

  it('accepts a model whose input components are all constant', () => {
    const response = parsePredictionWorkerResponseForRequest(
      {
        type: 'model-ready',
        requestId: buildRequest.requestId,
        modelId: buildRequest.modelId,
        generation: buildRequest.generation,
        fingerprint: buildRequest.fingerprint,
        profile: { ...profile, activeInputBlockCount: 0, inputScales: new Float64Array([0]) },
      },
      buildRequest,
    )

    expect(response.type).toBe('model-ready')
    if (response.type !== 'model-ready') throw new Error('Expected a model-ready response.')
    expect(response.profile.activeInputBlockCount).toBe(0)
  })

  it('rejects malformed typed arrays, tensor shapes, and model identities', () => {
    expect(() =>
      parsePredictionWorkerResponse({
        type: 'model-ready',
        requestId: 'request-1',
        modelId: 'inverse',
        generation: 3,
        fingerprint: 'fingerprint-v1',
        profile: { ...profile, inputScales: [100] },
      }),
    ).toThrow()
    expect(() =>
      parsePredictionWorkerResponse({
        type: 'prediction',
        requestId: 'request-2',
        modelId: 'inverse',
        generation: 3,
        fingerprint: 'fingerprint-v1',
        result: {
          direction: 'inverse',
          fingerprint: 'fingerprint-v1',
          output: [{ layout, values: [] }],
          neighbors: [{ measurementId: 11, distanceSquared: 0, weight: 1 }],
          extrapolatedInputKeys: [],
          constantInputKeysChanged: [],
          queryDiagnostics: [],
        },
      }),
    ).toThrow(/values/i)
    expect(() =>
      parsePredictionWorkerResponseForRequest(
        {
          type: 'model-ready',
          requestId: buildRequest.requestId,
          modelId: 'another-model',
          generation: buildRequest.generation,
          fingerprint: buildRequest.fingerprint,
          profile,
        },
        buildRequest,
      ),
    ).toThrow(/identity/i)
    expect(() =>
      parsePredictionWorkerResponse({
        type: 'model-ready',
        requestId: 'request-1',
        modelId: 'inverse',
        generation: 3,
        fingerprint: 'fingerprint-v1',
        profile: { ...profile, dominantShapeSignature: 'not-json' },
      }),
    ).toThrow(/shape signature/i)
  })

  it('accepts complete prediction results and sampling profiles', () => {
    const predictionRequest: PredictionWorkerRequest = {
      type: 'predict',
      requestId: 'request-2',
      modelId: 'inverse',
      generation: 3,
      fingerprint: 'fingerprint-v1',
      query: [sample],
    }
    const prediction = parsePredictionWorkerResponseForRequest(
      {
        type: 'prediction',
        requestId: predictionRequest.requestId,
        modelId: predictionRequest.modelId,
        generation: predictionRequest.generation,
        fingerprint: predictionRequest.fingerprint,
        result: {
          direction: 'inverse',
          fingerprint: predictionRequest.fingerprint,
          output: [sample],
          neighbors: [{ measurementId: 11, distanceSquared: 0.25, weight: 1 }],
          extrapolatedInputKeys: ['temperature'],
          constantInputKeysChanged: [],
          queryDiagnostics: [
            {
              blockKey: 'temperature',
              fieldPath: 'unit',
              expected: 'K',
              actual: '°C',
              mismatchCount: 1,
              firstMismatchIndex: 0,
              maxAbsoluteDifference: 0,
            },
          ],
        },
      },
      predictionRequest,
    )
    expect(prediction.type).toBe('prediction')

    const samplingRequest: PredictionWorkerRequest = {
      type: 'start-sampling',
      requestId: 'request-3',
      sessionId: 'sampling-1',
      options: {
        fingerprint: 'sampling-fingerprint',
        totalAttempts: 2,
        layouts: [layout],
        ranges: { temperature: { min: 0, max: 100 } },
        centers: [[sample]],
      },
    }
    const sampling = parsePredictionWorkerResponseForRequest(
      {
        type: 'sampling-ready',
        requestId: samplingRequest.requestId,
        sessionId: samplingRequest.sessionId,
        fingerprint: samplingRequest.options.fingerprint,
        profile: {
          activeBlockCount: 1,
          activeComponentCount: 1,
          existingCenterCount: 1,
          candidateCount: 32,
        },
      },
      samplingRequest,
    )
    expect(sampling.type).toBe('sampling-ready')
  })

  it('validates sampling response identity and inbound tensor layouts', () => {
    const nextSampleRequest: PredictionWorkerRequest = {
      type: 'next-sample',
      requestId: 'request-2',
      sessionId: 'sampling-1',
      fingerprint: 'sampling-fingerprint',
      attempt: 1,
    }
    const response = parsePredictionWorkerResponseForRequest(
      {
        type: 'sampling-candidate',
        requestId: 'request-2',
        sessionId: 'sampling-1',
        fingerprint: 'sampling-fingerprint',
        sample: [sample],
      },
      nextSampleRequest,
    )
    expect(response.type).toBe('sampling-candidate')

    expect(() =>
      parsePredictionWorkerResponseForRequest(
        {
          type: 'sampling-candidate',
          requestId: 'request-2',
          sessionId: 'another-session',
          fingerprint: 'sampling-fingerprint',
          sample: [sample],
        },
        nextSampleRequest,
      ),
    ).toThrow(/session/i)
    expect(() =>
      parsePredictionWorkerRequest({
        type: 'predict',
        requestId: 'request-3',
        modelId: 'inverse',
        generation: 3,
        fingerprint: 'fingerprint-v1',
        query: [
          {
            layout: {
              key: 'field',
              dtype: 'float64',
              shape: [2],
              axes: [{ name: 'x', ticks: [0] }],
            },
            values: [1, 2],
          },
        ],
      }),
    ).toThrow(/ticks/i)
  })
})

describe('PredictionWorkerClient contract failures', () => {
  it('rejects a malformed current response, clears pending work, and replaces the Worker', async () => {
    const client = new PredictionWorkerClient()
    const worker = FakePredictionWorker.instances[0]
    const result = client.build('inverse', 3, 'fingerprint-v1', buildOptions).catch((error: unknown) => error)
    const request = worker.postMessage.mock.calls[0]?.[0]
    if (request?.type !== 'build-model') throw new Error('Expected a build-model request.')

    worker.respond({
      type: 'model-ready',
      requestId: request.requestId,
      modelId: request.modelId,
      generation: request.generation,
      fingerprint: request.fingerprint,
      profile: { ...profile, inputScales: [100] },
    })

    expect(await result).toBeInstanceOf(PredictionWorkerContractError)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(FakePredictionWorker.instances).toHaveLength(2)
    expect(client.cancelPending()).toBe(false)
    client.dispose()
  })

  it('deterministically rejects every pending request when an active response has no requestId', async () => {
    const client = new PredictionWorkerClient()
    const worker = FakePredictionWorker.instances[0]
    const buildResult = client.build('inverse', 3, 'fingerprint-v1', buildOptions).catch((error: unknown) => error)
    const samplingResult = client
      .startSampling('sampling-1', {
        fingerprint: 'sampling-fingerprint',
        totalAttempts: 2,
        layouts: [layout],
        ranges: { temperature: { min: 0, max: 100 } },
        centers: [],
      })
      .catch((error: unknown) => error)

    worker.respond({ type: 'sampling-ready', sessionId: 'sampling-1' })

    const buildError = await buildResult
    const samplingError = await samplingResult
    expect(buildError).toBeInstanceOf(PredictionWorkerContractError)
    expect(samplingError).toBe(buildError)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(FakePredictionWorker.instances).toHaveLength(2)
    expect(client.cancelPending()).toBe(false)
    client.dispose()
  })
})
