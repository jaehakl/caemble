import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/http'
import type { PredictionDatasetRecord, PredictionModelRecord } from '@/contracts/api/prediction'
import { createPredictionModel, predictionDatasetSelection, type PredictionCreationInput } from './assetCreation'
import type { PredictionAssetController, PredictionAssetWork } from './assetManagement'
import type { PredictionContext } from './predictionContextData'
import { remoteArtifactSchema } from './remoteProtocol'
import { savedContractFromSource } from './savedModels'

const mocks = vi.hoisted(() => ({
  datasets: vi.fn(),
  createDataset: vi.fn(),
  syncDataset: vi.fn(),
  reserve: vi.fn(),
  grant: vi.fn(),
  releaseGrant: vi.fn(),
  createOperation: vi.fn(),
  operation: vi.fn(),
  complete: vi.fn(),
}))
vi.mock('@/api/prediction', () => ({ predictionApi: mocks }))

const launcherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const storageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const datasetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const modelId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const operationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const datasetRequestId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const restoreRequestId = '11111111-1111-4111-8111-111111111111'
const backupId = '22222222-2222-4222-8222-222222222222'
const checksum = 'd'.repeat(64)
const fingerprint = 'sha256:' + 'c'.repeat(64)
const varsSchema = { x: { shape: [], min: 0, max: 2 } }
const records = [{ id: 10, name: 'temperature', contract_hash: 'record-contract' }]
const calculations = [
  {
    id: 4,
    name: 'Maximum',
    source_hash: 'a'.repeat(64),
    experiment_record_ids: [10],
    output_layout: { dtype: 'float64', shape: [], axes: [] },
    contract_status: 'ready',
  },
]
const sourceContracts = { experimentId: 1, sourceHash: 'b'.repeat(64), varsSchema, records, calculations }
const algorithm = { kind: 'knn', kMode: 'auto', manualK: 1, weighting: 'distance' } as const
const input: PredictionCreationInput = {
  context: {
    experimentId: 1,
    experimentRecords: records,
    calculations,
  } as unknown as PredictionContext,
  sourceHash: sourceContracts.sourceHash,
  varsSchema,
  rules: [],
  resultContracts: {},
  setup: { executionId: 'remote-knn', recordIds: [10], calculationIds: [], algorithm },
  name: '온도 모델',
  launcherId,
  direction: 'forward',
}
const artifact = remoteArtifactSchema.parse({
  modelId,
  revision: 1,
  operationId,
  name: input.name,
  direction: 'forward',
  algorithm: 'knn',
  definition: { fingerprint: 'saved-model' },
  datasetId,
  datasetRevision: 2,
  datasetFingerprint: fingerprint,
  storageId,
  launcherId,
  manifestChecksum: checksum,
  formatVersion: 1,
  verified: false,
  files: [{ name: 'model.json', sha256: checksum, byteLength: 123 }],
  inputLayouts: [],
  outputLayouts: [],
  profile: {
    direction: 'forward',
    rowCount: 3,
    inputLayouts: [],
    inputSize: 1,
    outputSize: 1,
    includedMeasurementIds: [1, 2, 3],
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
  },
})
const model: PredictionModelRecord = {
  id: modelId,
  name: input.name,
  experiment_id: 1,
  state: 'active',
  current_revision: 1,
  delete_id: null,
  direction: 'forward',
  algorithm: 'knn',
  revisions: [
    {
      revision: 1,
      operation_id: operationId,
      state: 'ready',
      dataset_id: datasetId,
      dataset_revision: 2,
      dataset_fingerprint: fingerprint,
      definition: { fingerprint: 'saved-model', contract: savedContractFromSource(sourceContracts), algorithm },
      source_contracts: sourceContracts,
      artifact: { manifest_sha256: checksum },
      replicas: [
        {
          id: 'local-replica',
          storage_id: storageId,
          state: 'unverified',
          manifest_sha256: checksum,
          artifact: null,
          checked_at: null,
          verified_at: null,
          delete_id: null,
        },
      ],
    },
  ],
}
const historical: PredictionDatasetRecord = {
  id: datasetId,
  name: '학습 데이터',
  experiment_id: 1,
  state: 'active',
  source_kind: 'server',
  current_revision: 3,
  delete_id: null,
  revisions: [
    {
      revision: 3,
      fingerprint: 'sha256:' + 'e'.repeat(64),
      payload_available: true,
      api_payload_available: true,
      source_contracts: sourceContracts,
      replicas: [],
    },
    {
      revision: 2,
      fingerprint,
      payload_available: true,
      api_payload_available: false,
      source_contracts: sourceContracts,
      replicas: [
        {
          id: backupId,
          storage_id: 'backup-storage',
          state: 'present',
          manifest_sha256: checksum,
          artifact: null,
          checked_at: null,
          verified_at: null,
          delete_id: null,
        },
      ],
    },
  ],
}

function harness(recovered = false) {
  const remote = {
    id: 'remote-knn',
    implementationVersion: 'knn-v1',
    preprocessingVersion: 'box-relative-v2',
    hello: { storageId, launcherId, models: recovered ? [artifact] : [] },
    command: vi.fn().mockResolvedValue({ receipt: { state: 'complete' } }),
    prepare: vi.fn().mockResolvedValue({ instance: { handle: 'instance' }, artifact: { ...artifact, verified: true } }),
    release: vi.fn().mockResolvedValue(undefined),
  }
  const work = {
    signal: new AbortController().signal,
    connect: vi.fn().mockResolvedValue(remote),
    operation: vi.fn(),
    progress: vi.fn(),
    id: 'task',
  } satisfies PredictionAssetWork
  const manager = {
    run: <T>(_key: string, _label: string, action: (value: PredictionAssetWork) => Promise<T>) => action(work),
    getSnapshot: () => ({ storages: [{ storage_id: 'backup-storage', kind: 'object_backup' }] }),
  } as unknown as PredictionAssetController
  return { remote, work, manager }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('crypto', {
    subtle: webcrypto.subtle,
    randomUUID: vi
      .fn()
      .mockReturnValueOnce(datasetRequestId)
      .mockReturnValueOnce(operationId)
      .mockReturnValueOnce(restoreRequestId)
      .mockImplementation(() => webcrypto.randomUUID()),
  })
  mocks.complete.mockResolvedValue(model)
  mocks.operation.mockResolvedValue({ id: operationId, state: 'completed' })
  mocks.reserve.mockResolvedValue({
    ...model,
    revisions: model.revisions.map((revision) => ({ ...revision, state: 'reserved' })),
    reserved_revision: 1,
    operation_id: operationId,
  })
  mocks.createOperation.mockResolvedValue({
    id: restoreRequestId,
    state: 'pending',
    grant: { token: 'scoped-restore' },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('Prediction model creation recovery', () => {
  it('freezes explicit BoxGrid outputs without requiring Calculation data', () => {
    const selection = predictionDatasetSelection(
      { ...input, context: { ...input.context, calculations: [] } },
      datasetRequestId,
    )
    expect(selection.record_ids).toEqual([10])
    expect(selection.calculation_ids).toEqual([])
  })
  it('reuses the matching hello receipt without fetching training data or preparing again', async () => {
    const { manager, remote, work } = harness(true)
    const result = await createPredictionModel(manager, input)
    expect(work.connect).toHaveBeenCalledWith(launcherId, true)
    expect(mocks.complete).toHaveBeenCalledWith(
      modelId,
      1,
      expect.objectContaining({
        request_id: operationId,
        manifest_sha256: checksum,
        verified: false,
      }),
      { signal: undefined },
    )
    expect(result?.models?.forward).toMatchObject({ modelId, modelRevision: 1, datasetId, datasetRevision: 2 })
    expect(result?.routes?.forward).toEqual({ replicaId: 'local-replica', storageId, launcherId })
    for (const request of [mocks.datasets, mocks.createDataset, mocks.syncDataset, mocks.grant, mocks.reserve])
      expect(request).not.toHaveBeenCalled()
    expect(remote.prepare).not.toHaveBeenCalled()
    expect(remote.command).not.toHaveBeenCalled()
  })

  it.each([409, 410])(
    'does not fall back to training when published receipt registration is refused (%s)',
    async (status) => {
      const { manager, remote } = harness(true)
      const rejected = new ApiError(status, 'Preparation was cancelled or superseded.', {})
      mocks.complete.mockRejectedValue(rejected)
      await expect(createPredictionModel(manager, input)).rejects.toBe(rejected)
      expect(mocks.reserve).not.toHaveBeenCalled()
      expect(mocks.grant).not.toHaveBeenCalled()
      expect(mocks.createDataset).not.toHaveBeenCalled()
      expect(remote.prepare).not.toHaveBeenCalled()
    },
  )

  it('restores the exact historical Dataset before reserving a model and keeps its old revision', async () => {
    const { manager, remote } = harness()
    let finishRestore!: () => void
    remote.command.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRestore = resolve
      }),
    )
    const running = createPredictionModel(manager, { ...input, dataset: historical, datasetRevision: 2 })
    await vi.waitFor(() =>
      expect(remote.command).toHaveBeenCalledWith(
        'artifact.restore',
        { operationId: restoreRequestId, grant: { token: 'scoped-restore' } },
        expect.anything(),
      ),
    )
    expect(mocks.reserve).not.toHaveBeenCalled()
    expect(mocks.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'restore',
        asset_kind: 'dataset',
        asset_id: datasetId,
        revision: 2,
        source_replica_id: backupId,
        target_storage_id: storageId,
        target_launcher_id: launcherId,
      }),
      expect.anything(),
    )
    finishRestore()
    const result = await running
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        dataset_id: datasetId,
        dataset_revision: 2,
        definition: expect.objectContaining({ snapshotFingerprint: fingerprint }),
      }),
      expect.anything(),
    )
    expect(remote.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        dataset: { datasetId, revision: 2, fingerprint },
        model: { modelId, revision: 1, operationId, name: input.name },
      }),
      expect.anything(),
      expect.anything(),
    )
    expect(mocks.grant).not.toHaveBeenCalled()
    expect(mocks.syncDataset).not.toHaveBeenCalled()
    expect(result?.models?.forward?.datasetRevision).toBe(2)
    expect(remote.release).toHaveBeenCalledWith({ handle: 'instance' })
  })

  it('stops before reservation when the historical backup cannot be restored', async () => {
    const { manager, remote } = harness()
    const missing = new Error('The exact Dataset archive is unavailable.')
    remote.command.mockRejectedValue(missing)
    await expect(createPredictionModel(manager, { ...input, dataset: historical, datasetRevision: 2 })).rejects.toBe(
      missing,
    )
    expect(mocks.reserve).not.toHaveBeenCalled()
    expect(remote.prepare).not.toHaveBeenCalled()
    expect(mocks.grant).not.toHaveBeenCalled()
  })
})
