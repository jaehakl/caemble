import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PredictionModelRecord, PredictionOperation, PredictionStorage } from '@/contracts/api/prediction'
import { predictionOperationSchema } from '@/contracts/api/prediction'
import { PredictionAssetController } from './assetManagement'
import {
  retryPredictionAssetOperation,
  startPredictionAssetOperation,
  verifyPredictionReplica,
} from './assetOperations'
import { RemotePredictionError } from './remoteProtocol'

const mocks = vi.hoisted(() => ({
  models: vi.fn(),
  datasets: vi.fn(),
  storages: vi.fn(),
  operations: vi.fn(),
  launchers: vi.fn(),
  createOperation: vi.fn(),
  operation: vi.fn(),
  retryOperation: vi.fn(),
  interruptOperation: vi.fn(),
  completeOperation: vi.fn(),
  command: vi.fn(),
  inspect: vi.fn(),
}))
vi.mock('@/api/prediction', () => ({ predictionApi: mocks }))
vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    listLaunchers = mocks.launchers
  },
}))
vi.mock('./remoteAssets', () => ({ reconcileRemoteAssets: vi.fn(), registerRemoteArtifact: vi.fn() }))
vi.mock('./remoteExecution', () => ({
  RemotePredictionExecution: class {
    hello: { storageId: string; launcherId: string }
    constructor(readonly launcherId: string) {
      this.hello = { storageId: `${launcherId}-storage`, launcherId }
    }
    inspect = async () => {
      mocks.inspect(this.launcherId)
      return this.hello
    }
    command = (type: string, body: object) => mocks.command(this.launcherId, type, body)
    dispose = vi.fn()
  },
}))
const modelId = '11111111-1111-4111-8111-111111111111'
const operationId = '22222222-2222-4222-8222-222222222222'
const sourceReplicaId = '33333333-3333-4333-8333-333333333333'
const datasetId = '44444444-4444-4444-8444-444444444444'
const checksum = 'c'.repeat(64)
const model: PredictionModelRecord = {
  id: modelId,
  name: '온도 모델',
  experiment_id: 1,
  state: 'active',
  current_revision: 2,
  delete_id: null,
  direction: 'forward',
  algorithm: 'knn',
  revisions: [
    {
      revision: 2,
      operation_id: operationId,
      state: 'ready',
      dataset_id: datasetId,
      dataset_revision: 1,
      dataset_fingerprint: 'sha256:' + checksum,
      definition: { fingerprint: 'model' },
      source_contracts: {},
      artifact: { manifest_sha256: checksum },
      replicas: [
        {
          id: sourceReplicaId,
          storage_id: 'source-storage',
          state: 'unverified',
          manifest_sha256: null,
          artifact: null,
          checked_at: null,
          verified_at: null,
          delete_id: null,
        },
      ],
    },
  ],
}
const storage: PredictionStorage = {
  storage_id: 'source-storage',
  name: '연구실',
  kind: 'predictor_local',
  checked_at: null,
  accesses: [{ launcher_id: 'source', checked_at: null, connected: true }],
}
const grant = {
  operation_id: operationId,
  token: 'operation-token',
  manifest_url: `https://fixture.invalid/prediction/operations/${operationId}/transfer`,
  prepare_url: `https://fixture.invalid/prediction/operations/${operationId}/archives/{slot}/uploads`,
  complete_url: `https://fixture.invalid/prediction/operations/${operationId}/archives/{slot}/complete`,
  register_url: `https://fixture.invalid/prediction/operations/${operationId}/complete`,
  refresh_url: `https://fixture.invalid/prediction/operations/${operationId}/grant/renew`,
  expires_at: 9999999999,
}
function operation(changes: Partial<PredictionOperation> = {}): PredictionOperation {
  return {
    id: operationId,
    request_id: operationId,
    kind: 'backup',
    state: 'pending',
    stage: 'pending',
    asset_kind: 'model',
    asset_id: modelId,
    revision: 2,
    source_replica_id: sourceReplicaId,
    target_storage_id: null,
    target_launcher_id: null,
    include_dataset: false,
    details: { source_launcher_id: 'source' },
    error: null,
    created_at: '2026-10-01T01:00:00Z',
    updated_at: '2026-10-01T01:00:00Z',
    completed_at: null,
    grant,
    ...changes,
  }
}
async function manager() {
  const value = new PredictionAssetController('owner', 1)
  await value.refresh()
  return value
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.models.mockResolvedValue([model])
  mocks.storages.mockResolvedValue([storage])
  mocks.datasets.mockResolvedValue([])
  mocks.operations.mockResolvedValue([])
  mocks.launchers.mockResolvedValue([])
  mocks.createOperation.mockResolvedValue(operation())
  mocks.operation.mockResolvedValue(operation({ state: 'completed' }))
  mocks.retryOperation.mockResolvedValue(operation())
  mocks.command.mockResolvedValue({})
  mocks.interruptOperation.mockResolvedValue({})
  mocks.completeOperation.mockResolvedValue(operation({ kind: 'verify', state: 'completed' }))
})

describe('Prediction management wire orchestration', () => {
  it('validates scoped grant metadata without exposing model bytes', () => {
    expect(predictionOperationSchema.parse(operation()).grant?.token).toBe('operation-token')
    expect(() =>
      predictionOperationSchema.parse({ ...operation(), grant: { ...grant, operation_id: 'wrong' } }),
    ).toThrow()
  })

  it('backs up the exact model and uses immutable revision checksum for an unverified migrated copy', async () => {
    await startPredictionAssetOperation(await manager(), {
      kind: 'backup',
      asset_kind: 'model',
      asset_id: modelId,
      revision: 2,
      source_replica_id: sourceReplicaId,
      source_launcher_id: 'source',
      include_dataset: false,
    })
    expect(mocks.command).toHaveBeenCalledWith(
      'source',
      'artifact.backup',
      expect.objectContaining({
        operationId,
        model: { modelId, revision: 2, manifestChecksum: checksum },
        includeDataset: false,
        slots: ['model'],
        grant,
      }),
    )
    expect(mocks.command).not.toHaveBeenCalledWith(expect.anything(), 'model.prepare', expect.anything())
  })

  it('uses separate source sessions for a model and exact Dataset on different devices', async () => {
    mocks.createOperation.mockResolvedValue(
      operation({
        include_dataset: true,
        details: {
          source_launcher_id: 'source',
          dataset_source: {
            kind: 'predictor_local',
            dataset_id: datasetId,
            revision: 1,
            fingerprint: 'sha256:' + checksum,
            storage_id: 'data-storage',
            launcher_id: 'data',
          },
        },
      }),
    )
    await startPredictionAssetOperation(await manager(), {
      kind: 'backup',
      asset_kind: 'model',
      asset_id: modelId,
      revision: 2,
      source_replica_id: sourceReplicaId,
      source_launcher_id: 'source',
      include_dataset: true,
      dataset_source_launcher_id: 'data',
    })
    expect(mocks.command).toHaveBeenCalledWith(
      'source',
      'artifact.backup',
      expect.objectContaining({ slots: ['model'] }),
    )
    expect(mocks.command).toHaveBeenCalledWith(
      'data',
      'artifact.backup',
      expect.objectContaining({
        slots: ['dataset'],
        datasetSource: {
          local: { datasetId, revision: 1, fingerprint: 'sha256:' + checksum },
        },
      }),
    )
  })

  it('does not publish to an unexpected target storage', async () => {
    const controller = await manager()
    await startPredictionAssetOperation(controller, {
      kind: 'restore',
      asset_kind: 'model',
      asset_id: modelId,
      revision: 2,
      source_replica_id: sourceReplicaId,
      target_launcher_id: 'target',
      target_storage_id: 'different-storage',
    })
    expect(mocks.createOperation).not.toHaveBeenCalled()
    expect(controller.getSnapshot().tasks[0].state).toBe('failed')
    expect(mocks.command).not.toHaveBeenCalled()
  })

  it('reuses a completed registration after response loss without retransferring or retraining', async () => {
    await retryPredictionAssetOperation(
      await manager(),
      operation({ kind: 'restore', state: 'interrupted', target_launcher_id: 'target' }),
    )
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.retryOperation).not.toHaveBeenCalled()
    expect(mocks.createOperation).not.toHaveBeenCalled()
    expect(mocks.command).not.toHaveBeenCalled()
  })

  it('persists missing file verification as a completed operation', async () => {
    mocks.createOperation.mockResolvedValue(
      operation({ kind: 'verify', target_storage_id: 'source-storage', target_launcher_id: 'source' }),
    )
    mocks.command.mockResolvedValue({ state: 'missing' })
    const controller = await manager()
    await verifyPredictionReplica(controller, 'model', modelId, 2, sourceReplicaId)
    expect(mocks.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'verify', replica_id: sourceReplicaId }),
      expect.anything(),
    )
    expect(mocks.command).toHaveBeenCalledWith(
      'source',
      'artifact.verify',
      expect.objectContaining({ manifestChecksum: checksum }),
    )
    expect(mocks.completeOperation).toHaveBeenCalledWith(
      operationId,
      { receipt: { operationId, state: 'missing' } },
      expect.anything(),
    )
    expect(controller.getSnapshot().tasks[0].state).toBe('succeeded')
  })

  it('retries a local failed action by its stable operation before requiring the source again', async () => {
    const controller = await manager()
    mocks.command.mockRejectedValueOnce(new Error('등록 응답 유실'))
    await startPredictionAssetOperation(controller, {
      kind: 'backup',
      asset_kind: 'model',
      asset_id: modelId,
      revision: 2,
      source_replica_id: sourceReplicaId,
      source_launcher_id: 'source',
    })
    const taskId = controller.getSnapshot().tasks[0].id
    mocks.inspect.mockClear()
    mocks.command.mockClear()
    await controller.retryTask(taskId)
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mocks.command).not.toHaveBeenCalled()
    expect(mocks.createOperation).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().tasks[0].state).toBe('succeeded')
  })

  it('leaves a copy deletion waiting while an independent inference session uses it', async () => {
    const pending = operation({ kind: 'delete_replica', details: { replica_id: sourceReplicaId } })
    mocks.createOperation.mockResolvedValue(pending)
    mocks.operation.mockResolvedValue(pending)
    mocks.command.mockRejectedValue(new RemotePredictionError('copy-in-use', 'Use still active'))
    const controller = await manager()
    await startPredictionAssetOperation(controller, {
      kind: 'delete_replica',
      asset_kind: 'model',
      asset_id: modelId,
      revision: 2,
      replica_id: sourceReplicaId,
    })
    expect(controller.getSnapshot().tasks[0].state).toBe('waiting')
    expect(mocks.interruptOperation).not.toHaveBeenCalled()
  })
})
