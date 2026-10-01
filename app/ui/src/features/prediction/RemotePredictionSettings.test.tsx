import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { webcrypto } from 'node:crypto'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PredictionDatasetRecord,
  PredictionModelRecord,
  PredictionReplica,
  PredictionStorage,
} from '@/contracts/api/prediction'
import type { PredictionContext } from './predictionContextData'
import type { PredictionSetup } from './usePredictionModels'
import { RemotePredictionSettings } from './RemotePredictionSettings'
import { PredictionAssetController } from './assetManagement'
import { savedContractFromSource } from './savedModels'

const mocks = vi.hoisted(() => ({
  listLaunchers: vi.fn(),
  datasets: vi.fn(),
  models: vi.fn(),
  storages: vi.fn(),
  operations: vi.fn(),
  syncDataset: vi.fn(),
  previewDataset: vi.fn(),
  createDataset: vi.fn(),
  reserve: vi.fn(),
  operation: vi.fn(),
  grant: vi.fn(),
  releaseGrant: vi.fn(),
  interruptOperation: vi.fn(),
  inspect: vi.fn(),
  prepare: vi.fn(),
  release: vi.fn(),
  command: vi.fn(),
  dispose: vi.fn(),
  reconcile: vi.fn(),
  registerArtifact: vi.fn(),
  startOperation: vi.fn(),
  hello: {} as Record<string, unknown>,
}))

vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    listLaunchers = mocks.listLaunchers
  },
}))
vi.mock('@/api/prediction', () => ({ predictionApi: mocks }))
vi.mock('./remoteExecution', () => ({
  RemotePredictionExecution: class {
    id = 'remote-knn'
    state = 'connected'
    implementationVersion = 'knn-v1'
    preprocessingVersion = 'box-relative-v2'
    get hello() {
      return mocks.hello
    }
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
vi.mock('./assetOperations', () => ({
  startPredictionAssetOperation: mocks.startOperation,
  verifyPredictionReplica: vi.fn(),
  retryPredictionAssetOperation: vi.fn(),
}))

const launcherId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const storageId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const datasetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const forwardId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const inverseId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const operationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const backupStorageId = '11111111-1111-4111-8111-111111111111'
const localReplicaId = '22222222-2222-4222-8222-222222222222'
const backupReplicaId = '33333333-3333-4333-8333-333333333333'
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

function replica(backup = false): PredictionReplica {
  return {
    id: backup ? backupReplicaId : localReplicaId,
    storage_id: backup ? backupStorageId : storageId,
    state: 'present',
    manifest_sha256: 'd'.repeat(64),
    artifact: null,
    checked_at: null,
    verified_at: null,
    delete_id: null,
  }
}

function dataset(sourceKind: 'server' | 'local' = 'server'): PredictionDatasetRecord {
  return {
    id: datasetId,
    name: 'Fixture Dataset',
    experiment_id: 1,
    state: 'active',
    current_revision: 1,
    delete_id: null,
    source_kind: sourceKind,
    revisions: [
      {
        revision: 1,
        fingerprint: 'sha256:' + 'c'.repeat(64),
        payload_available: true,
        source_contracts: sourceContracts,
        replicas: sourceKind === 'local' ? [replica()] : [],
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
        definition: {
          fingerprint: `${direction}-fingerprint`,
          contract: savedContractFromSource(sourceContracts),
          algorithm: { kind: 'knn', kMode: 'manual', manualK: 7 },
        },
        source_contracts: sourceContracts,
        artifact: { manifest_sha256: 'd'.repeat(64) },
        replicas: [replica(), replica(true)],
      },
    ],
  }
}

function setup(): PredictionSetup {
  return {
    executionId: 'remote-knn',
    datasetId,
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
      },
    },
    routes: { inverse: { replicaId: localReplicaId, storageId, launcherId } },
  }
}

async function show(initial = setup()) {
  const manager = new PredictionAssetController('owner:1', 1)
  await manager.refresh()
  const props = {
    authenticated: true,
    open: true,
    context,
    sourceHash: 'b'.repeat(64),
    varsSchema,
    rules: [],
    resultContracts: {},
    setup: initial,
    onChange: vi.fn(),
    onUse: vi.fn(),
    manager,
  }
  return { ...props, ...render(<RemotePredictionSettings {...props} />), props }
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
  mocks.storages.mockResolvedValue([
    {
      storage_id: storageId,
      name: 'Local store',
      kind: 'predictor_local',
      checked_at: null,
      accesses: [{ launcher_id: launcherId, connected: true, checked_at: null }],
    },
    { storage_id: backupStorageId, name: 'Backup store', kind: 'object_backup', checked_at: null, accesses: [] },
  ] satisfies PredictionStorage[])
  mocks.operations.mockResolvedValue([])
  mocks.operation.mockResolvedValue({ id: operationId, state: 'completed' })
  mocks.syncDataset.mockResolvedValue(dataset())
  mocks.previewDataset.mockResolvedValue({ added: 2, changed: 1, removed: 0 })
  mocks.reconcile.mockResolvedValue(undefined)
  mocks.reserve.mockResolvedValue({
    ...model('forward'),
    revisions: model('forward').revisions.map((item) => ({ ...item, state: 'reserved' })),
    reserved_revision: 1,
    operation_id: operationId,
  })
  mocks.grant.mockResolvedValue({ grant_id: operationId, token: 'scoped-token', dataset_id: datasetId, revision: 1 })
  mocks.releaseGrant.mockResolvedValue(undefined)
  mocks.interruptOperation.mockResolvedValue(undefined)
  mocks.prepare.mockResolvedValue({ instance: { handle: 'instance' }, artifact: { modelId: forwardId } })
  mocks.release.mockResolvedValue(undefined)
  mocks.command.mockResolvedValue({ dataset: { datasetId, revision: 1, fingerprint: 'sha256:' + 'c'.repeat(64) } })
  mocks.registerArtifact.mockResolvedValue(model('forward'))
})

describe('model-first Prediction management', () => {
  it('supports keyboard traversal across management tabs and a full long Korean model name', async () => {
    const longName = '한글모델이름과버전별예측결과'.repeat(30)
    mocks.models.mockResolvedValue([{ ...model('inverse'), name: longName }])
    const user = userEvent.setup()
    await show()
    await user.tab()
    expect(screen.getByLabelText('Prediction 실행 위치')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('tab', { name: '모델' })).toHaveFocus()
    await user.tab()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('tabpanel', { name: '학습 데이터 관리' })).toBeInTheDocument()
    await user.tab({ shift: true })
    await user.keyboard(' ')
    const item = screen.getByRole('button', { name: new RegExp(longName) })
    item.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByLabelText('모델 이름')).toHaveValue(longName)
    expect(item).toHaveAccessibleName(expect.stringContaining(longName))
  })

  it('explains empty model, Dataset and operation lists without changing selection', async () => {
    mocks.models.mockResolvedValue([])
    mocks.datasets.mockResolvedValue([])
    const { onUse, onChange } = await show()
    expect(screen.getByText(/아직 저장 모델이 없습니다/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '새 모델 만들기' })).toBeEnabled()
    fireEvent.click(screen.getByRole('tab', { name: '학습 데이터' }))
    expect(screen.getByText(/등록된 학습 데이터가 없습니다/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '작업' }))
    expect(screen.getByText('관리 작업이 없습니다.')).toBeInTheDocument()
    expect(onUse).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('shows one logical model with multiple locations, immutable settings and model-only backup by default', async () => {
    const { manager, onUse, onChange } = await show()
    const list = screen.getByLabelText('등록된 모델')
    expect(within(list).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(within(list).getByRole('button', { name: /inverse saved/ }))
    expect(screen.getAllByText('Local store').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Backup store').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('저장된 설정·ID·checksum'))
    expect(screen.getByText(/"manualK": 7/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '학습 데이터 r1 원본도 포함' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '백업하기' }))
    expect(mocks.startOperation).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ kind: 'backup', include_dataset: false, source_replica_id: localReplicaId }),
    )
    fireEvent.click(screen.getByRole('button', { name: '이 모델 사용' }))
    expect(onUse).toHaveBeenCalledWith(
      expect.objectContaining({
        models: expect.objectContaining({ inverse: expect.objectContaining({ modelId: inverseId }) }),
      }),
      'inverse',
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('previews and synchronizes data without preparing or changing saved model selection', async () => {
    const { onChange, onUse } = await show()
    fireEvent.click(screen.getByRole('tab', { name: '학습 데이터' }))
    fireEvent.click(screen.getByRole('button', { name: '새 데이터 확인' }))
    expect(await screen.findByText('추가 2개 · 변경 1개 · 삭제 0개')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '학습 데이터 갱신' }))
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
    expect(mocks.reserve).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(onUse).not.toHaveBeenCalled()
  })

  it('creates and uses only the requested direction after registration and releases preparation resources', async () => {
    const initial = setup()
    const { onUse, onChange } = await show(initial)
    fireEvent.click(screen.getByRole('button', { name: '새 모델 만들기' }))
    fireEvent.change(screen.getByLabelText('모델 생성 장비'), { target: { value: launcherId } })
    fireEvent.click(screen.getByRole('button', { name: '모델 만들고 사용' }))
    await waitFor(() => expect(onUse).toHaveBeenCalledOnce())
    const [changed, direction] = onUse.mock.calls[0] as [PredictionSetup, string]
    expect(direction).toBe('forward')
    expect(changed.models?.forward?.modelId).toBe(forwardId)
    expect(changed.models?.inverse).toEqual(initial.models?.inverse)
    expect(changed.routes?.inverse).toEqual(initial.routes?.inverse)
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
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps selection when creation fails and exposes its retryable task after reopening', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('장비 저장 공간 부족'))
    const { onUse, onChange, props, rerender, manager } = await show()
    fireEvent.click(screen.getByRole('button', { name: '새 모델 만들기' }))
    fireEvent.change(screen.getByLabelText('모델 생성 장비'), { target: { value: launcherId } })
    fireEvent.click(screen.getByRole('button', { name: '모델 만들고 사용' }))
    await waitFor(() => expect(manager.getSnapshot().tasks[0]?.state).toBe('failed'))
    rerender(<RemotePredictionSettings {...props} open={false} />)
    rerender(<RemotePredictionSettings {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '작업' }))
    expect(screen.getByText('장비 저장 공간 부족')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeEnabled()
    expect(onUse).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(mocks.releaseGrant).toHaveBeenCalledWith(datasetId, operationId)
  })

  it('continues an in-flight management task while its panel is closed', async () => {
    let finish!: (value: PredictionDatasetRecord) => void
    mocks.syncDataset.mockReturnValueOnce(
      new Promise<PredictionDatasetRecord>((resolve) => {
        finish = resolve
      }),
    )
    const { props, rerender, manager } = await show()
    fireEvent.click(screen.getByRole('tab', { name: '학습 데이터' }))
    fireEvent.click(screen.getByRole('button', { name: '학습 데이터 갱신' }))
    await waitFor(() => expect(mocks.syncDataset).toHaveBeenCalledOnce())
    const signal = mocks.syncDataset.mock.calls[0][2].signal as AbortSignal
    rerender(<RemotePredictionSettings {...props} open={false} />)
    expect(signal.aborted).toBe(false)
    expect(manager.getSnapshot().tasks[0].state).toBe('running')
    await act(async () => {
      finish(dataset())
    })
    rerender(<RemotePredictionSettings {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '작업' }))
    expect(screen.getByText('학습 데이터 갱신')).toBeInTheDocument()
    expect(manager.getSnapshot().tasks[0].state).toBe('succeeded')
  })

  it('imports and synchronizes a local Dataset through opaque IDs without switching models', async () => {
    mocks.datasets.mockResolvedValue([dataset('local')])
    const { onUse, onChange } = await show()
    fireEvent.click(screen.getByRole('tab', { name: '학습 데이터' }))
    fireEvent.click(screen.getByText('고급: 외부 Dataset 가져오기'))
    fireEvent.change(screen.getByLabelText('외부 Dataset 장비'), { target: { value: launcherId } })
    fireEvent.change(screen.getByLabelText('로컬 Dataset import ID'), { target: { value: 'heat-fixture' } })
    fireEvent.click(screen.getByRole('button', { name: '외부 Dataset 가져오기' }))
    await waitFor(() =>
      expect(mocks.command).toHaveBeenCalledWith(
        'dataset.import',
        { importId: 'heat-fixture', experimentId: 1 },
        expect.any(Object),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: '학습 데이터 갱신' }))
    await waitFor(() =>
      expect(mocks.command).toHaveBeenCalledWith('dataset.sync', { datasetId, experimentId: 1 }, expect.any(Object)),
    )
    expect(mocks.syncDataset).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(onUse).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('rejects a late creation selection after a newer workspace selection', async () => {
    let finish!: (value: unknown) => void
    mocks.prepare.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const { manager, onUse } = await show()
    fireEvent.click(screen.getByRole('button', { name: '새 모델 만들기' }))
    fireEvent.change(screen.getByLabelText('모델 생성 장비'), { target: { value: launcherId } })
    fireEvent.click(screen.getByRole('button', { name: '모델 만들고 사용' }))
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce())
    manager.currentSelectionKey = 'newer-selection'
    await act(async () => {
      finish({ instance: { handle: 'instance' }, artifact: { modelId: forwardId } })
    })
    await waitFor(() => expect(manager.getSnapshot().tasks[0].state).toBe('succeeded'))
    expect(mocks.registerArtifact).toHaveBeenCalledOnce()
    expect(onUse).not.toHaveBeenCalled()
  })
})
