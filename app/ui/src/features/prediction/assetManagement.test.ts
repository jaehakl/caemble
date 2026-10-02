import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PredictionOperation } from '@/contracts/api/prediction'
import { PredictionAssetController, predictionAssetView, disconnectPredictionOwner } from './assetManagement'

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
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
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
  it('does not interrupt server training when its submission response is lost', async () => {
    const manager = new PredictionAssetController('owner', 12)
    await manager.run('training:a', '학습', async (work) => {
      work.operation({ ...operation('pending'), kind: 'prepare' })
      throw new Error('response lost')
    })
    expect(mocks.interruptOperation).not.toHaveBeenCalled()
    expect(mocks.cancelOperation).not.toHaveBeenCalled()
    expect(manager.getSnapshot().tasks[0].state).toBe('failed')
  })

  it('disconnects observation without cancelling an accepted training Job', async () => {
    const manager = new PredictionAssetController('owner', 12)
    const submitted = {
      ...operation('queued'),
      kind: 'prepare',
      training: { jobId: 'server-training' },
    } as PredictionOperation
    mocks.operations.mockResolvedValue([submitted])
    await manager.run('training:a', '학습', async (work) => {
      await work.connect('launcher')
      work.operation(submitted)
    })
    await manager.disconnectOwner()
    expect(mocks.cancelOperation).not.toHaveBeenCalled()
    expect(mocks.cancelJob).not.toHaveBeenCalledWith('server-training')
    expect(manager.getSnapshot().operations[0].state).toBe('queued')
    await manager.cancelOperation('operation')
    expect(mocks.cancelOperation).toHaveBeenCalledWith('operation')
  })
  it('shares account tasks across views but keeps Experiment lists and selection tokens independent', async () => {
    const account = predictionAssetView('account-view-test', 'all')
    const first = predictionAssetView('account-view-test', 12)
    const second = predictionAssetView('account-view-test', 99)
    mocks.models.mockResolvedValue([
      { id: 'a', experiment_id: 12 },
      { id: 'b', experiment_id: 99 },
    ])
    await account.refresh()
    expect(mocks.models).toHaveBeenCalledWith(undefined)
    expect(first.getSnapshot().models.map((item) => item.id)).toEqual(['a'])
    expect(second.getSnapshot().models.map((item) => item.id)).toEqual(['b'])
    first.currentSelectionKey = 'first'
    second.currentSelectionKey = 'second'
    const release = vi.fn().mockResolvedValue(undefined)
    const unregister = first.registerDeletionHandler(release)
    await account.prepareDeletion({ modelId: 'a', revision: 1, storageId: 'storage' })
    expect(release).toHaveBeenCalledWith({ modelId: 'a', revision: 1, storageId: 'storage' })
    const pending = deferred<void>()
    const work = first.run('copy', '복사본 제거', () => pending.promise)
    first.active = false
    expect(account.getSnapshot().tasks[0].state).toBe('running')
    pending.resolve()
    await work
    expect(account.getSnapshot().tasks[0].state).toBe('succeeded')
    expect(second.getSnapshot().tasks).toEqual([])
    expect(first.currentSelectionKey).toBe('first')
    expect(second.currentSelectionKey).toBe('second')
    unregister()
    await disconnectPredictionOwner('account-view-test')
  })
  it('lists metadata without starting a Predictor process', async () => {
    const manager = new PredictionAssetController('owner', 12)
    await manager.refresh()
    expect(mocks.models).toHaveBeenCalledWith(12)
    expect(mocks.operations).toHaveBeenCalledWith(12)
    expect(mocks.remotes).toHaveLength(0)
  })

  it('keeps successful lists and Predictor launchers when model metadata fails validation', async () => {
    const manager = new PredictionAssetController('owner', 12)
    const datasets = [{ id: 'dataset' }]
    const storages = [{ storage_id: 'storage' }]
    const predictor = { id: 'predictor', slave_app_ids: ['predictor'], status: 'offline' }
    mocks.models.mockRejectedValue(new Error('invalid_uuid'))
    mocks.datasets.mockResolvedValue(datasets)
    mocks.storages.mockResolvedValue(storages)
    mocks.operations.mockResolvedValue([operation('completed')])
    mocks.launchers.mockResolvedValue([predictor, { id: 'cae-only', slave_app_ids: ['cae'] }])

    await manager.refresh()

    expect(manager.getSnapshot()).toMatchObject({
      models: [],
      datasets,
      storages,
      operations: [operation('completed')],
      launchers: [predictor],
      launchersLoaded: true,
      listErrors: { models: '모델: invalid_uuid' },
      error: '모델: invalid_uuid',
      loading: false,
    })
  })

  it('preserves only failed lists on refresh and clears their errors after recovery', async () => {
    const manager = new PredictionAssetController('owner', 12)
    const models = [{ id: 'model' }]
    const launcher = { id: 'predictor', slave_app_ids: ['predictor'] }
    mocks.models.mockResolvedValueOnce(models)
    mocks.launchers.mockResolvedValueOnce([launcher])
    await manager.refresh()
    mocks.models.mockRejectedValueOnce(new Error('잘못된 응답'))
    mocks.launchers.mockRejectedValueOnce(new Error('연결 실패'))
    const datasets = [{ id: 'new-dataset' }]
    mocks.datasets.mockResolvedValueOnce(datasets)

    await manager.refresh()

    expect(manager.getSnapshot()).toMatchObject({
      models,
      datasets,
      launchers: [launcher],
      launchersLoaded: true,
      listErrors: { models: '모델: 잘못된 응답', launchers: '장비: 연결 실패' },
      error: '모델: 잘못된 응답\n장비: 연결 실패',
    })
    await manager.refresh()
    expect(manager.getSnapshot()).toMatchObject({ models: [], launchers: [], listErrors: {}, error: null })
  })

  it.each(['success', 'failure'])('ignores an older refresh %s after a newer refresh finishes', async (outcome) => {
    const manager = new PredictionAssetController('owner', 12)
    const first = deferred<unknown[]>()
    mocks.models.mockReturnValueOnce(first.promise)
    mocks.launchers.mockResolvedValueOnce([{ id: 'old', slave_app_ids: ['predictor'] }])
    const older = manager.refresh()
    mocks.models.mockResolvedValueOnce([{ id: 'new-model' }])
    mocks.launchers.mockRejectedValueOnce(new Error('최신 조회 실패'))
    await manager.refresh()
    const latest = manager.getSnapshot()

    if (outcome === 'success') first.resolve([{ id: 'old-model' }])
    else first.reject(new Error('이전 조회 실패'))
    await older

    expect(manager.getSnapshot()).toBe(latest)
    expect(latest).toMatchObject({
      models: [{ id: 'new-model' }],
      launchers: [],
      launchersLoaded: false,
      error: '장비: 최신 조회 실패',
      loading: false,
    })
  })

  it('does not stop the newer refresh loading state when an older refresh settles', async () => {
    const manager = new PredictionAssetController('owner', 12)
    const first = deferred<unknown[]>()
    const second = deferred<unknown[]>()
    mocks.models.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const older = manager.refresh()
    const newer = manager.refresh()
    first.reject(new Error('이전 조회 실패'))
    await older
    expect(manager.getSnapshot()).toMatchObject({ loading: true, error: null, listErrors: {} })
    second.resolve([{ id: 'new-model' }])
    await newer
    expect(manager.getSnapshot()).toMatchObject({ models: [{ id: 'new-model' }], loading: false })
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
    mocks.models.mockRejectedValueOnce(new Error('잘못된 모델 응답'))
    mocks.operations.mockResolvedValue([operation('completed')])
    await manager.refresh()
    expect(manager.getSnapshot().tasks[0]).toMatchObject({ state: 'succeeded', message: '완료' })
  })

  it('preserves operation and task state when only the operation list fails', async () => {
    const manager = new PredictionAssetController('owner', 12)
    mocks.operations.mockResolvedValueOnce([operation('pending')])
    await manager.run('delete:a', '복사본 삭제', async (work) => work.operation(operation('pending')))
    const tasks = manager.getSnapshot().tasks
    mocks.operations.mockRejectedValueOnce(new Error('작업 조회 실패'))
    mocks.models.mockResolvedValueOnce([{ id: 'new-model' }])

    await manager.refresh()

    expect(manager.getSnapshot().tasks).toBe(tasks)
    expect(manager.getSnapshot()).toMatchObject({
      models: [{ id: 'new-model' }],
      operations: [operation('pending')],
      listErrors: { operations: '작업: 작업 조회 실패' },
    })
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
