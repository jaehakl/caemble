import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, expect, it, vi } from 'vitest'
import { optimizationApi } from '@/api/optimization'
import { ApiError } from '@/api/http'
import { optimizationDetailSchema, optimizationTrialSchema } from '@/contracts/api/optimization'
import { OptimizationManagement } from './OptimizationManagement'
import { optimizationFixture, trialFixture } from './fixtures.test-support'
import { optimizationQueryKeys } from './queryKeys'

const auth = vi.hoisted(() => ({ isAuthenticated: true, queryScope: 'user:first' }))
vi.mock('@/features/auth/use-auth', () => ({ useAuth: () => auth }))
vi.mock('@/api/optimization', () => ({
  optimizationApi: {
    list: vi.fn(),
    read: vi.fn(),
    trials: vi.fn(),
    retry: vi.fn(),
    stop: vi.fn(),
    resume: vi.fn(),
    remove: vi.fn(),
  },
}))
beforeEach(() => {
  vi.clearAllMocks()
  auth.queryScope = 'user:first'
  vi.mocked(optimizationApi.list).mockResolvedValue({ items: [optimizationFixture], total: 1 })
  vi.mocked(optimizationApi.read).mockResolvedValue(optimizationFixture)
  vi.mocked(optimizationApi.trials).mockResolvedValue({ items: [trialFixture], total: 1 })
  vi.mocked(optimizationApi.retry).mockResolvedValue(optimizationFixture)
})

it('reads one Optimization group, displays stage history, and retries only through the Optimization route', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const apply = vi.fn()
  const page = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement onApplyBest={apply} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(optimizationDetailSchema.parse(optimizationFixture)).toEqual(optimizationFixture)
  expect(optimizationTrialSchema.parse(trialFixture)).toEqual(trialFixture)
  await screen.findByText('Trial 2')
  expect(screen.getByText('Job build-job')).toBeInTheDocument()
  expect(screen.getByText('Job solve-job')).toBeInTheDocument()
  expect(screen.getByText('Job calculate-job')).toBeInTheDocument()
  expect(screen.getByLabelText('Optimization 목록').children).toHaveLength(1)
  expect(screen.getByText('재개')).toBeDisabled()
  fireEvent.click(screen.getByText('실패 단계 재시도'))
  await waitFor(() =>
    expect(optimizationApi.retry).toHaveBeenCalledWith('optimization-1', 'trial-2', expect.any(String)),
  )
  expect(optimizationApi.stop).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('최선 Vars로 새 Candidate 열기'))
  expect(apply).toHaveBeenCalledWith(optimizationFixture)
  page.unmount()
  expect(optimizationApi.stop).not.toHaveBeenCalled()
})

it.each([{ state: 'pausing' }, { executions_active: 1 }, { cleanup_pending: true }, { manual_retry_pending: true }])(
  'blocks retries while prior Optimization work is active: %j',
  async (status) => {
    const optimization = { ...optimizationFixture, ...status }
    vi.mocked(optimizationApi.read).mockResolvedValue(optimization)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <OptimizationManagement />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('실패 단계 재시도')).toBeDisabled()
    expect(screen.getByText('삭제')).toBeDisabled()
    expect(optimizationApi.retry).not.toHaveBeenCalled()
  },
)

it('resumes dormant pending Trials when there are no failed Trials or active executions', async () => {
  vi.mocked(optimizationApi.read).mockResolvedValue({ ...optimizationFixture, failed: 0, active: 2 })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(await screen.findByText('재개')).toBeEnabled()
})

it('keeps ambiguous transport retries idempotent but advances after an accepted retry fails before submission', async () => {
  vi.mocked(optimizationApi.retry)
    .mockRejectedValueOnce(new Error('Connection lost'))
    .mockResolvedValue(optimizationFixture)
  vi.mocked(optimizationApi.trials)
    .mockResolvedValueOnce({ items: [trialFixture], total: 1 })
    .mockResolvedValue({ items: [{ ...trialFixture, retry_count: 1 }], total: 1 })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByText('실패 단계 재시도'))
  await screen.findByText('Connection lost')
  fireEvent.click(screen.getByText('실패 단계 재시도'))
  await screen.findByText('수동 재시도 1회 · 새 Trial 예산을 사용하지 않습니다.')
  await waitFor(() => expect(screen.getByText('실패 단계 재시도')).toBeEnabled())
  fireEvent.click(screen.getByText('실패 단계 재시도'))
  await waitFor(() => expect(optimizationApi.retry).toHaveBeenCalledTimes(3))
  const requests = vi.mocked(optimizationApi.retry).mock.calls.map((args) => args[2])
  expect(requests[0]).toBe(requests[1])
  expect(requests[2]).not.toBe(requests[1])
  expect(screen.getByText('Trial 2 / 20 · 성공 1 · 실패 1')).toBeInTheDocument()
})

it('starts at the first Trial page when the selected Optimization changes externally', async () => {
  vi.mocked(optimizationApi.trials).mockResolvedValue({ items: [trialFixture], total: 40 })
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => ({ ...optimizationFixture, id }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onSelect = vi.fn()
  const view = (id: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement selectedId={id} onSelect={onSelect} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const page = render(view('optimization-1'))
  fireEvent.click(await screen.findByText('다음 Trial'))
  await waitFor(() => expect(optimizationApi.trials).toHaveBeenCalledWith('optimization-1', 20, expect.anything()))
  page.rerender(view('optimization-2'))
  await waitFor(() => expect(optimizationApi.trials).toHaveBeenCalledWith('optimization-2', 0, expect.anything()))
  expect(optimizationApi.trials).not.toHaveBeenCalledWith('optimization-2', 20, expect.anything())
})

it('refreshes final Trial results when a running Optimization becomes terminal', async () => {
  vi.mocked(optimizationApi.read).mockResolvedValue({ ...optimizationFixture, state: 'running' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByText('Trial 2')
  const calls = vi.mocked(optimizationApi.trials).mock.calls.length
  act(() =>
    client.setQueryData(optimizationQueryKeys.detail('user:first', 'optimization-1'), {
      ...optimizationFixture,
      state: 'completed',
    }),
  )
  await waitFor(() => expect(optimizationApi.trials).toHaveBeenCalledTimes(calls + 1))
})

function renderManagement(selectedId?: string | null, experimentId?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onSelect = vi.fn()
  const view = (id?: string | null, experiment?: number) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement selectedId={id} experimentId={experiment} onSelect={onSelect} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const page = render(view(selectedId, experimentId))
  return {
    ...page,
    client,
    onSelect,
    update: (id?: string | null, experiment?: number) => page.rerender(view(id, experiment)),
  }
}

it('pins the initial selection while polling reorders the list without changing URL history', async () => {
  const first = { ...optimizationFixture, name: 'First optimization' }
  const second = { ...optimizationFixture, id: 'optimization-2', name: 'Second optimization' }
  vi.mocked(optimizationApi.list).mockResolvedValue({ items: [first, second], total: 2 })
  const page = renderManagement()
  await screen.findByText('Trial 2')
  act(() =>
    page.client.setQueryData(optimizationQueryKeys.list('user:first', undefined, 0), {
      items: [second, first],
      total: 2,
    }),
  )
  expect(screen.getByRole('button', { name: /First optimization/ })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: /Second optimization/ })).toHaveAttribute('aria-pressed', 'false')
  expect(page.onSelect).not.toHaveBeenCalled()
})

it('returns to the default selection when browser history clears an explicit URL target', async () => {
  const first = { ...optimizationFixture, name: 'First optimization' }
  const second = { ...optimizationFixture, id: 'optimization-2', name: 'Second optimization' }
  vi.mocked(optimizationApi.list).mockResolvedValue({ items: [first, second], total: 2 })
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => (id === second.id ? second : first))
  const page = renderManagement(null)
  fireEvent.click(await screen.findByRole('button', { name: /Second optimization/ }))
  page.update(second.id)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Second optimization/ })).toHaveAttribute('aria-pressed', 'true'),
  )
  page.update(null)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /First optimization/ })).toHaveAttribute('aria-pressed', 'true'),
  )
})

it('offers explicit recovery for a missing URL target and keeps the list available', async () => {
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => {
    if (id === 'missing') throw new ApiError(404, 'Not found', null)
    return optimizationFixture
  })
  const page = renderManagement('missing')
  const recover = await screen.findByRole('button', { name: '목록으로 돌아가기' })
  expect(screen.getByLabelText('Optimization 목록').children).toHaveLength(1)
  expect(optimizationApi.trials).not.toHaveBeenCalled()
  expect(page.onSelect).not.toHaveBeenCalled()
  fireEvent.click(recover)
  await screen.findByText('Trial 2')
  expect(page.onSelect).toHaveBeenCalledWith(null)
})

it('does not show a foreign Experiment target under the current Experiment', async () => {
  vi.mocked(optimizationApi.read).mockResolvedValue({ ...optimizationFixture, experiment_id: 8 })
  renderManagement(optimizationFixture.id, 7)
  await screen.findByRole('button', { name: '목록으로 돌아가기' })
  expect(optimizationApi.trials).not.toHaveBeenCalled()
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
})

it('scopes pending requests and late errors to their target Optimization', async () => {
  const first = { ...optimizationFixture, name: 'First optimization', failed: 0 }
  const second = { ...first, id: 'optimization-2', name: 'Second optimization' }
  vi.mocked(optimizationApi.list).mockResolvedValue({ items: [first, second], total: 2 })
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => (id === second.id ? second : first))
  let reject!: (cause: Error) => void
  vi.mocked(optimizationApi.resume).mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      }),
  )
  renderManagement()
  fireEvent.click(await screen.findByRole('button', { name: '재개' }))
  expect(screen.getByRole('button', { name: '재개' })).toBeDisabled()
  expect(screen.getByText('요청을 처리하고 있습니다…')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Second optimization/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: '재개' })).toBeEnabled())
  expect(screen.queryByText('요청을 처리하고 있습니다…')).not.toBeInTheDocument()
  await act(async () => reject(new Error('First request failed')))
  expect(screen.queryByText('First request failed')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /First optimization/ }))
  expect(await screen.findByText('First request failed')).toBeInTheDocument()
})

it('does not change the current selection after a previous target finishes deleting', async () => {
  const first = { ...optimizationFixture, name: 'First optimization' }
  const second = { ...first, id: 'optimization-2', name: 'Second optimization' }
  vi.mocked(optimizationApi.list).mockResolvedValue({ items: [first, second], total: 2 })
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => (id === second.id ? second : first))
  let finish!: () => void
  vi.mocked(optimizationApi.remove).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const page = renderManagement()
  fireEvent.click(await screen.findByRole('button', { name: '삭제' }))
  fireEvent.click(screen.getByRole('button', { name: /Second optimization/ }))
  await act(async () => finish())
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Second optimization/ })).toHaveAttribute('aria-pressed', 'true'),
  )
  expect(page.onSelect).not.toHaveBeenCalledWith(null)
  confirm.mockRestore()
})

it('returns to the preceding page after the last Optimization on a page is deleted', async () => {
  const first = { ...optimizationFixture, name: 'First page optimization' }
  const last = { ...optimizationFixture, id: 'last', name: 'Last page optimization' }
  let removed = false
  vi.mocked(optimizationApi.list).mockImplementation(async ({ offset } = {}) => ({
    items: offset === 20 ? (removed ? [] : [last]) : [first],
    total: removed ? 20 : 21,
  }))
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => (id === last.id ? last : first))
  vi.mocked(optimizationApi.remove).mockImplementation(async () => {
    removed = true
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderManagement()
  fireEvent.click(await screen.findByRole('button', { name: '다음' }))
  await screen.findByRole('button', { name: /Last page optimization/ })
  fireEvent.click(await screen.findByRole('button', { name: '삭제' }))
  expect(await screen.findByRole('button', { name: /First page optimization/ })).toHaveAttribute('aria-pressed', 'true')
  confirm.mockRestore()
})

it('ignores mutation completion after switching account scope', async () => {
  let finish!: () => void
  vi.mocked(optimizationApi.remove).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const page = renderManagement()
  fireEvent.click(await screen.findByRole('button', { name: '삭제' }))
  auth.queryScope = 'user:second'
  page.update()
  await act(async () => finish())
  expect(page.onSelect).not.toHaveBeenCalledWith(null)
  confirm.mockRestore()
})

it('skips an unavailable item still present in the cached list when clearing its URL', async () => {
  vi.mocked(optimizationApi.list).mockResolvedValue({
    items: [
      { ...optimizationFixture, id: 'missing' },
      { ...optimizationFixture, name: 'Available optimization' },
    ],
    total: 2,
  })
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => {
    if (id === 'missing') throw new ApiError(404, 'Not found', null)
    return optimizationFixture
  })
  const page = renderManagement('missing')
  fireEvent.click(await screen.findByRole('button', { name: '목록으로 돌아가기' }))
  page.update(null)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Available optimization/ })).toHaveAttribute('aria-pressed', 'true'),
  )
  expect(screen.queryByRole('button', { name: '목록으로 돌아가기' })).not.toBeInTheDocument()
})

it('keeps Settings compact with controls and best objective, linking to Workbench for full history', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement compact />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const link = await screen.findByRole('link', { name: 'Workbench에서 열기' })
  expect(link).toHaveAttribute('href', `/?experiment=7&optimization=${optimizationFixture.id}`)
  expect(screen.getByRole('button', { name: '삭제' })).toBeEnabled()
  expect(screen.getByRole('progressbar', { name: '평가 예산 사용' })).toHaveAttribute('aria-valuenow', '2')
  expect(screen.getByText('최선 후보 · Trial 1')).toBeInTheDocument()
  expect(screen.queryByText('Vars 확인')).not.toBeInTheDocument()
  expect(screen.queryByText('고정된 평가 정의')).not.toBeInTheDocument()
  expect(screen.queryByRole('list', { name: 'Trial 이력' })).not.toBeInTheDocument()
  expect(screen.queryByText('실패 단계 재시도')).not.toBeInTheDocument()
  expect(optimizationApi.trials).not.toHaveBeenCalled()
  expect(
    screen.getByRole('button', { name: '삭제' }).compareDocumentPosition(screen.getByRole('progressbar')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
})
