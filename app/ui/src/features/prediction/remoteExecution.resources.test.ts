import { beforeEach, expect, it, vi } from 'vitest'
import { RemotePredictionExecution } from './remoteExecution'

const mocks = vi.hoisted(() => ({ algorithms: vi.fn(), models: vi.fn(), runJob: vi.fn(), cancel: vi.fn() }))
vi.mock('@/api/prediction', () => ({ predictionApi: { algorithms: mocks.algorithms, models: mocks.models } }))
vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    runJob = mocks.runJob
    cancelJob = mocks.cancel
  },
}))

const descriptor = {
  kind: 'test-tensor',
  implementationVersion: 'test-v1',
  preprocessingVersion: 'test-box-v1',
  directions: ['forward'],
  representations: ['box-relative-v2'],
  resources: {
    training: { cpu_cores: 5, gpu_count: 2 },
    inference: { cpu_cores: 2, startup_ram_bytes: 1024, gpu_count: 1, vram_budget_gb: 0.5 },
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.algorithms.mockResolvedValue([descriptor])
  mocks.cancel.mockResolvedValue(undefined)
  mocks.runJob.mockImplementation(async (_type, body) => ({
    session: {
      jobId: 'inference-job',
      closed: false,
      close: vi.fn(),
      call: async (_command: string, request: { requestId: string }) => ({
        payload: {
          protocolVersion: 3,
          requestId: request.requestId,
          sessionId: 'wire-session',
        },
      }),
    },
    payload: {
      protocolVersion: 3,
      requestId: body.requestId,
      sessionId: 'wire-session',
      storageId: 'store',
      launcherId: 'launcher',
      algorithmDescriptors: [descriptor],
      capabilities: {},
      models: [],
      datasets: [],
    },
  }))
})

it('requests the advertised inference resources independently of training requirements and algorithm name', async () => {
  const remote = new RemotePredictionExecution('launcher', { algorithm: 'test-tensor' })
  await remote.command('operation.inspect', {}, { requestId: 'inspect', signal: new AbortController().signal })
  expect(mocks.runJob).toHaveBeenCalledWith(
    'predictor.hello',
    expect.objectContaining({ protocolVersion: 3 }),
    expect.objectContaining({ resources: descriptor.resources.inference }),
  )
  expect(remote.algorithms).toEqual(['test-tensor'])
  expect(remote.directions).toEqual(['forward'])
  remote.dispose()
})

it('resolves the saved model algorithm when metadata is still loading in the view', async () => {
  mocks.models.mockResolvedValue([
    {
      id: 'saved-model',
      algorithm: 'current-algorithm',
      revisions: [
        { revision: 1, definition: { algorithm: { kind: 'test-tensor' } } },
        { revision: 2, definition: { algorithm: { kind: 'current-algorithm' } } },
      ],
    },
  ])
  const remote = new RemotePredictionExecution('launcher', { modelId: 'saved-model', modelRevision: 1 })
  await remote.command('operation.inspect', {}, { requestId: 'inspect', signal: new AbortController().signal })
  expect(mocks.models).toHaveBeenCalled()
  expect(mocks.runJob).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ resources: descriptor.resources.inference }),
  )
  remote.dispose()
})

it('rejects an unsupported algorithm before creating an inference Job', async () => {
  const remote = new RemotePredictionExecution('launcher', { algorithm: 'unavailable' })
  await expect(
    remote.command('operation.inspect', {}, { requestId: 'inspect', signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: 'unsupported-execution' })
  expect(mocks.runJob).not.toHaveBeenCalled()
  remote.dispose()
})
