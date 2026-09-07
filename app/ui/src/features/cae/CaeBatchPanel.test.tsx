import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeBatch } from '@/contracts/api/cae'
import { CaeBatchPanel } from './CaeBatchPanel'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  markRead: vi.fn(),
  update: vi.fn(),
  resume: vi.fn(),
  scope: 'user:first',
  batches: [] as CaeBatch[],
}))
vi.mock('@/api/cae', () => ({
  caeBatches: { read: mocks.read, retry: mocks.retry, cancel: mocks.cancel, markRead: mocks.markRead },
}))
vi.mock('@/features/auth/use-auth', () => ({ useAuth: () => ({ queryScope: mocks.scope }) }))
vi.mock('./resumeUpload', () => ({ resumeBrowserUpload: mocks.resume }))
vi.mock('./CaeBatchProvider', () => ({
  useCaeBatches: () => ({
    batches: mocks.batches,
    connected: true,
    error: null,
    inspectedBatchId: null,
    inspectBatch: vi.fn(),
    loading: false,
    refresh: vi.fn(),
    update: mocks.update,
    readPage: mocks.read,
    withProgress: (value: CaeBatch) => value,
  }),
}))

function failedBatch(id: string, experimentId: number): CaeBatch {
  return {
    id,
    experiment_id: experimentId,
    mode: 'generate',
    total: 1,
    uploaded_count: 0,
    created_count: 1,
    succeeded: 0,
    failed: 1,
    cancelled: 0,
    state: 'completed',
    created_at: '2026-09-07T00:00:00Z',
    updated_at: '2026-09-07T00:01:00Z',
    finished_at: '2026-09-07T00:01:00Z',
    last_event_id: 10,
    read_event_id: 10,
    jobs_total: 1,
    jobs: [
      {
        id: `job-${id}`,
        index: 1,
        attempt_count: 1,
        state: 'failed',
        measurement_id: 7,
        last_error: 'Worker disconnected',
        progress: { task: 'solve', stage: 'iteration', completed: 3, total: 10 },
        created_at: '',
        updated_at: '',
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.scope = 'user:first'
  mocks.batches = [failedBatch('batch-1', 7)]
  mocks.read.mockImplementation(async (id: string) => mocks.batches.find((batch) => batch.id === id))
  mocks.retry.mockResolvedValue(mocks.batches[0])
  mocks.markRead.mockResolvedValue(undefined)
})

describe('CAE batch panel', () => {
  it('resumes a stored upload explicitly and shows upload progress', async () => {
    const user = userEvent.setup()
    const pending = {
      ...failedBatch('batch-1', 7),
      state: 'uploading' as const,
      request_id: 'original-request',
      total: 3,
      uploaded_count: 1,
      failed: 0,
      finished_at: null,
    }
    const completed = { ...pending, state: 'queued' as const, uploaded_count: 3 }
    mocks.batches = [pending]
    mocks.resume.mockImplementation(async (_batch, _signal, progress) => {
      progress(2, 3)
      return completed
    })
    render(<CaeBatchPanel />)
    expect(screen.getByRole('progressbar', { name: 'Batch batch-1 업로드 진행률' })).toHaveAttribute('value', '1')
    await user.click(screen.getByRole('button', { name: /Experiment #7/ }))
    expect(mocks.resume).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: '업로드 재개' }))
    expect(mocks.resume).toHaveBeenCalledWith(pending, expect.any(AbortSignal), expect.any(Function))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(completed))
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('explains when the original build is missing from this browser', async () => {
    const user = userEvent.setup()
    mocks.batches = [{ ...failedBatch('batch-1', 7), state: 'uploading', failed: 0, finished_at: null }]
    mocks.resume.mockRejectedValue(
      new Error('이 브라우저에 저장된 빌드 결과가 없습니다. 처음 업로드한 브라우저에서 재개하세요.'),
    )
    render(<CaeBatchPanel />)
    await user.click(screen.getByRole('button', { name: /Experiment #7/ }))
    await user.click(await screen.findByRole('button', { name: '업로드 재개' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('처음 업로드한 브라우저에서 재개하세요.')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('aborts an upload when unmounted without cancelling the server batch', async () => {
    const user = userEvent.setup()
    const pending = { ...failedBatch('batch-1', 7), state: 'uploading' as const, failed: 0, finished_at: null }
    mocks.batches = [pending]
    let signal!: AbortSignal
    let finish!: (value: CaeBatch) => void
    mocks.resume.mockImplementation((_batch, value) => {
      signal = value
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const rendered = render(<CaeBatchPanel />)
    await user.click(screen.getByRole('button', { name: /Experiment #7/ }))
    await user.click(await screen.findByRole('button', { name: '업로드 재개' }))
    expect(signal.aborted).toBe(false)
    rendered.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => finish({ ...pending, state: 'queued' }))
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('keeps explicit server cancellation available during a resumed upload', async () => {
    const user = userEvent.setup()
    const pending = { ...failedBatch('batch-1', 7), state: 'uploading' as const, failed: 0, finished_at: null }
    mocks.batches = [pending]
    let signal!: AbortSignal
    mocks.resume.mockImplementation((_batch, value) => {
      signal = value
      return new Promise(() => {})
    })
    mocks.cancel.mockResolvedValue({ ...pending, state: 'cancelled' })
    render(<CaeBatchPanel />)
    await user.click(screen.getByRole('button', { name: /Experiment #7/ }))
    await user.click(await screen.findByRole('button', { name: '업로드 재개' }))
    await user.click(screen.getByRole('button', { name: 'Batch 취소' }))
    expect(signal.aborted).toBe(true)
    expect(mocks.cancel).toHaveBeenCalledWith('batch-1')
  })

  it('shows server progress and only retries the failed job after the user requests it', async () => {
    const user = userEvent.setup()
    render(<CaeBatchPanel />)
    await user.click(screen.getByRole('button', { name: /Experiment #7/ }))
    expect(await screen.findByText('solve · iteration · 3/10')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '작업 1 진행률' })).toHaveAttribute('value', '0.3')
    expect(mocks.retry).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '이 작업 재시도' }))
    expect(mocks.retry).toHaveBeenCalledWith('batch-1', ['job-batch-1'])
  })

  it('discards an old account dialog request when the account changes', async () => {
    const user = userEvent.setup()
    let finish!: (value: CaeBatch) => void
    mocks.retry.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const rendered = render(<CaeBatchPanel />)
    await user.click(screen.getByRole('button', { name: /Experiment #7/ }))
    await user.click(await screen.findByRole('button', { name: '실패한 작업 재시도' }))
    mocks.scope = 'user:second'
    mocks.batches = [failedBatch('batch-2', 8)]
    rendered.rerender(<CaeBatchPanel />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Experiment #8/ }))
    await waitFor(() => expect(screen.getByText('batch-2')).toBeInTheDocument())
    await act(async () => finish(failedBatch('batch-1', 7)))
    expect(screen.getByText('batch-2')).toBeInTheDocument()
    expect(screen.queryByText('batch-1')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
