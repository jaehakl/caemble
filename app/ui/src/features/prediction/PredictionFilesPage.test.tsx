import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PredictionFilesWorkspace } from './PredictionFilesPage'
import { fileState } from './modelFiles.fixture'
import { datasetFileState, datasetFixture } from './datasetFiles.fixture'

const mocks = vi.hoisted(() => ({
  snapshot: {} as typeof fileState,
  refresh: vi.fn(),
  verify: vi.fn(),
  remove: vi.fn(),
  retry: vi.fn(),
}))
vi.mock('./usePredictionAssets', () => ({
  usePredictionAssets: () => ({
    subscribe: () => () => undefined,
    getSnapshot: () => mocks.snapshot,
    refresh: mocks.refresh,
    retryTask: mocks.retry,
  }),
}))
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({
    data: {
      mine: [
        { id: 1, name: '첫 Experiment' },
        { id: 2, name: '다른 Experiment' },
      ],
      demos: [],
    },
  }),
}))
vi.mock('./assetOperations', () => ({
  startPredictionAssetOperation: mocks.remove,
  verifyPredictionReplica: mocks.verify,
}))
vi.mock('./PredictionModelManager', () => ({ ModelDetail: () => <p>선택 모델 관리 동작</p> }))
vi.mock('./PredictionAssetTasks', () => ({ PredictionAssetTasks: () => <p>작업 재시도 목록</p> }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.snapshot = structuredClone(fileState)
  mocks.verify.mockResolvedValue({ state: 'completed' })
  mocks.remove.mockResolvedValue({ state: 'completed' })
  mocks.refresh.mockResolvedValue(undefined)
})

describe('account model files page', () => {
  it('opens the Dataset tab from URL, preserves provenance-only rows, and resets filters without leaving the tab', async () => {
    mocks.snapshot = structuredClone(datasetFileState)
    render(
      <MemoryRouter initialEntries={['/settings/prediction?tab=datasets&state=none']}>
        <PredictionFilesWorkspace scope="user:test" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('tab', { name: '데이터셋' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('cell', { name: '출처 기록만 보존' })).toBeInTheDocument()
    const row = screen.getByRole('cell', { name: datasetFixture.name }).closest('tr')!
    row.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('region', { name: '선택한 데이터셋 파일 상세' })).toBeInTheDocument()
    expect(screen.getByText('Record: 온도 (#11)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '선택 복사본 제거' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '조건 초기화' }))
    expect(screen.getByRole('tab', { name: '데이터셋' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('row')).toHaveLength(4)
    fireEvent.click(screen.getByRole('tab', { name: '모델' }))
    expect(screen.getByLabelText('모델명 검색')).toBeInTheDocument()
  })

  it('verifies only local Dataset copies and removes Dataset copies with dataset operation identity', async () => {
    mocks.snapshot = structuredClone(datasetFileState)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <MemoryRouter initialEntries={['/settings/prediction?tab=datasets']}>
        <PredictionFilesWorkspace scope="user:test" />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '현재 페이지 복사본 모두 선택' }))
    fireEvent.click(screen.getByRole('button', { name: '선택 파일 확인' }))
    await waitFor(() => expect(mocks.verify).toHaveBeenCalledOnce())
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.anything(),
      'dataset',
      datasetFixture.id,
      2,
      datasetFixture.revisions[0].replicas[1].id,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '선택 복사본 제거' })).toBeEnabled())
    mocks.remove.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ state: 'completed' })
    fireEvent.click(screen.getByRole('button', { name: '선택 복사본 제거' }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2))
    expect(mocks.remove.mock.calls[0][1]).toMatchObject({
      asset_kind: 'dataset',
      asset_id: datasetFixture.id,
      revision: 2,
    })
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('복사본 0개'))
    expect(screen.getByLabelText('일괄 작업 결과')).toHaveTextContent('실패')
    expect(screen.getByLabelText('일괄 작업 결과')).toHaveTextContent('완료')
    confirm.mockRestore()
  })
  it('restores URL filters and opens a copyless revision using keyboard without enabling file removal', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/prediction?state=none&revision=2']}>
        <PredictionFilesWorkspace scope="user:test" />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('파일 상태 필터')).toHaveValue('none')
    expect(screen.getByLabelText('Revision 필터')).toHaveValue('2')
    expect(screen.getByRole('checkbox', { name: /복사본 없음 선택/ })).toBeDisabled()
    const row = screen.getByRole('cell', { name: '긴 한글 온도 예측 모델' }).closest('tr')!
    row.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('region', { name: '선택한 모델 파일 상세' })).toBeInTheDocument()
    expect(screen.getByText('선택 모델 관리 동작')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '선택 복사본 제거' })).toBeDisabled()
  })

  it('continues a sequential bulk removal after a failure and warns using the complete selection', async () => {
    const first = mocks.snapshot.models[0]
    mocks.snapshot = {
      ...mocks.snapshot,
      models: [
        first,
        {
          ...first,
          id: 'second-model',
          name: '두번째 모델',
          experiment_id: 2,
          revisions: [{ ...first.revisions[1], replicas: [{ ...first.revisions[1].replicas[0], id: 'second-copy' }] }],
        },
      ],
    }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.remove
      .mockImplementationOnce(async (_manager, request) => {
        mocks.snapshot = {
          ...mocks.snapshot,
          tasks: [
            {
              id: 'failed-copy-task',
              key: `delete_replica:${request.asset_id}:${request.revision}:${request.replica_id}`,
              label: '파일 삭제',
              state: 'failed',
              message: '응답 유실',
            },
          ],
        }
        return undefined
      })
      .mockResolvedValueOnce({ state: 'completed' })
    render(
      <MemoryRouter>
        <PredictionFilesWorkspace scope="user:test" />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '현재 페이지 복사본 모두 선택' }))
    fireEvent.click(screen.getByRole('button', { name: '선택 복사본 제거' }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('복사본 0개'))
    expect(screen.getByLabelText('일괄 작업 결과')).toHaveTextContent('실패')
    expect(screen.getByLabelText('일괄 작업 결과')).toHaveTextContent('완료')
    fireEvent.click(screen.getByRole('button', { name: '이 항목 상태 확인·재시도' }))
    expect(mocks.retry).toHaveBeenCalledWith('failed-copy-task')
    expect(mocks.remove).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ asset_id: 'second-model' }),
    )
    confirm.mockRestore()
  })

  it('paginates 50 rows and keeps an empty filter result separate from an empty account', () => {
    const base = mocks.snapshot.models[0]
    mocks.snapshot = {
      ...mocks.snapshot,
      models: Array.from({ length: 51 }, (_, index) => ({
        ...base,
        id: `model-${index}`,
        name: `모델 ${index}`,
        revisions: [base.revisions[0]],
      })),
    }
    render(
      <MemoryRouter>
        <PredictionFilesWorkspace scope="user:test" />
      </MemoryRouter>,
    )
    expect(screen.getAllByRole('row')).toHaveLength(51)
    fireEvent.click(screen.getByRole('button', { name: '다음' }))
    expect(screen.getAllByRole('row')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('모델명 검색'), { target: { value: '없는 이름' } })
    expect(screen.getByText('조건에 맞는 모델 파일이 없습니다.')).toBeInTheDocument()
  })
})
