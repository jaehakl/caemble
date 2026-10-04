import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/http'
import { predictionDatasetSourceSchema } from '@/contracts/api/prediction'
import { PredictionAssetController, predictionReplicaStatus, type PredictionAssetWork } from './assetManagement'
import { datasetFixture, datasetFileState } from './datasetFiles.fixture'
import {
  datasetRequest,
  datasetTrainingReason,
  importPredictionDataset,
  refreshPredictionDataset,
  savedDatasetSelection,
} from './datasetManagement'
import {
  predictionFileRows,
  predictionFileActionReason,
  predictionRemovalSummary,
  visiblePredictionFiles,
} from './assetFiles'

const mocks = vi.hoisted(() => ({ sync: vi.fn(), preview: vi.fn() }))
vi.mock('@/api/prediction', () => ({ predictionApi: { syncDataset: mocks.sync, previewDataset: mocks.preview } }))
beforeEach(() => vi.clearAllMocks())

describe('dataset inventory and contracts', () => {
  it('shows each storage once, retains provenance-only revisions, and combines filters', () => {
    const rows = predictionFileRows(datasetFileState, 'dataset')
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.bytes)).toEqual([null, 1234, null])
    expect(rows[1].launcherIds).toEqual(['one', 'two'])
    expect(predictionFileActionReason(rows[0], 'verify')).toContain('서버 원본')
    expect(predictionReplicaStatus(rows[0].replica, rows[0].storage)).toBe('서버 원본 보관 중')
    expect(predictionFileActionReason(rows[2], 'remove')).toBe('복사본 없음')
    expect(
      visiblePredictionFiles(
        rows,
        new URLSearchParams(`dataset=${datasetFixture.id}&kind=api_dataset&source=server&q=열전달`),
      ),
    ).toHaveLength(1)
    expect(visiblePredictionFiles(rows, new URLSearchParams('source=local'))).toHaveLength(0)
    expect(visiblePredictionFiles(rows, new URLSearchParams('sort=samples'))[0].revision.revision).toBe(1)
    expect(predictionRemovalSummary(rows, rows.slice(0, 2))).toContain('복사본 0개')
  })
  it('builds refresh selection from saved latest provenance and rejects absent or foreign contracts', () => {
    expect(savedDatasetSelection(datasetFixture, 'request')).toMatchObject({
      request_id: 'request',
      experiment_id: 1,
      record_ids: [11],
      expected_revision: 2,
      calculation_ids: [],
    })
    expect(() => savedDatasetSelection({ ...datasetFixture, experiment_id: 2 }, 'request')).toThrow('출처 계약')
    expect(() => savedDatasetSelection({ ...datasetFixture, revisions: [] }, 'request')).toThrow('출처 계약')
    expect(
      predictionDatasetSourceSchema.safeParse({
        ...datasetFixture.revisions[0].source_contracts,
        records: [{ id: '11' }],
      }).success,
    ).toBe(false)
  })
  it.each(['queued', 'running', 'cleanup'])('blocks removal through %s training', (state) => {
    const snapshot = {
      ...datasetFileState,
      operations: [
        {
          kind: 'prepare',
          state: state === 'cleanup' ? 'completed' : state,
          details: { dataset_id: datasetFixture.id },
          training: { cleanupPending: state === 'cleanup' },
        },
      ] as unknown as typeof datasetFileState.operations,
    }
    expect(datasetTrainingReason(snapshot, datasetFixture.id)).toContain('사용 중')
    expect(predictionFileActionReason(predictionFileRows(snapshot, 'dataset')[0], 'remove', snapshot)).toContain(
      '사용 중',
    )
  })
})

describe('dataset operations', () => {
  function harness() {
    const manager = new PredictionAssetController('user:test', 'all')
    const remote = { hello: { storageId: 'storage' }, command: vi.fn(), inspect: vi.fn().mockResolvedValue(undefined) }
    const work = {
      signal: new AbortController().signal,
      connect: vi.fn().mockResolvedValue(remote),
    } as unknown as PredictionAssetWork
    let action!: (work: PredictionAssetWork) => Promise<unknown>
    vi.spyOn(manager, 'getSnapshot').mockReturnValue(datasetFileState)
    vi.spyOn(manager, 'run').mockImplementation(async (_key, _label, callback) => {
      action = callback
      return callback(work)
    })
    return { manager, work, remote, retry: () => action(work) }
  }
  it('retries server sync with exactly the same selection and request ID', async () => {
    const test = harness()
    mocks.sync.mockResolvedValue(datasetFixture)
    await refreshPredictionDataset(test.manager, datasetFixture, false)
    await test.retry()
    expect(mocks.sync.mock.calls[0]).toEqual(mocks.sync.mock.calls[1])
    expect(test.work.connect).not.toHaveBeenCalled()
  })
  it('previews server changes and gives actionable conflict feedback', async () => {
    const test = harness()
    mocks.preview.mockResolvedValue({ added: 2, changed: 1, removed: 0 })
    expect(await refreshPredictionDataset(test.manager, datasetFixture, true)).toEqual({
      added: 2,
      changed: 1,
      removed: 0,
    })
    await expect(datasetRequest(() => Promise.reject(new ApiError(409, 'Dataset changed', {})))).rejects.toThrow(
      '새로고침',
    )
  })
  it('uses the selected Dataset Experiment for local sync and checks storage identity', async () => {
    const test = harness()
    await refreshPredictionDataset(test.manager, { ...datasetFixture, source_kind: 'local' }, false)
    expect(test.remote.command).toHaveBeenCalledWith(
      'dataset.sync',
      { datasetId: datasetFixture.id, experimentId: 1 },
      expect.anything(),
    )
    await test.retry()
    expect(test.remote.command.mock.calls[0][2].requestId).toBe(test.remote.command.mock.calls[1][2].requestId)
    test.remote.hello.storageId = 'wrong'
    await expect(
      refreshPredictionDataset(test.manager, { ...datasetFixture, source_kind: 'local' }, false),
    ).rejects.toThrow('저장소')
  })
  it('pins the import Experiment and request ID across retries', async () => {
    const test = harness()
    test.remote.command.mockResolvedValue({ dataset: { datasetId: datasetFixture.id } })
    expect(await importPredictionDataset(test.manager, 1, 'one', 'bundle')).toBe(datasetFixture.id)
    await test.retry()
    expect(test.remote.command.mock.calls[0]).toEqual(test.remote.command.mock.calls[1])
    expect(test.remote.command.mock.calls[0][1]).toEqual({ importId: 'bundle', experimentId: 1 })
  })
})
