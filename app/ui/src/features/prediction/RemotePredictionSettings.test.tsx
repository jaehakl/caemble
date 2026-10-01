import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PredictionDatasetRecord, PredictionModelRecord } from '@/contracts/api/prediction'
import type { PredictionContext } from './predictionContextData'
import type { PredictionSetup } from './usePredictionModels'
import { RemotePredictionSettings } from './RemotePredictionSettings'
import { savedContractFromSource } from './savedModels'

const mocks = vi.hoisted(() => ({
  listLaunchers: vi.fn(),
  datasets: vi.fn(),
  models: vi.fn(),
  syncDataset: vi.fn(),
  createDataset: vi.fn(),
  reserve: vi.fn(),
  grant: vi.fn(),
  releaseGrant: vi.fn(),
  deleteAsset: vi.fn(),
  inspect: vi.fn(),
  prepare: vi.fn(),
  release: vi.fn(),
  command: vi.fn(),
  dispose: vi.fn(),
  reconcile: vi.fn(),
  registerArtifact: vi.fn(),
  hello: {} as Record<string, unknown>,
}))

vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    listLaunchers = mocks.listLaunchers
  },
}))
vi.mock('@/api/prediction', () => ({
  predictionApi: {
    datasets: mocks.datasets,
    models: mocks.models,
    syncDataset: mocks.syncDataset,
    createDataset: mocks.createDataset,
    reserve: mocks.reserve,
    grant: mocks.grant,
    releaseGrant: mocks.releaseGrant,
    deleteAsset: mocks.deleteAsset,
  },
}))
vi.mock('./remoteExecution', () => ({
  RemotePredictionExecution: class {
    id = 'remote-knn'
    state = 'connected'
    implementationVersion = 'knn-v1'
    preprocessingVersion = 'box-relative-v2'
    constructor(
      _launcherId: string,
      private options: { onHello?: (hello: unknown) => Promise<void> },
    ) {}
    async inspect(request: unknown) {
      mocks.inspect(request)
      await this.options.onHello?.(mocks.hello)
      return mocks.hello
    }
    prepare = mocks.prepare
    release = mocks.release
    command = mocks.command
    dispose = mocks.dispose
  },
}))
vi.mock('./remoteAssets', async (original) => ({
  ...(await original<typeof import('./remoteAssets')>()),
  reconcileRemoteAssets: mocks.reconcile,
  registerRemoteArtifact: mocks.registerArtifact,
}))

const launcherId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const storageId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const datasetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const forwardId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const inverseId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const operationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
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
const context = {
  experimentId: 1,
  experimentRecords: records,
  calculations,
  measurements: [],
  fingerprint: 'context',
  analysis: { fingerprint: 'analysis', items: [] },
} as unknown as PredictionContext

function dataset(sourceKind: 'server' | 'local' = 'server'): PredictionDatasetRecord {
  return {
    id: datasetId,
    name: 'Fixture Dataset',
    experiment_id: 1,
    state: 'active',
    current_revision: 1,
    storage_id: sourceKind === 'local' ? storageId : null,
    launcher_id: sourceKind === 'local' ? launcherId : null,
    delete_id: null,
    source_kind: sourceKind,
    revisions: [
      {
        revision: 1,
        fingerprint: 'sha256:' + 'c'.repeat(64),
        payload_available: true,
        source_contracts: sourceContracts,
      },
    ],
  }
}

function model(direction: 'forward' | 'inverse'): PredictionModelRecord {
  return {
    id: direction === 'forward' ? forwardId : inverseId,
    name: `${direction} saved`,
    experiment_id: 1,
    state: 'active',
    current_revision: 1,
    storage_id: storageId,
    launcher_id: launcherId,
    delete_id: null,
    direction,
    algorithm: 'knn',
    revisions: [
      {
        revision: 1,
        operation_id: operationId,
        state: 'ready',
        dataset_id: datasetId,
        dataset_revision: 1,
        dataset_fingerprint: 'dataset-fingerprint',
        definition: { fingerprint: `${direction}-fingerprint`, contract: savedContractFromSource(sourceContracts) },
        source_contracts: sourceContracts,
        artifact: { manifest_sha256: 'd'.repeat(64) },
      },
    ],
  }
}

function setup(): PredictionSetup {
  return {
    executionId: 'remote-knn',
    launcherId,
    calculationIds: [4],
    algorithm: { kind: 'knn', kMode: 'auto', manualK: 1, weighting: 'distance', calculationWeights: {} },
    models: {
      inverse: {
        modelId: inverseId,
        modelRevision: 1,
        datasetId,
        datasetRevision: 1,
        direction: 'inverse',
        fingerprint: 'inverse-fingerprint',
        storageId,
        launcherId,
      },
    },
  }
}

function show(initial = setup()) {
  const onChange = vi.fn()
  const onActivity = vi.fn()
  render(
    <RemotePredictionSettings
      authenticated
      open
      context={context}
      sourceHash={'b'.repeat(64)}
      varsSchema={varsSchema}
      rules={[]}
      resultContracts={{}}
      setup={initial}
      onChange={onChange}
      onBeforeDelete={vi.fn()}
      onActivity={onActivity}
    />,
  )
  return { onChange, onActivity }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('crypto', webcrypto)
  mocks.hello = {
    sessionId: 'session',
    storageId,
    launcherId,
    implementationVersion: 'knn-v1',
    preprocessingVersion: 'box-relative-v2',
    capabilities: {},
    datasets: [],
    models: [],
  }
  mocks.listLaunchers.mockResolvedValue([
    { id: launcherId, launcher_name: 'Fixture launcher', status: 'online', slave_app_ids: ['predictor'] },
  ])
  mocks.datasets.mockResolvedValue([dataset()])
  mocks.models.mockResolvedValue([model('inverse')])
  mocks.syncDataset.mockResolvedValue(dataset())
  mocks.reconcile.mockResolvedValue(undefined)
  mocks.reserve.mockResolvedValue({ ...model('forward'), reserved_revision: 1, operation_id: operationId })
  mocks.grant.mockResolvedValue({ grant_id: operationId, token: 'scoped-token', dataset_id: datasetId, revision: 1 })
  mocks.releaseGrant.mockResolvedValue(undefined)
  mocks.prepare.mockResolvedValue({ instance: { handle: 'instance' }, artifact: { modelId: forwardId } })
  mocks.release.mockResolvedValue(undefined)
  mocks.command.mockResolvedValue({ dataset: { datasetId, revision: 1, fingerprint: 'sha256:' + 'c'.repeat(64) } })
  mocks.registerArtifact.mockResolvedValue(model('forward'))
})

describe('remote Prediction asset actions', () => {
  it('synchronizes the server Dataset without preparing or changing either saved model', async () => {
    const { onChange } = show()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dataset 동기화' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Dataset 동기화' }))
    await waitFor(() =>
      expect(mocks.syncDataset).toHaveBeenCalledWith(
        datasetId,
        expect.objectContaining({
          expected_revision: 1,
          record_ids: [10],
          calculation_ids: [4],
          source_hash: 'b'.repeat(64),
        }),
        expect.any(Object),
      ),
    )
    await screen.findByText('Dataset 동기화 완료')
    expect(mocks.reserve).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('creates only the selected direction and releases its instance and scoped grant', async () => {
    const initial = setup()
    const { onChange } = show(initial)
    await waitFor(() => expect(screen.getAllByRole('button', { name: '모델 만들기' })[0]).toBeEnabled())
    fireEvent.click(screen.getAllByRole('button', { name: '모델 만들기' })[0])
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('forward 모델 만들기 완료'))
    expect(onChange).toHaveBeenCalledOnce()
    const changed = onChange.mock.calls[0][0] as PredictionSetup
    expect(changed.models?.forward?.modelId).toBe(forwardId)
    expect(changed.models?.inverse).toEqual(initial.models?.inverse)
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'forward',
        dataset_id: datasetId,
        definition: expect.objectContaining({ calculationIds: [4], requiredRecordIds: [10] }),
      }),
      expect.any(Object),
    )
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'forward',
        dataset: { grant: expect.objectContaining({ token: 'scoped-token' }) },
      }),
      expect.any(Object),
      expect.any(Object),
    )
    expect(mocks.release).toHaveBeenCalledWith({ handle: 'instance' })
    expect(mocks.releaseGrant).toHaveBeenCalledWith(datasetId, operationId)
  })

  it('imports and synchronizes a local Dataset using opaque references', async () => {
    mocks.datasets.mockResolvedValue([dataset('local')])
    const { onChange } = show()
    const input = await screen.findByLabelText('로컬 Dataset import ID')
    fireEvent.change(input, { target: { value: 'heat-fixture' } })
    fireEvent.click(screen.getByRole('button', { name: '로컬 Dataset 가져오기' }))
    await waitFor(() =>
      expect(mocks.command).toHaveBeenCalledWith(
        'dataset.import',
        { importId: 'heat-fixture', experimentId: 1 },
        expect.any(Object),
      ),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dataset 동기화' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Dataset 동기화' }))
    await waitFor(() =>
      expect(mocks.command).toHaveBeenCalledWith('dataset.sync', { datasetId, experimentId: 1 }, expect.any(Object)),
    )
    expect(mocks.syncDataset).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.inspect.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ datasetId }))
  })

  it('shows unavailable artifact diagnostics independently of model selection', async () => {
    mocks.hello.models = [
      {
        modelId: inverseId,
        revision: 1,
        available: false,
        error: 'artifact-checksum: Saved file checksum differs from its manifest.',
      },
    ]
    const { onChange } = show()
    expect(screen.getByText(/파일 · 장비에서 확인 필요/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '연결 / 저장 파일 확인' }))
    expect(await screen.findByText(/사용 불가: artifact-checksum/)).toHaveTextContent('메모리 · 로드되지 않음')
    expect(mocks.reconcile).toHaveBeenCalledWith(mocks.hello)
    expect(onChange).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
