import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobSession } from '@gpstation/v1-master-js-sdk'
import { predictionApi } from '@/api/prediction'
import { RemotePredictionExecution, type PredictionTransport } from './remoteExecution'
import type { PredictionDatasetInput, PredictionModelDefinition, SavedPredictionModel } from './execution'
import { RemotePredictionError } from './remoteProtocol'

const launcherId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const storageId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const reference: SavedPredictionModel = {
  modelId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
  modelRevision: 2,
  datasetId: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
  datasetRevision: 3,
  direction: 'forward',
  fingerprint: 'model-fingerprint',
  storageId,
  launcherId,
  manifestChecksum: 'a'.repeat(64),
}
const profile = {
  direction: 'forward',
  rowCount: 2,
  inputLayouts: [],
  inputSize: 1,
  outputSize: 1,
  includedMeasurementIds: [1, 2],
  warningMeasurementIds: [],
  diagnostics: [],
  omittedDiagnosticGroups: 0,
  excluded: {
    'missing-block': 0,
    'extra-block': 0,
    'invalid-tensor': 0,
    'fixed-layout-mismatch': 0,
    'layout-mismatch': 0,
  },
  knn: {
    dominantShapeSignature: 'one',
    baselineMeasurementId: 1,
    k: 1,
    weighting: 'distance',
    inputScaling: 'range',
    inputScales: [1],
    inputBlockWeights: {},
    activeInputBlockCount: 1,
  },
}
const artifact = {
  modelId: reference.modelId,
  revision: 2,
  operationId: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
  name: 'Forward',
  direction: 'forward',
  algorithm: 'knn',
  definition: { fingerprint: reference.fingerprint },
  datasetId: reference.datasetId,
  datasetRevision: 3,
  datasetFingerprint: 'dataset-fingerprint',
  storageId,
  launcherId,
  manifestChecksum: 'a'.repeat(64),
  formatVersion: 1,
  files: [{ name: 'model.json', sha256: 'b'.repeat(64), byteLength: 1 }],
  profile,
  inputLayouts: [],
  outputLayouts: [],
}
const request = (requestId: string, abort = new AbortController()) => ({ requestId, signal: abort.signal })
const datasetInput: PredictionDatasetInput = {
  kind: 'dataset-revision',
  direction: 'forward',
  fingerprint: artifact.datasetFingerprint,
  dataset: {
    datasetId: reference.datasetId,
    revision: reference.datasetRevision,
    fingerprint: artifact.datasetFingerprint,
  },
  model: {
    modelId: reference.modelId,
    revision: reference.modelRevision,
    operationId: artifact.operationId,
    name: artifact.name,
  },
}
const definition: PredictionModelDefinition = {
  fingerprint: reference.fingerprint,
  snapshotFingerprint: artifact.datasetFingerprint,
  implementationId: 'remote-knn',
  implementationVersion: 'knn-v1',
  preprocessingVersion: 'box-relative-v2',
  algorithm: { kind: 'knn', kMode: 'auto', manualK: 1, weighting: 'distance', calculationWeights: {} },
}

function transportFixture() {
  const calls: Array<{ type: string; body: Record<string, unknown> }> = []
  const sessions: JobSession[] = []
  let predictGate: Promise<void> | null = null
  let completePrediction: (() => void) | null = null
  let wrongRequest = false
  let modelGate: Promise<void> | null = null
  let completeModel: (() => void) | null = null
  let artifactOverride: Record<string, unknown> = {}
  let modelError: string | null = null
  let instanceSession: string | null = null
  const transport: PredictionTransport = {
    cancel: vi.fn(async () => undefined),
    connect: vi.fn(async (requestId) => {
      const sessionId = `wire-${sessions.length + 1}`
      const session: JobSession = {
        jobId: crypto.randomUUID(),
        execution: undefined,
        closed: false,
        finish: vi.fn(async () => undefined),
        close: vi.fn(() => {
          Object.defineProperty(session, 'closed', { value: true, configurable: true })
        }),
        call: async <TInput, TResult>(type: string, input?: TInput) => {
          const body = input as Record<string, unknown>
          calls.push({ type, body })
          const envelope = { protocolVersion: 1, requestId: wrongRequest ? 'wrong-request' : body.requestId, sessionId }
          let result: unknown = { released: true }
          if (type === 'model.load' || type === 'model.prepare') {
            if (modelGate) {
              const gate = modelGate
              modelGate = null
              await gate
            }
            result = modelError
              ? { error: { code: modelError, message: 'Model could not be loaded.' } }
              : {
                  fingerprint: reference.fingerprint,
                  instance: {
                    executionId: 'remote-knn',
                    sessionId: instanceSession ?? sessionId,
                    generation: 1,
                    handle: 'wire-handle',
                  },
                  profile,
                  errors: {},
                  recordProfiles: [],
                  rules: [],
                  artifact: { ...artifact, ...artifactOverride },
                }
          }
          if (type === 'model.predict') {
            if (predictGate) {
              const gate = predictGate
              predictGate = null
              await gate
            }
            result = {
              direction: 'forward',
              fingerprint: reference.fingerprint,
              output: [
                {
                  layout: { key: 'value', dtype: 'float64', shape: [] },
                  values: [(body.input as { vars: { x: number } }).vars.x],
                },
              ],
              extrapolatedInputKeys: [],
              constantInputKeysChanged: [],
              queryDiagnostics: [],
              provenance: {
                modelId: reference.modelId,
                modelRevision: 2,
                datasetId: reference.datasetId,
                datasetRevision: 3,
              },
            }
          }
          return { payload: { ...envelope, ...(result as object) } as TResult, files: [] }
        },
      }
      sessions.push(session)
      return {
        session,
        payload: {
          protocolVersion: 1,
          requestId,
          sessionId,
          storageId,
          launcherId,
          implementationVersion: 'knn-v1',
          preprocessingVersion: 'box-relative-v2',
          capabilities: {},
          datasets: [],
          models: [],
        },
      }
    }),
  }
  return {
    transport,
    calls,
    sessions,
    delayNextPrediction() {
      predictGate = new Promise<void>((resolve) => {
        completePrediction = resolve
      })
      return () => completePrediction!()
    },
    delayNextModel() {
      modelGate = new Promise<void>((resolve) => {
        completeModel = resolve
      })
      return () => completeModel!()
    },
    setArtifact(value: Record<string, unknown>) {
      artifactOverride = value
    },
    setModelError(value: string) {
      modelError = value
    },
    setInstanceSession(value: string) {
      instanceSession = value
    },
    wrongRequest() {
      wrongRequest = true
    },
  }
}

beforeEach(() => {
  vi.spyOn(predictionApi, 'lease').mockResolvedValue({ leased: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('remote Prediction execution lifecycle', () => {
  it.each(['load', 'prepare'] as const)(
    'releases a late %s result after caller cancellation without deleting the artifact',
    async (operation) => {
      const fixture = transportFixture()
      const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport })
      const complete = fixture.delayNextModel()
      const abort = new AbortController()
      const promise =
        operation === 'load'
          ? remote.load(reference, request('model', abort))
          : remote.prepare(datasetInput, definition, request('model', abort))
      const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => expect(fixture.calls).toHaveLength(1))
      abort.abort()
      await rejected
      complete()
      await vi.waitFor(() => expect(fixture.calls.some((call) => call.type === 'model.release')).toBe(true))
      expect(predictionApi.lease).toHaveBeenLastCalledWith(reference.modelId, 2, fixture.sessions[0].jobId, true)
      expect(fixture.transport.cancel).not.toHaveBeenCalled()
      expect(fixture.calls.some((call) => call.type === 'model.delete')).toBe(false)
      remote.dispose()
    },
  )

  it.each([
    { manifestChecksum: 'c'.repeat(64) },
    { datasetId: 'another-dataset' },
    { datasetRevision: 4 },
    { direction: 'inverse' },
  ])('fails closed when a loaded artifact differs from its saved identity: %j', async (change) => {
    const fixture = transportFixture()
    fixture.setArtifact(change)
    const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport })
    await expect(remote.load(reference, request('load'))).rejects.toMatchObject({ code: 'model-mismatch' })
    expect(remote.state).toBe('failed')
    expect(fixture.sessions[0].closed).toBe(true)
    expect(fixture.transport.cancel).toHaveBeenCalledWith(fixture.sessions[0].jobId)
    remote.dispose()
  })

  it('checks the preparation operation and pinned Dataset fingerprint before owning an instance', async () => {
    const fixture = transportFixture()
    fixture.setArtifact({ operationId: 'another-operation' })
    const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport })
    await expect(remote.prepare(datasetInput, definition, request('prepare'))).rejects.toMatchObject({
      code: 'model-mismatch',
    })
    expect(fixture.transport.cancel).toHaveBeenCalledWith(fixture.sessions[0].jobId)
    remote.dispose()
  })

  it('closes a session when hello reconciliation rejects it with an application error', async () => {
    const fixture = transportFixture()
    const remote = new RemotePredictionExecution(launcherId, {
      transport: fixture.transport,
      onHello: async () => {
        throw new RemotePredictionError('reconciliation', 'Storage rejected.')
      },
    })
    await expect(remote.load(reference, request('load'))).rejects.toMatchObject({ code: 'reconciliation' })
    expect(fixture.sessions[0].closed).toBe(true)
    expect(remote.state).toBe('failed')
    expect(fixture.calls).toEqual([])
    await expect(remote.load(reference, request('retry'))).rejects.toMatchObject({
      name: 'PredictionInstanceInvalidatedError',
    })
    expect(fixture.sessions).toHaveLength(1)
    remote.dispose()
  })

  it('does not resurrect connected state after disposal during hello reconciliation', async () => {
    const fixture = transportFixture()
    let complete!: () => void
    const hello = new Promise<void>((resolve) => {
      complete = resolve
    })
    const onHello = vi.fn(() => hello)
    const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport, onHello })
    const loading = remote.load(reference, request('load'))
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(onHello).toHaveBeenCalledOnce())
    remote.dispose()
    complete()
    await rejected
    await Promise.resolve()
    expect(remote.state).toBe('disconnected')
    expect(fixture.sessions[0].closed).toBe(true)
    expect(fixture.calls).toEqual([])
  })

  it('discards an active superseded result and only sends the latest waiting prediction', async () => {
    const fixture = transportFixture()
    const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport })
    const model = await remote.load(reference, request('load'))
    const complete = fixture.delayNextPrediction()
    const abort = new AbortController()
    const first = remote.predict(model.instance, { direction: 'forward', vars: { x: 1 } }, request('first', abort))
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fixture.calls.filter((item) => item.type === 'model.predict')).toHaveLength(1))
    const second = remote.predict(model.instance, { direction: 'forward', vars: { x: 2 } }, request('second'))
    const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    const third = remote.predict(model.instance, { direction: 'forward', vars: { x: 3 } }, request('third'))
    abort.abort()
    await firstRejected
    await secondRejected
    complete()
    expect((await third).output[0].values).toEqual([3])
    expect(fixture.calls.filter((item) => item.type === 'model.predict').map((item) => item.body.requestId)).toEqual([
      'first',
      'third',
    ])
    expect(fixture.transport.cancel).not.toHaveBeenCalled()
    remote.dispose()
  })

  it('releases idle resources and loads exactly the same saved revision in a new session', async () => {
    vi.useFakeTimers()
    const fixture = transportFixture()
    const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport, idleMs: 300_000 })
    const model = await remote.load(reference, request('load'))
    await vi.advanceTimersByTimeAsync(299_999)
    expect(fixture.sessions[0].finish).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.sessions[0].finish).toHaveBeenCalledOnce()
    expect(remote.state).toBe('idle')
    await remote.predict(model.instance, { direction: 'forward', vars: { x: 4 } }, request('next'))
    expect(fixture.sessions).toHaveLength(2)
    expect(
      fixture.calls.filter((item) => item.type === 'model.load').map((item) => [item.body.modelId, item.body.revision]),
    ).toEqual([
      [reference.modelId, 2],
      [reference.modelId, 2],
    ])
    expect(fixture.calls.some((item) => item.type === 'model.prepare')).toBe(false)
    remote.dispose()
  })

  it('does not count an active request as idle and explicit stop settles it', async () => {
    vi.useFakeTimers()
    const fixture = transportFixture()
    const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport, idleMs: 100 })
    const model = await remote.load(reference, request('load'))
    const complete = fixture.delayNextPrediction()
    const prediction = remote.predict(model.instance, { direction: 'forward', vars: { x: 1 } }, request('pending'))
    const rejected = expect(prediction).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.sessions[0].finish).not.toHaveBeenCalled()
    remote.dispose()
    await rejected
    expect(fixture.transport.cancel).toHaveBeenCalledWith(fixture.sessions[0].jobId)
    complete()
  })

  it.each(['checksum', 'session'] as const)('checks %s identity when reloading after idle', async (mismatch) => {
    vi.useFakeTimers()
    const fixture = transportFixture()
    const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport, idleMs: 100 })
    const model = await remote.load(reference, request('load'))
    await vi.advanceTimersByTimeAsync(100)
    if (mismatch === 'checksum') fixture.setArtifact({ manifestChecksum: 'c'.repeat(64) })
    else fixture.setInstanceSession('old-session')
    await expect(
      remote.predict(model.instance, { direction: 'forward', vars: { x: 1 } }, request('predict')),
    ).rejects.toMatchObject({ code: 'model-mismatch' })
    expect(remote.state).toBe('failed')
    expect(fixture.sessions[1].closed).toBe(true)
    expect(fixture.calls.some((call) => call.type === 'model.predict')).toBe(false)
    remote.dispose()
  })

  it('releases a failed idle reload lease while retaining leases of other loaded handles', async () => {
    vi.useFakeTimers()
    const fixture = transportFixture()
    const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport, idleMs: 100 })
    const model = await remote.load(reference, request('load'))
    fixture.setModelError('artifact-missing')
    vi.mocked(predictionApi.lease).mockClear()
    await expect(remote.load(reference, request('another-load'))).rejects.toMatchObject({ code: 'artifact-missing' })
    expect(predictionApi.lease).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    vi.mocked(predictionApi.lease).mockClear()
    await expect(
      remote.predict(model.instance, { direction: 'forward', vars: { x: 1 } }, request('predict')),
    ).rejects.toMatchObject({ code: 'artifact-missing' })
    expect(predictionApi.lease).toHaveBeenLastCalledWith(reference.modelId, 2, fixture.sessions[1].jobId, true)
    expect(remote.state).toBe('connected')
    remote.dispose()
  })

  it('releases a handle removed while its idle reload is in flight', async () => {
    vi.useFakeTimers()
    const fixture = transportFixture()
    const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport, idleMs: 100 })
    const model = await remote.load(reference, request('load'))
    await vi.advanceTimersByTimeAsync(100)
    const complete = fixture.delayNextModel()
    const prediction = remote.predict(model.instance, { direction: 'forward', vars: { x: 1 } }, request('predict'))
    const rejected = expect(prediction).rejects.toMatchObject({ name: 'PredictionInstanceInvalidatedError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.calls.filter((call) => call.type === 'model.load')).toHaveLength(2)
    await remote.release(model.instance)
    complete()
    await rejected
    expect(fixture.calls.filter((call) => call.type === 'model.release')).toHaveLength(1)
    expect(predictionApi.lease).toHaveBeenLastCalledWith(reference.modelId, 2, fixture.sessions[1].jobId, true)
    expect(fixture.calls.some((call) => call.type === 'model.predict')).toBe(false)
    remote.dispose()
  })

  it('requires explicit reconnection after unexpected disconnect', async () => {
    const fixture = transportFixture()
    const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport })
    const model = await remote.load(reference, request('load'))
    fixture.sessions[0].close()
    await expect(
      remote.predict(model.instance, { direction: 'forward', vars: { x: 1 } }, request('predict')),
    ).rejects.toMatchObject({ name: 'PredictionInstanceInvalidatedError', retryable: false })
    expect(fixture.sessions).toHaveLength(1)
    remote.dispose()
  })

  it('rejects stale response identity and releases RAM independently of stored files', async () => {
    const fixture = transportFixture()
    const remote = new RemotePredictionExecution(launcherId, { transport: fixture.transport })
    const model = await remote.load(reference, request('load'))
    await remote.release(model.instance)
    expect(fixture.calls[fixture.calls.length - 1]?.type).toBe('model.release')
    expect(fixture.calls.some((item) => item.type === 'model.delete')).toBe(false)
    const next = await remote.load(reference, request('load-again'))
    fixture.wrongRequest()
    await expect(
      remote.predict(next.instance, { direction: 'forward', vars: { x: 1 } }, request('stale')),
    ).rejects.toMatchObject({ code: 'stale-response' })
    remote.dispose()
  })
})
