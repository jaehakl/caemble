import { webcrypto } from 'node:crypto'
import { defaultMlpAlgorithm } from '@caemble/execution/prediction/modelDefinition'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PredictionDatasetRecord, PredictionModelRecord, PredictionOperation } from '@/contracts/api/prediction'
import { defaultPredictionQualityValidation } from '@/contracts/api/prediction'
import { createPredictionModel, predictionDatasetSelection, type PredictionCreationInput } from './assetCreation'
import type { PredictionAssetController, PredictionAssetWork } from './assetManagement'
import type { PredictionContext } from './predictionContextData'
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
  submitTraining: vi.fn(),
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
const sourceContracts = {
  rules: [],
  resultContracts: {},
  experimentId: 1,
  sourceHash: 'b'.repeat(64),
  varsSchema,
  records,
  calculations,
}
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
  setup: { executionId: 'remote-predictor', recordIds: [10], calculationIds: [], algorithm },
  name: '온도 모델',
  launcherId,
  direction: 'forward',
}
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
      definition: {
        fingerprint: 'saved-model',
        contract: savedContractFromSource(sourceContracts),
        algorithm,
        qualityValidation: defaultPredictionQualityValidation,
      },
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

const trainingOperation = (state = 'pending', sourceKind: 'local' | 'api' = 'local') =>
  ({
    id: operationId,
    kind: 'prepare',
    state,
    stage: state,
    asset_id: modelId,
    revision: 1,
    target_storage_id: storageId,
    target_launcher_id: launcherId,
    training: {
      pinId: datasetRequestId,
      sourceKind,
      cleanupPending: false,
      resources: { gpu_count: 0 },
      grant: { operation_id: operationId, token: 'scoped-pin', manifest_url: 'https://example.com/pin' },
    },
  }) as PredictionOperation

function harness() {
  const remote = {
    id: 'remote-predictor',
    hello: {
      storageId,
      launcherId,
      models: [],
      algorithmDescriptors: [
        {
          kind: 'knn',
          implementationVersion: 'knn-v1',
          preprocessingVersion: 'box-relative-v2',
          directions: ['forward'],
        },
      ],
    },
    command: vi.fn().mockResolvedValue({ pinId: datasetRequestId, operationId }),
    dispose: vi.fn(),
  }
  const work = {
    signal: new AbortController().signal,
    connect: vi.fn().mockResolvedValue(remote),
    operation: vi.fn(),
    progress: vi.fn(),
    id: 'task',
  } satisfies PredictionAssetWork
  let retry!: () => Promise<unknown>
  const manager = {
    run: <T>(_key: string, _label: string, action: (value: PredictionAssetWork) => Promise<T>) => {
      retry = () => action(work)
      return action(work)
    },
    getSnapshot: () => ({ storages: [{ storage_id: 'backup-storage', kind: 'object_backup' }] }),
  } as unknown as PredictionAssetController
  return { remote, work, manager, retry: () => retry() }
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
  mocks.operation.mockResolvedValue(trainingOperation())
  mocks.submitTraining.mockResolvedValue(trainingOperation('queued'))
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

describe('independent Prediction training submission', () => {
  it('submits MLP with its frozen recipe through the existing durable training lifecycle', async () => {
    const { manager, remote } = harness()
    remote.hello.algorithmDescriptors.push({
      kind: 'mlp',
      implementationVersion: 'mlp-v1',
      preprocessingVersion: 'box-relative-v2',
      directions: ['forward'],
    })
    await createPredictionModel(manager, {
      ...input,
      setup: { ...input.setup, algorithm: defaultMlpAlgorithm },
      dataset: historical,
      datasetRevision: 3,
    })
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({
          algorithm: defaultMlpAlgorithm,
          implementationVersion: 'mlp-v1',
          requiredRecordIds: [10],
        }),
      }),
      expect.anything(),
    )
    expect(mocks.submitTraining).toHaveBeenCalledTimes(1)
    expect(remote.command).toHaveBeenCalledWith('training.pin', expect.anything(), expect.anything())
  })
  it('always freezes v2 quality splitting in new model definitions', async () => {
    const { manager } = harness()
    await createPredictionModel(manager, { ...input, dataset: historical, datasetRevision: 3 })
    const evaluated = mocks.reserve.mock.calls[0][0].definition
    expect(evaluated.qualityValidation).toEqual(defaultPredictionQualityValidation)
    expect(evaluated.snapshotFingerprint).toBe(historical.revisions[0].fingerprint)
  })

  it.each([undefined, 1])('requires a fresh model when updating quality version %s', (version) => {
    const previous = structuredClone(model)
    previous.revisions[0].definition.qualityValidation = version === undefined ? undefined : { version }
    const { manager } = harness()
    expect(() => createPredictionModel(manager, { ...input, previous })).toThrow('새 v2 모델')
    expect(mocks.reserve).not.toHaveBeenCalled()
  })

  it('preserves model identity and revision for server-derived v2 rebuilds', async () => {
    const { manager } = harness()
    await createPredictionModel(manager, { ...input, dataset: historical, datasetRevision: 3, previous: model })
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        model_id: model.id,
        expected_revision: 1,
        dataset_id: historical.id,
        dataset_revision: 3,
        definition: expect.objectContaining({ qualityValidation: defaultPredictionQualityValidation }),
      }),
      expect.anything(),
    )
    expect(mocks.submitTraining).toHaveBeenCalledOnce()
  })

  it('freezes explicit BoxGrid outputs without requiring Calculation data', () => {
    const selection = predictionDatasetSelection(
      { ...input, context: { ...input.context, calculations: [] } },
      datasetRequestId,
    )
    expect(selection.record_ids).toEqual([10])
    expect(selection.calculation_ids).toEqual([])
  })

  it('restores the exact historical Dataset, pins local input, and returns after server acceptance', async () => {
    const { manager, remote, work } = harness()
    let finishRestore!: () => void
    remote.command.mockReturnValueOnce(
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
    finishRestore()
    const result = await running
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        dataset_id: datasetId,
        dataset_revision: 2,
        definition: expect.objectContaining({ snapshotFingerprint: fingerprint, implementationId: 'remote-predictor' }),
      }),
      expect.anything(),
    )
    expect(remote.command).toHaveBeenLastCalledWith(
      'training.pin',
      { grant: trainingOperation().training!.grant },
      expect.anything(),
    )
    expect(mocks.submitTraining).toHaveBeenCalledWith(operationId, { pin_id: datasetRequestId }, expect.anything())
    expect(work.operation).toHaveBeenLastCalledWith(trainingOperation('queued'))
    expect(result).toEqual({ operationId, modelId, revision: 1, route: { storageId, launcherId } })
    expect(mocks.grant).not.toHaveBeenCalled()
    expect(mocks.syncDataset).not.toHaveBeenCalled()
  })

  it('does not start training when a local pin receipt belongs to another attempt', async () => {
    const { manager, remote } = harness()
    remote.command.mockResolvedValue({ pinId: 'old-pin', operationId })
    await expect(createPredictionModel(manager, { ...input, dataset: historical, datasetRevision: 3 })).rejects.toThrow(
      /현재 작업/,
    )
    expect(mocks.submitTraining).not.toHaveBeenCalled()
  })

  it('checks saved artifacts for API data without granting Dataset payload to the browser', async () => {
    const { manager, remote } = harness()
    mocks.operation.mockResolvedValue(trainingOperation('pending', 'api'))
    await createPredictionModel(manager, { ...input, dataset: historical, datasetRevision: 3 })
    expect(mocks.submitTraining).toHaveBeenCalledWith(operationId, { pin_id: datasetRequestId }, expect.anything())
    expect(remote.command).toHaveBeenCalledWith(
      'training.pin',
      { grant: trainingOperation('pending', 'api').training!.grant },
      expect.anything(),
    )
    expect(mocks.grant).not.toHaveBeenCalled()
  })

  it('recovers a lost submission response from the existing operation without rereading its Dataset', async () => {
    const { manager, remote, retry } = harness()
    mocks.operation.mockResolvedValue(trainingOperation('pending', 'api'))
    mocks.submitTraining.mockRejectedValueOnce(new Error('response lost'))
    await expect(createPredictionModel(manager, { ...input, dataset: historical, datasetRevision: 3 })).rejects.toThrow(
      'response lost',
    )
    mocks.operation.mockResolvedValue(trainingOperation('completed', 'api'))
    remote.command.mockClear()
    const result = await retry()
    expect(result).toEqual({ operationId, modelId, revision: 1, route: { storageId, launcherId } })
    expect(mocks.reserve).toHaveBeenCalledOnce()
    expect(mocks.submitTraining).toHaveBeenCalledOnce()
    expect(mocks.datasets).not.toHaveBeenCalled()
    expect(remote.command).not.toHaveBeenCalled()
  })

  it('stops before reservation when the historical backup cannot be restored', async () => {
    const { manager, remote } = harness()
    remote.command.mockRejectedValue(new Error('archive unavailable'))
    await expect(createPredictionModel(manager, { ...input, dataset: historical, datasetRevision: 2 })).rejects.toThrow(
      'archive unavailable',
    )
    expect(mocks.reserve).not.toHaveBeenCalled()
    expect(mocks.submitTraining).not.toHaveBeenCalled()
  })
})
