import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, expect, it, vi } from 'vitest'
import { optimizationApi } from '@/api/optimization'
import { studyDetailSchema, studyTrialSchema } from '@/contracts/api/optimization'
import { StudyManagement } from './StudyManagement'
import { studyFixture, trialFixture } from './fixtures.test-support'

vi.mock('@/features/auth/use-auth', () => ({ useAuth: () => ({ isAuthenticated: true, queryScope: 'user:first' }) }))
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
  vi.mocked(optimizationApi.list).mockResolvedValue({ items: [studyFixture], total: 1 })
  vi.mocked(optimizationApi.read).mockResolvedValue(studyFixture)
  vi.mocked(optimizationApi.trials).mockResolvedValue({ items: [trialFixture], total: 1 })
  vi.mocked(optimizationApi.retry).mockResolvedValue(studyFixture)
})

it('reads one Study group, displays stage history, and retries only through the Study route', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const apply = vi.fn()
  const page = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StudyManagement onApplyBest={apply} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(studyDetailSchema.parse(studyFixture)).toEqual(studyFixture)
  expect(studyTrialSchema.parse(trialFixture)).toEqual(trialFixture)
  await screen.findByText('Trial 2')
  expect(screen.getByText('Job build-job')).toBeInTheDocument()
  expect(screen.getByText('Job solve-job')).toBeInTheDocument()
  expect(screen.getByText('Job calculate-job')).toBeInTheDocument()
  expect(screen.getByLabelText('Study 목록').children).toHaveLength(1)
  expect(screen.getByText('재개')).toBeDisabled()
  fireEvent.click(screen.getByText('실패 단계 재시도'))
  await waitFor(() => expect(optimizationApi.retry).toHaveBeenCalledWith('study-1', 'trial-2', expect.any(String)))
  expect(optimizationApi.stop).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('최선 Vars로 새 Candidate 열기'))
  expect(apply).toHaveBeenCalledWith(studyFixture)
  page.unmount()
  expect(optimizationApi.stop).not.toHaveBeenCalled()
})

it.each([{ state: 'pausing' }, { executions_active: 1 }, { cleanup_pending: true }, { manual_retry_pending: true }])(
  'blocks retries while prior Study work is active: %j',
  async (status) => {
    const study = { ...studyFixture, ...status }
    vi.mocked(optimizationApi.read).mockResolvedValue(study)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <StudyManagement />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('실패 단계 재시도')).toBeDisabled()
    expect(screen.getByText('삭제')).toBeDisabled()
    expect(optimizationApi.retry).not.toHaveBeenCalled()
  },
)

it('resumes dormant pending Trials when there are no failed Trials or active executions', async () => {
  vi.mocked(optimizationApi.read).mockResolvedValue({ ...studyFixture, failed: 0, active: 2 })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StudyManagement />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(await screen.findByText('재개')).toBeEnabled()
})

it('keeps ambiguous transport retries idempotent but advances after an accepted retry fails before submission', async () => {
  vi.mocked(optimizationApi.retry).mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue(studyFixture)
  vi.mocked(optimizationApi.trials)
    .mockResolvedValueOnce({ items: [trialFixture], total: 1 })
    .mockResolvedValue({ items: [{ ...trialFixture, retry_count: 1 }], total: 1 })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StudyManagement />
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
