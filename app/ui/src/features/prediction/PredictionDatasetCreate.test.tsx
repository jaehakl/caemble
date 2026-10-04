import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { PredictionDatasetCreate } from './PredictionDatasetCreate'
import { PredictionDatasetDetail } from './PredictionDatasetManager'
import { PredictionAssetController, type PredictionAssetWork } from './assetManagement'
import { datasetFixture, datasetFileState } from './datasetFiles.fixture'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  rename: vi.fn(),
  sync: vi.fn(),
  preview: vi.fn(),
  remove: vi.fn(),
  command: vi.fn(),
}))
vi.mock('./datasetCreation', () => ({ createStandaloneDataset: mocks.create }))
vi.mock('@/api/prediction', () => ({
  predictionApi: { renameAsset: mocks.rename, syncDataset: mocks.sync, previewDataset: mocks.preview },
}))
vi.mock('./assetOperations', () => ({ startPredictionAssetOperation: mocks.remove, verifyPredictionReplica: vi.fn() }))
vi.mock('@/features/experiment/queryOptions', () => ({
  experimentDetailQueryOptions: (_scope: string, id: number) => ({
    queryKey: ['detail', id],
    queryFn: async () => ({ id, source_hash: 'a'.repeat(64), source_bundle: { files: { 'experiment.tsx': 'saved' } } }),
  }),
  experimentRecordsQueryOptions: (_scope: string, id: number) => ({
    queryKey: ['records', id],
    queryFn: async () => ({ items: [{ id: id * 11, name: `Record ${id}` }] }),
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockResolvedValue(datasetFixture)
  mocks.preview.mockResolvedValue({ added: 2, changed: 1, removed: 0 })
  mocks.sync.mockResolvedValue(datasetFixture)
  mocks.command.mockResolvedValue({ dataset: { datasetId: datasetFixture.id } })
})

function managerFixture() {
  const manager = new PredictionAssetController('user:test', 'all')
  vi.spyOn(manager, 'getSnapshot').mockReturnValue(datasetFileState)
  vi.spyOn(manager, 'run').mockImplementation(async (_key, _label, action) =>
    action({
      signal: new AbortController().signal,
      connect: vi.fn().mockResolvedValue({ command: mocks.command, inspect: vi.fn() }),
    } as unknown as PredictionAssetWork),
  )
  return manager
}

function createForm(manager: PredictionAssetController, onCreated = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    onCreated,
    ...render(
      <QueryClientProvider client={client}>
        <PredictionDatasetCreate
          scope="user:test"
          manager={manager}
          experiments={[
            { id: 1, name: '내 실험' },
            { id: 2, name: '다른 실험' },
          ]}
          experimentsError={null}
          onCreated={onCreated}
        />
      </QueryClientProvider>,
    ),
  }
}

it('creates from owned Experiment and selected Records, clearing selection on Experiment change', async () => {
  const manager = managerFixture()
  const { onCreated } = createForm(manager)
  fireEvent.click(screen.getByText('데이터셋 만들기·가져오기'))
  fireEvent.change(screen.getByLabelText('데이터셋 원본 Experiment'), { target: { value: '1' } })
  await screen.findByLabelText('Record 1')
  expect(screen.getByRole('button', { name: '데이터셋 만들기' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('새 데이터셋 이름'), { target: { value: '한글 데이터셋' } })
  fireEvent.click(screen.getByLabelText('Record 1'))
  fireEvent.click(screen.getByRole('button', { name: '데이터셋 만들기' }))
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(datasetFixture.id))
  expect(mocks.create).toHaveBeenCalledWith(
    manager,
    expect.objectContaining({ name: '한글 데이터셋', recordIds: [11], experiment: expect.objectContaining({ id: 1 }) }),
  )
  fireEvent.change(screen.getByLabelText('데이터셋 원본 Experiment'), { target: { value: '2' } })
  await screen.findByLabelText('Record 2')
  expect(screen.getByLabelText('새 데이터셋 이름')).toHaveValue('')
  expect(screen.getByLabelText('Record 2')).not.toBeChecked()
})

it('keeps a late creation from changing a newly selected Experiment', async () => {
  let finish!: (value: typeof datasetFixture) => void
  mocks.create.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const { onCreated } = createForm(managerFixture())
  fireEvent.click(screen.getByText('데이터셋 만들기·가져오기'))
  fireEvent.change(screen.getByLabelText('데이터셋 원본 Experiment'), { target: { value: '1' } })
  await screen.findByLabelText('Record 1')
  fireEvent.change(screen.getByLabelText('새 데이터셋 이름'), { target: { value: '보관' } })
  fireEvent.click(screen.getByLabelText('Record 1'))
  fireEvent.click(screen.getByRole('button', { name: '데이터셋 만들기' }))
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
  fireEvent.change(screen.getByLabelText('데이터셋 원본 Experiment'), { target: { value: '2' } })
  await act(async () => finish(datasetFixture))
  expect(onCreated).not.toHaveBeenCalled()
})

it('shows a failed managed creation beside the form', async () => {
  const manager = managerFixture()
  vi.mocked(manager.getSnapshot).mockReturnValue({
    ...datasetFileState,
    tasks: [
      {
        id: 'failed',
        key: 'dataset:create:1',
        label: '학습 데이터 만들기',
        state: 'failed',
        message: '원본 소스가 변경되었습니다.',
      },
    ],
  })
  createForm(manager)
  fireEvent.click(screen.getByText('데이터셋 만들기·가져오기'))
  fireEvent.change(screen.getByLabelText('데이터셋 원본 Experiment'), { target: { value: '1' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('원본 소스가 변경되었습니다.')
})

it('imports into the explicit Experiment and keeps rename, preview, sync and deletion independent', async () => {
  const manager = managerFixture()
  const { onCreated, unmount } = createForm(manager)
  fireEvent.click(screen.getByText('데이터셋 만들기·가져오기'))
  fireEvent.change(screen.getByLabelText('데이터셋 원본 Experiment'), { target: { value: '1' } })
  fireEvent.click(await screen.findByText('고급: 외부 Dataset 가져오기'))
  fireEvent.change(screen.getByLabelText('외부 Dataset 장비'), { target: { value: 'one' } })
  fireEvent.change(screen.getByLabelText('로컬 Dataset import ID'), { target: { value: 'bundle' } })
  fireEvent.click(screen.getByRole('button', { name: '외부 Dataset 가져오기' }))
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(datasetFixture.id))
  expect(mocks.command).toHaveBeenCalledWith(
    'dataset.import',
    { importId: 'bundle', experimentId: 1 },
    expect.anything(),
  )
  unmount()
  render(<PredictionDatasetDetail manager={manager} dataset={datasetFixture} />)
  fireEvent.change(screen.getByLabelText('데이터셋 이름'), { target: { value: ' 새 이름 ' } })
  fireEvent.click(screen.getByRole('button', { name: '이름 변경' }))
  expect(mocks.rename).toHaveBeenCalledWith('datasets', datasetFixture.id, '새 이름')
  fireEvent.click(screen.getByRole('button', { name: '새 데이터 확인' }))
  await screen.findByText('추가 2개 · 변경 1개 · 삭제 0개')
  fireEvent.click(screen.getByRole('button', { name: '학습 데이터 갱신' }))
  await waitFor(() => expect(mocks.sync).toHaveBeenCalledOnce())
  expect(mocks.sync.mock.calls[0][1]).toMatchObject({ record_ids: [11], expected_revision: 2 })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  fireEvent.click(screen.getByText('학습 데이터 전체 삭제'))
  fireEvent.click(screen.getByRole('button', { name: '학습 데이터 전체 삭제 요청' }))
  expect(mocks.remove).toHaveBeenCalledWith(manager, {
    kind: 'delete_asset',
    asset_kind: 'dataset',
    asset_id: datasetFixture.id,
  })
  confirm.mockRestore()
})
