import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalculationDataOutput, PersistedMeasurementRecord, RecordedDataRecord } from '@/api'
import { BOX_GRID_AXES, type BoxGridData } from '@/contracts/boxGrid'
import type { RecordedDataRule } from '@/lib/cad/model'
import { createDataTensor, isDataTensor } from '@/lib/cad/model/dataTensor'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import { BrowserPredictionExecution } from './browserExecution'
import { BrowserPredictionSamplingService } from './browserSampling'
import { PredictionWorkerClient } from './client'
import { PredictionInstanceInvalidatedError, type PredictionModelDefinition } from './execution'
import { buildPredictionKnnModel, predictWithKnn, type PredictionKnnModel } from './knn'
import type { PredictionWorkerRequest, PredictionWorkerResponse } from './protocol'
import type { TrainingSnapshot } from './trainingSnapshot'

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('@/api/objectStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/objectStorage')>()),
  resolveObjects: mocks.resolve,
}))

class NumericalWorker {
  static instances: NumericalWorker[] = []
  static held = new Set<PredictionWorkerRequest['type']>()
  readonly models = new Map<string, PredictionKnnModel>()
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminate = vi.fn(() => this.models.clear())
  postMessage = vi.fn((request: PredictionWorkerRequest) => {
    if (!NumericalWorker.held.has(request.type)) queueMicrotask(() => this.complete(request))
  })

  constructor() {
    NumericalWorker.instances.push(this)
  }

  complete(request: PredictionWorkerRequest) {
    let response: PredictionWorkerResponse
    try {
      if (request.type === 'build-model') {
        const model = buildPredictionKnnModel(request.options)
        this.models.set(request.modelId, model)
        response = {
          ...request,
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
            ...model.memory,
            ...model.cohort,
          },
        }
      } else if (request.type === 'predict') {
        const model = this.models.get(request.modelId)
        response = model
          ? { ...request, type: 'prediction', result: predictWithKnn(model, request.query, request.fingerprint) }
          : { ...request, type: 'stale' }
      } else if (request.type === 'drop-model') {
        this.models.delete(request.modelId)
        response = { ...request, type: 'model-dropped' }
      } else if (request.type === 'drop-sampling') {
        response = { ...request, type: 'sampling-dropped' }
      } else return
    } catch (error) {
      response = { ...request, type: 'error', code: 'invalid-data', message: String(error) }
    }
    this.onmessage?.({ data: response } as MessageEvent<unknown>)
  }
}

beforeEach(() => {
  NumericalWorker.instances = []
  NumericalWorker.held = new Set()
  vi.stubGlobal('Worker', NumericalWorker)
  mocks.resolve.mockReset().mockImplementation(async (_client, rows: readonly RecordedDataRecord[]) => rows)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const request = (signal = new AbortController().signal) => ({ requestId: crypto.randomUUID(), signal })
const scalar = (value: number): CalculationDataOutput => ({ dtype: 'float64', shape: [], axes: [], data: value })

function inverseSnapshot(): Extract<TrainingSnapshot, { direction: 'inverse' }> {
  return {
    fingerprint: 'snapshot-v1',
    sourceFingerprint: 'source-v1',
    experimentId: 1,
    representationVersion: 'raw-v1',
    direction: 'inverse',
    varsSchema: { x: { shape: [], min: 0, max: 10 } },
    measurements: [0, 5, 10].map((x, index) => ({
      id: index + 1,
      experiment_id: 1,
      vars: { x },
      recorded_at: '2026-01-01',
      material_snapshot: {} as PersistedMeasurementRecord['material_snapshot'],
      calculation_data_count: 1,
    })),
    calculations: [
      {
        id: 7,
        source_id: 7,
        revision: 1,
        calculation_data_count: 3,
        recorded_measurement_count: 3,
        measurement_count: 3,
        experiment_id: 1,
        name: 'temperature',
        source_code: 'return 1',
        experiment_record_ids: [4],
        output_layout: { dtype: 'float64', shape: [], axes: [] },
        contract_status: 'ready',
      },
    ],
    calculationData: [0, 10, 20].map((value, index) => ({
      id: index + 1,
      calculation_id: 7,
      measurement_id: index + 1,
      data: scalar(value),
    })),
  }
}

function definition(execution: BrowserPredictionExecution, snapshot: TrainingSnapshot): PredictionModelDefinition {
  return {
    fingerprint: `${snapshot.fingerprint}:model`,
    snapshotFingerprint: snapshot.fingerprint,
    algorithm: { kind: 'knn', kMode: 'manual', manualK: 2, weighting: 'uniform', calculationWeights: {} },
    implementationId: execution.id,
    implementationVersion: execution.implementationVersion,
    preprocessingVersion: execution.preprocessingVersion,
  }
}

function forwardSnapshot(modal = false): Extract<TrainingSnapshot, { direction: 'forward' }> {
  const boxGrid: BoxGridData = {
    version: 1,
    sampling: 'point',
    components: ['scalar'],
    channels: ['value'],
    channelUnits: ['K'],
    origin: [0, 0, 0],
    size: [1, 1, 1],
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    gridShape: [1, 1, 1],
    lengthUnit: 'm',
    source: 'task',
    rootId: 'box',
    ...(modal ? { frequencyKind: 'modal' } : {}),
  }
  const ticks = [[0.5], [0.5], [0.5], [0], [0], ['value'], ['scalar']]
  const rule: RecordedDataRule = {
    label: 'temperature',
    target: [],
    methodId: 'fixture',
    parameters: {},
    result: {
      dtype: 'float64',
      unit: 'K',
      quantityKind: 'thermodynamics.Temperature',
      boxGrid,
      axes: BOX_GRID_AXES.map((name, index) => ({
        name,
        ...(index < 3 || (index === 4 && modal) ? {} : { ticks: ticks[index] }),
        ...(index < 3
          ? { unit: 'm' as const, quantityKind: 'space.Length' }
          : index === 3
            ? { unit: 's' as const, quantityKind: 'time.Time' }
            : index === 4
              ? { unit: 'Hz' as const, quantityKind: 'time.Frequency' }
              : {}),
      })),
    },
  }
  const base = inverseSnapshot()
  return {
    ...base,
    direction: 'forward',
    records: [
      {
        id: 4,
        name: 'temperature',
        experiment_id: 1,
        quantity_kind: null,
        dtype: 'float64',
        tensor_order: 0,
        contract_hash: 'contract-v1',
      },
    ],
    rules: [rule],
    resultContracts: {},
    recorded: base.measurements.map((measurement, index) => ({
      id: index + 1,
      name: rule.label,
      measurement_id: measurement.id,
      experiment_record_id: 4,
      dtype: 'float64',
      tensor_order: 0,
      quantity_kind: null,
      data_schema: rule.result,
      data: createDataTensor(rule.result, {
        value: varsTensorFromFlat([index * 10], [1, 1, 1, 1, 1, 1, 1]),
        boxGrid: { ...boxGrid, origin: [index, 0, 0], size: [index + 1, 1, 1] },
        axes: ticks.map((value, axis) => ({ ticks: axis === 4 && modal ? [100 + index * 10] : value })),
      }),
    })),
  }
}

describe('Browser Prediction execution', () => {
  it('preserves inverse values and neighbor order through the common execution boundary', async () => {
    const execution = new BrowserPredictionExecution()
    const snapshot = inverseSnapshot()
    const session = execution.sessionId
    const prepared = await execution.prepare(snapshot, definition(execution, snapshot), request())
    const result = await execution.predict(
      prepared.instance,
      { direction: 'inverse', targets: { 7: scalar(18) } },
      request(),
    )
    expect(execution.sessionId).toBe(session)
    expect(prepared.profile.knn).toMatchObject({ k: 2, weighting: 'uniform', inputScaling: 'standard-deviation' })
    expect(result.output[0].values).toEqual([7.5])
    expect(result.knn?.neighbors.map((neighbor) => neighbor.measurementId)).toEqual([3, 2])
    await execution.release(prepared.instance)
    await execution.release(prepared.instance)
    expect(NumericalWorker.instances[0].models.size).toBe(0)
    await expect(
      execution.predict(prepared.instance, { direction: 'inverse', targets: {} }, request()),
    ).rejects.toBeInstanceOf(PredictionInstanceInvalidatedError)
    execution.dispose()
  })

  it('preserves relative Box Grid training with different physical coordinates', async () => {
    const execution = new BrowserPredictionExecution()
    const snapshot = forwardSnapshot()
    const prepared = await execution.prepare(snapshot, definition(execution, snapshot), request())
    const result = await execution.predict(prepared.instance, { direction: 'forward', vars: { x: 2.5 } }, request())
    expect(prepared.profile.includedMeasurementIds).toEqual([1, 2, 3])
    expect(result.output[0].values).toEqual([5])
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), snapshot.recorded, expect.any(AbortSignal))
    execution.dispose()
  })

  it('keeps modal outputs and frequency ticks together from the nearest measurement', async () => {
    const execution = new BrowserPredictionExecution()
    const snapshot = forwardSnapshot(true)
    const prepared = await execution.prepare(snapshot, definition(execution, snapshot), request())
    const result = await execution.predict(prepared.instance, { direction: 'forward', vars: { x: 4 } }, request())
    expect(prepared.profile.knn?.k).toBe(1)
    expect(result.output[0].values).toEqual([10, 110])
    expect(result.knn?.neighbors.map((neighbor) => neighbor.measurementId)).toEqual([2])
    execution.dispose()
  })

  it('reports unavailable records while retaining usable models', async () => {
    const execution = new BrowserPredictionExecution()
    const source = forwardSnapshot()
    const snapshot = { ...source, records: [...source.records, { ...source.records[0], id: 8, name: 'missing' }] }
    const prepared = await execution.prepare(snapshot, definition(execution, snapshot), request())
    expect(prepared.recordProfiles).toHaveLength(2)
    expect(prepared.recordProfiles[1]).toMatchObject({
      recordId: 8,
      profile: null,
      error: expect.stringContaining('missing'),
    })
    expect(prepared.rules.map((rule) => rule.label)).toEqual(['temperature'])
    await execution.release(prepared.instance)
    expect(NumericalWorker.instances[0].models.size).toBe(0)
    execution.dispose()
  })

  it('cancels an in-flight build, invalidates the session, and ignores its late response', async () => {
    NumericalWorker.held.add('build-model')
    const execution = new BrowserPredictionExecution()
    const snapshot = inverseSnapshot()
    const abort = new AbortController()
    const pending = execution.prepare(snapshot, definition(execution, snapshot), request(abort.signal))
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const worker = NumericalWorker.instances[0]
    const previous = execution.sessionId
    const late = worker.onmessage
    abort.abort()
    await rejected
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(execution.sessionId).not.toBe(previous)
    late?.({
      data: { type: 'error', requestId: worker.postMessage.mock.calls[0][0].requestId, code: 'late', message: 'late' },
    } as MessageEvent<unknown>)
    expect(NumericalWorker.instances).toHaveLength(2)
    execution.dispose()
  })

  it('releases already prepared records when a later record preparation is cancelled', async () => {
    const execution = new BrowserPredictionExecution()
    const source = forwardSnapshot()
    const snapshot = {
      ...source,
      records: [...source.records, { ...source.records[0], id: 8, name: 'temperature2' }],
      rules: [...source.rules, { ...source.rules[0], label: 'temperature2' }],
      recorded: [
        ...source.recorded,
        ...source.recorded.map((row) => ({ ...row, name: 'temperature2', experiment_record_id: 8 })),
      ],
    }
    const abort = new AbortController()
    const pending = execution.prepare(snapshot, definition(execution, snapshot), request(abort.signal))
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const worker = NumericalWorker.instances[0]
    const complete = worker.complete.bind(worker)
    vi.spyOn(worker, 'complete').mockImplementation((message) => {
      complete(message)
      if (message.type === 'build-model') NumericalWorker.held.add('build-model')
    })
    await vi.waitFor(() =>
      expect(worker.postMessage.mock.calls.filter(([message]) => message.type === 'build-model')).toHaveLength(2),
    )
    expect(worker.models.size).toBe(1)
    abort.abort()
    await rejected
    expect(worker.models.size).toBe(0)
    expect(worker.terminate).toHaveBeenCalledOnce()
    execution.dispose()
  })

  it('applies the browser size policy before hydrating stored outputs', async () => {
    const execution = new BrowserPredictionExecution()
    const source = forwardSnapshot()
    const first = source.recorded[0]
    if (!isDataTensor(first.data)) throw new Error('Expected a stored tensor')
    const snapshot = { ...source, recorded: [{ ...first, data: { ...first.data, shape: [10_000_001] } }] }
    await expect(execution.prepare(snapshot, definition(execution, snapshot), request())).rejects.toThrow(
      '수치 값 제한',
    )
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(NumericalWorker.instances[0].postMessage).not.toHaveBeenCalled()
    execution.dispose()
  })

  it('rejects late prediction after model release and drops its Worker handle', async () => {
    const execution = new BrowserPredictionExecution()
    const snapshot = inverseSnapshot()
    const prepared = await execution.prepare(snapshot, definition(execution, snapshot), request())
    NumericalWorker.held.add('predict')
    const pending = execution.predict(
      prepared.instance,
      { direction: 'inverse', targets: { 7: scalar(18) } },
      request(),
    )
    const rejected = expect(pending).rejects.toBeInstanceOf(PredictionInstanceInvalidatedError)
    const worker = NumericalWorker.instances[0]
    const prediction = worker.postMessage.mock.calls.find(([message]) => message.type === 'predict')![0]
    const model = worker.models.get('modelId' in prediction ? prediction.modelId : '')!
    await execution.release(prepared.instance)
    if (prediction.type !== 'predict') throw new Error('Expected prediction')
    worker.onmessage?.({
      data: {
        ...prediction,
        type: 'prediction',
        result: predictWithKnn(model, prediction.query, prediction.fingerprint),
      },
    } as MessageEvent<unknown>)
    await rejected
    expect(worker.models.size).toBe(0)
    execution.dispose()
  })

  it('marks a Worker failure recoverable and disposes pending requests without recreating it', async () => {
    NumericalWorker.held.add('build-model')
    const execution = new BrowserPredictionExecution()
    const snapshot = inverseSnapshot()
    const pending = execution.prepare(snapshot, definition(execution, snapshot), request())
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'PredictionInstanceInvalidatedError',
      retryable: true,
    })
    const worker = NumericalWorker.instances[0]
    worker.onerror?.({ message: 'crash' } as ErrorEvent)
    await rejected
    const next = execution.prepare(snapshot, definition(execution, snapshot), request())
    const disposed = expect(next).rejects.toMatchObject({ name: 'AbortError' })
    const current = NumericalWorker.instances[1]
    const lateError = current.onerror
    execution.dispose()
    lateError?.({ message: 'late crash' } as ErrorEvent)
    await disposed
    expect(NumericalWorker.instances).toHaveLength(2)
  })

  it('cancels object hydration before any model is posted without restarting a Worker', async () => {
    let finish!: (rows: readonly RecordedDataRecord[]) => void
    mocks.resolve.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const execution = new BrowserPredictionExecution()
    const snapshot = forwardSnapshot()
    const pendingRequest = request()
    const pending = execution.prepare(snapshot, definition(execution, snapshot), pendingRequest)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    execution.cancel(pendingRequest.requestId)
    await rejected
    finish(snapshot.recorded)
    await Promise.resolve()
    expect(NumericalWorker.instances).toHaveLength(1)
    expect(NumericalWorker.instances[0].postMessage).not.toHaveBeenCalled()
    execution.dispose()
  })
})

it('does not leak pending requests when posting throws or revive a disposed Worker', async () => {
  const client = new PredictionWorkerClient()
  const worker = NumericalWorker.instances[0]
  worker.postMessage.mockImplementationOnce(() => {
    throw new Error('clone failed')
  })
  await expect(client.nextSample('session', 'fingerprint', 1)).rejects.toThrow('clone failed')
  expect(client.cancelPending()).toBe(false)
  const lateError = worker.onerror
  client.dispose()
  lateError?.({ message: 'late crash' } as ErrorEvent)
  client.reset()
  await expect(client.nextSample('session', 'fingerprint', 1)).rejects.toMatchObject({ name: 'AbortError' })
  expect(NumericalWorker.instances).toHaveLength(1)
})

it('keeps sampling lazy and disposes its independent pending Worker on cancellation', async () => {
  const service = new BrowserPredictionSamplingService()
  expect(NumericalWorker.instances).toHaveLength(0)
  const pending = service.startSampling('sample', {
    fingerprint: 'sample-v1',
    totalAttempts: 2,
    layouts: [],
    ranges: {},
    centers: [],
  })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(service.cancelPending()).toBe(true)
  await rejected
  expect(NumericalWorker.instances[0].terminate).toHaveBeenCalledOnce()
  expect(service.cancelPending()).toBe(false)
  service.dispose()
})
