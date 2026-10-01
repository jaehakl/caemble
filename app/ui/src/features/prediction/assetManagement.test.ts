import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PredictionOperation } from '@/contracts/api/prediction'
import { PredictionAssetController } from './assetManagement'

const mocks = vi.hoisted(() => ({
  models: vi.fn(),
  datasets: vi.fn(),
  storages: vi.fn(),
  operations: vi.fn(),
  launchers: vi.fn(),
  cancelOperation: vi.fn(),
  interruptOperation: vi.fn(),
  cancelJob: vi.fn(),
  remotes: [] as { launcherId: string; dispose: ReturnType<typeof vi.fn> }[],
}))
vi.mock('@/api/prediction', () => ({
  predictionApi: {
    models: mocks.models,
    datasets: mocks.datasets,
    storages: mocks.storages,
    operations: mocks.operations,
    cancelOperation: mocks.cancelOperation,
    interruptOperation: mocks.interruptOperation,
  },
}))
vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    listLaunchers = mocks.launchers
    cancelJob = mocks.cancelJob
  },
}))
vi.mock('./remoteAssets', () => ({ reconcileRemoteAssets: vi.fn() }))
vi.mock('./remoteExecution', () => ({
  RemotePredictionExecution: class {
    dispose = vi.fn()
    inspect = vi.fn().mockResolvedValue({})
    constructor(readonly launcherId: string) {
      mocks.remotes.push(this)
    }
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const operation = (state: string) => ({ id: 'operation', state }) as PredictionOperation

beforeEach(() => {
  vi.clearAllMocks()
  mocks.remotes.length = 0
  for (const request of [mocks.models, mocks.datasets, mocks.storages, mocks.operations, mocks.launchers])
    request.mockResolvedValue([])
  mocks.cancelOperation.mockResolvedValue(operation('cancelled'))
  mocks.interruptOperation.mockResolvedValue(operation('interrupted'))
})

describe('Prediction asset task ownership', () => {
  it('lists metadata without starting a Predictor process', async () => {
    const manager = new PredictionAssetController('owner', 12)
    await manager.refresh()
    expect(mocks.models).toHaveBeenCalledWith(12)
    expect(mocks.operations).toHaveBeenCalledWith(12)
    expect(mocks.remotes).toHaveLength(0)
  })

  it('finishes a started operation after the last panel unsubscribes', async () => {
    const manager = new PredictionAssetController('owner', 12)
    const release = deferred<string>()
    const unsubscribe = manager.subscribe(vi.fn())
    const running = manager.run('copy:a', '백업', async (work) => {
      await work.connect('launcher-a')
      return release.promise
    })
    await vi.waitFor(() => expect(mocks.remotes).toHaveLength(1))
    unsubscribe()
    expect(mocks.remotes[0].dispose).not.toHaveBeenCalled()
    release.resolve('stored')
    expect(await running).toBe('stored')
    expect(manager.getSnapshot().tasks[0].state).toBe('succeeded')
    expect(mocks.remotes[0].dispose).toHaveBeenCalledOnce()
  })

  it('cancels only the selected management operation', async () => {
    const manager = new PredictionAssetController('owner', 12)
    const first = deferred<void>()
    const second = deferred<void>()
    const a = manager.run('copy:a', 'A 백업', async (work) => {
      await work.connect('launcher-a')
      work.operation(operation('running'))
      return first.promise
    })
    const b = manager.run('copy:b', 'B 백업', async (work) => {
      await work.connect('launcher-b')
      return second.promise
    })
    await vi.waitFor(() =>
      expect(manager.getSnapshot().tasks.find((task) => task.key === 'copy:a')?.operationId).toBe('operation'),
    )
    await manager.cancelTask(manager.getSnapshot().tasks.find((task) => task.key === 'copy:a')!.id)
    expect(mocks.cancelOperation).toHaveBeenCalledWith('operation')
    expect(mocks.remotes.find((remote) => remote.launcherId === 'launcher-b')?.dispose).not.toHaveBeenCalled()
    first.resolve()
    second.resolve()
    await Promise.all([a, b])
    expect(manager.getSnapshot().tasks.find((task) => task.key === 'copy:a')?.state).toBe('cancelled')
    expect(manager.getSnapshot().tasks.find((task) => task.key === 'copy:b')?.state).toBe('succeeded')
  })

  it('does not call pending offline deletion complete', async () => {
    const manager = new PredictionAssetController('owner', 12)
    await manager.run('delete:a', '복사본 삭제', async (work) => {
      work.operation(operation('pending'))
    })
    expect(manager.getSnapshot().tasks[0]).toMatchObject({
      state: 'waiting',
      message: expect.stringContaining('확인 대기'),
    })
  })

  it('keeps a stable request identity on retry and records interruption', async () => {
    const manager = new PredictionAssetController('owner', 12)
    const requestId = crypto.randomUUID()
    const received: string[] = []
    await manager.run('backup:a', '백업', async (work) => {
      received.push(requestId)
      work.operation(operation(received.length === 1 ? 'running' : 'completed'))
      if (received.length === 1) throw new Error('응답 유실')
    })
    expect(mocks.interruptOperation).toHaveBeenCalledWith('operation', '응답 유실')
    await manager.retryTask(manager.getSnapshot().tasks[0].id)
    expect(received).toEqual([requestId, requestId])
    expect(manager.getSnapshot().tasks[0].state).toBe('succeeded')
  })

  it('updates a waiting local task when a later process confirms deletion', async () => {
    const manager = new PredictionAssetController('owner', 12)
    await manager.run('delete:a', '복사본 삭제', async (work) => work.operation(operation('pending')))
    expect(manager.getSnapshot().tasks[0].state).toBe('waiting')
    mocks.operations.mockResolvedValue([operation('completed')])
    await manager.refresh()
    expect(manager.getSnapshot().tasks[0]).toMatchObject({ state: 'succeeded', message: '완료' })
  })

  it('rejects a duplicate in-flight action but permits another asset', async () => {
    const manager = new PredictionAssetController('owner', 12)
    const pending = deferred<void>()
    const running = manager.run('backup:a', '백업', () => pending.promise)
    const duplicate = vi.fn()
    await manager.run('backup:a', '백업', duplicate)
    expect(duplicate).not.toHaveBeenCalled()
    const other = vi.fn()
    await manager.run('backup:b', '다른 백업', other)
    expect(other).toHaveBeenCalledOnce()
    pending.resolve()
    await running
  })
})
