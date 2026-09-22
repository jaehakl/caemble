import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropsWithChildren } from 'react'
import { caeBatchSummarySchema, type CaeBatch, type CaeEvent } from '@/contracts/api/cae'
import { CaeBatchProvider, useCaeBatches } from './CaeBatchProvider'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  subscribe: vi.fn(),
  close: vi.fn(),
  invalidate: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
  auth: { isAuthenticated: true, queryScope: 'user:first' },
}))
vi.mock('@/api/cae', () => ({
  caeBatches: { list: mocks.list, read: mocks.read },
  subscribeCaeEvents: mocks.subscribe,
}))
vi.mock('@/features/auth/use-auth', () => ({ useAuth: () => mocks.auth }))
vi.mock('@/features/measurement/queryInvalidation', () => ({ invalidateMeasurementMutation: mocks.invalidate }))
vi.mock('sonner', () => ({ toast: { success: mocks.success, warning: mocks.warning, dismiss: mocks.dismiss } }))

const completed: CaeBatch = {
  id: 'batch-1',
  experiment_id: 7,
  mode: 'generate',
  total: 2,
  uploaded_count: 0,
  created_count: 2,
  succeeded: 2,
  failed: 0,
  cancelled: 0,
  state: 'completed',
  created_at: '2026-09-07T00:00:00Z',
  updated_at: '2026-09-07T00:01:00Z',
  finished_at: '2026-09-07T00:01:00Z',
  last_event_id: 10,
  read_event_id: 0,
  jobs: [],
  jobs_total: 2,
}
function renderBatches() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <CaeBatchProvider>{children}</CaeBatchProvider>
    </QueryClientProvider>
  )
  return renderHook(() => useCaeBatches(), { wrapper })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth = { isAuthenticated: true, queryScope: 'user:first' }
  mocks.list.mockResolvedValue({ items: [caeBatchSummarySchema.parse(completed)], total: 1, cursor: 10 })
  mocks.read.mockResolvedValue(completed)
  mocks.subscribe.mockReturnValue(mocks.close)
  mocks.invalidate.mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())

describe('account-scoped CAE observation', () => {
  it('applies progress without GET requests or re-sorting summaries and coalesces detail observers', async () => {
    const detail: CaeBatch = {
      ...completed,
      state: 'running',
      finished_at: null,
      jobs: [
        {
          id: 'job',
          index: 1,
          attempt_count: 1,
          state: 'running',
          measurement_id: 1,
          progress: null,
          last_error: null,
          created_at: '',
          updated_at: '',
        },
      ],
    }
    mocks.list.mockResolvedValue({
      items: [caeBatchSummarySchema.parse(detail)],
      total: 1,
      cursor: 10,
    })
    mocks.read.mockResolvedValue(detail)
    const rendered = renderBatches()
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
    await act(async () => {
      await rendered.result.current.readPage('batch-1')
    })
    mocks.read.mockClear()
    const summaries = rendered.result.current.batches
    vi.useFakeTimers()
    const receive = mocks.subscribe.mock.calls[0][1] as (event: CaeEvent) => void
    act(() => {
      for (let id = 11; id <= 110; id++)
        receive({
          id,
          type: 'job.progress',
          batch_id: 'batch-1',
          job_id: 'job',
          attempt_count: 1,
          payload: { progress: { completed: id } },
          created_at: 'new',
        })
    })
    await act(async () => vi.advanceTimersByTimeAsync(60000))
    expect(mocks.read).not.toHaveBeenCalled()
    expect(rendered.result.current.batches).toBe(summaries)
    expect(rendered.result.current.batches[0]).not.toHaveProperty('jobs')
    expect(rendered.result.current.withProgress(detail).jobs[0].progress).toEqual({ completed: 110 })
    mocks.read.mockResolvedValue({ ...completed, last_event_id: 112 })
    act(() => {
      receive({ id: 111, type: 'job.succeeded', batch_id: 'batch-1', payload: {}, created_at: 'new' })
      receive({ id: 112, type: 'batch.completed', batch_id: 'batch-1', payload: {}, created_at: 'new' })
    })
    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith('batch-1', { offset: 0, limit: 0 }, expect.any(Object))
    await act(async () => {
      await Promise.all([rendered.result.current.readPage('batch-1'), rendered.result.current.readPage('batch-1')])
    })
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.read).toHaveBeenLastCalledWith('batch-1', { offset: 0, limit: 100 }, expect.any(Object))
  })

  it('restores durable completion notifications and resumes after the snapshot cursor', async () => {
    const rendered = renderBatches()
    await waitFor(() => expect(rendered.result.current.batches).toHaveLength(1))
    expect(mocks.subscribe).toHaveBeenCalledWith(10, expect.any(Function), expect.any(Function))
    expect(mocks.success).not.toHaveBeenCalled()
    await act(async () => rendered.result.current.refresh())
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('deduplicates replayed events and invalidates a persisted result', async () => {
    const rendered = renderBatches()
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
    const receive = mocks.subscribe.mock.calls[0][1] as (event: CaeEvent) => void
    const event: CaeEvent = {
      id: 11,
      type: 'job.succeeded',
      batch_id: 'batch-1',
      job_id: 'job-1',
      measurement_id: 41,
      payload: {},
      created_at: completed.updated_at,
    }
    act(() => {
      receive(event)
      receive(event)
    })
    expect(rendered.result.current.events).toEqual([event])
    expect(mocks.invalidate).toHaveBeenCalledOnce()
    expect(mocks.invalidate).toHaveBeenCalledWith(expect.anything(), 'user:first', null, [41])
  })

  it('clears account data and closes the observer on logout without cancelling jobs', async () => {
    const rendered = renderBatches()
    await waitFor(() => expect(rendered.result.current.batches).toHaveLength(1))
    mocks.auth = { isAuthenticated: false, queryScope: 'public' }
    rendered.rerender()
    expect(rendered.result.current.batches).toEqual([])
    expect(rendered.result.current.events).toEqual([])
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.dismiss).not.toHaveBeenCalled()
  })

  it('does not replace a newer batch snapshot with an older foreground response', async () => {
    const rendered = renderBatches()
    await waitFor(() => expect(rendered.result.current.batches).toHaveLength(1))
    act(() => rendered.result.current.update({ ...completed, state: 'running', last_event_id: 3, succeeded: 0 }))
    expect(rendered.result.current.batches[0].state).toBe('completed')
  })

  it('keeps its received cursor when a later snapshot is read during reconnect', async () => {
    const rendered = renderBatches()
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
    const receive = mocks.subscribe.mock.calls[0][1] as (event: CaeEvent) => void
    const event: CaeEvent = {
      id: 11,
      type: 'job.running',
      batch_id: 'batch-1',
      payload: {},
      created_at: completed.updated_at,
    }
    act(() => receive(event))
    mocks.list.mockResolvedValue({ items: [completed], total: 1, cursor: 15 })
    await act(async () => rendered.result.current.refresh())
    expect(mocks.subscribe).toHaveBeenLastCalledWith(11, expect.any(Function), expect.any(Function))
    const replay = mocks.subscribe.mock.calls[1][1] as (event: CaeEvent) => void
    act(() => {
      replay(event)
      replay({ ...event, id: 12 })
    })
    expect(rendered.result.current.events.map((item) => item.id)).toEqual([11, 12])
  })

  it('recovers snapshot reads after a transient failure without requiring another job event', async () => {
    const rendered = renderBatches()
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
    vi.useFakeTimers()
    mocks.read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...completed, last_event_id: 12 })
    const receive = mocks.subscribe.mock.calls[0][1] as (event: CaeEvent) => void
    act(() =>
      receive({ id: 12, type: 'batch.completed', batch_id: 'batch-1', payload: {}, created_at: completed.updated_at }),
    )
    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(mocks.read).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(rendered.result.current.batches[0].last_event_id).toBe(12)
  })

  it('reopens a persistently disconnected stream through an authenticated HTTP snapshot', async () => {
    renderBatches()
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
    vi.useFakeTimers()
    const connection = mocks.subscribe.mock.calls[0][2] as (value: boolean) => void
    act(() => connection(false))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(mocks.list).toHaveBeenCalledTimes(4)
    expect(mocks.subscribe).toHaveBeenCalledTimes(2)
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('loads only recent summaries and every attention page, then pages older history explicitly', async () => {
    const recent = Array.from({ length: 50 }, (_, index) =>
      caeBatchSummarySchema.parse({
        ...completed,
        id: `recent-${index}`,
        read_event_id: 10,
      }),
    )
    const older = Array.from({ length: 50 }, (_, index) =>
      caeBatchSummarySchema.parse({
        ...completed,
        id: `older-${index}`,
        read_event_id: 10,
        created_at: '2026-09-06T00:00:00Z',
      }),
    )
    const attention = Array.from({ length: 50 }, (_, index) =>
      caeBatchSummarySchema.parse({
        ...completed,
        id: `attention-${index}`,
        created_at: '2026-08-01T00:00:00Z',
        ...(index === 49 ? {} : { state: 'running', finished_at: null }),
      }),
    )
    mocks.list.mockImplementation(async ({ offset = 0, attentionOnly = false } = {}) => {
      const items = attentionOnly ? [recent[0], ...attention] : [...recent, ...older, ...attention]
      return {
        items: items.slice(offset, offset + 50),
        total: items.length,
        cursor: attentionOnly ? 8 - offset / 50 : 10,
      }
    })
    const rendered = renderBatches()
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
    expect(mocks.list.mock.calls.map(([options]) => options)).toEqual([
      {},
      { offset: 0, attentionOnly: true },
      { offset: 50, attentionOnly: true },
    ])
    expect(rendered.result.current.batches).toHaveLength(100)
    expect(rendered.result.current.batches.some((batch) => batch.id === 'attention-49')).toBe(true)
    expect(rendered.result.current.hasMore).toBe(true)
    expect(mocks.subscribe).toHaveBeenCalledWith(7, expect.any(Function), expect.any(Function))
    expect(mocks.read).not.toHaveBeenCalled()

    await act(async () => {
      await Promise.all([rendered.result.current.loadMore(), rendered.result.current.loadMore()])
    })
    expect(mocks.list).toHaveBeenLastCalledWith({ offset: 50 }, expect.any(Object))
    expect(mocks.list).toHaveBeenCalledTimes(4)
    expect(rendered.result.current.batches).toHaveLength(150)
    expect(rendered.result.current.hasMore).toBe(true)
    await act(async () => rendered.result.current.loadMore())
    expect(mocks.list).toHaveBeenLastCalledWith({ offset: 100 }, expect.any(Object))
    expect(rendered.result.current.hasMore).toBe(false)
    await act(async () => rendered.result.current.loadMore())
    expect(mocks.list).toHaveBeenCalledTimes(5)

    const receive = mocks.subscribe.mock.calls[0][1] as (event: CaeEvent) => void
    act(() => receive({ id: 8, type: 'job.progress', batch_id: recent[0].id, payload: {}, created_at: '' }))
    await act(async () => rendered.result.current.refresh())
    expect(mocks.list.mock.calls.slice(5).map(([options]) => options)).toEqual([
      {},
      { offset: 0, attentionOnly: true },
      { offset: 50, attentionOnly: true },
    ])
    expect(rendered.result.current.batches).toHaveLength(150)
    expect(rendered.result.current.hasMore).toBe(false)
    expect(mocks.subscribe).toHaveBeenLastCalledWith(8, expect.any(Function), expect.any(Function))
  })
  it('keeps the refreshed history position when an older page finishes after the refresh', async () => {
    const previous = Array.from({ length: 200 }, (_, index) =>
      caeBatchSummarySchema.parse({ ...completed, id: `previous-${index}`, read_event_id: 10 }),
    )
    let rows = previous
    let finishHistory!: (page: { items: typeof previous; total: number; cursor: number }) => void
    const oldPage = new Promise<{ items: typeof previous; total: number; cursor: number }>((resolve) => {
      finishHistory = resolve
    })
    let pendingHistoryReturned = false
    mocks.list.mockImplementation(({ offset = 0, attentionOnly = false } = {}) => {
      if (!attentionOnly && offset === 150 && !pendingHistoryReturned) {
        pendingHistoryReturned = true
        return oldPage
      }
      return Promise.resolve({
        items: attentionOnly ? [] : rows.slice(offset, offset + 50),
        total: attentionOnly ? 0 : rows.length,
        cursor: rows.length,
      })
    })
    const rendered = renderBatches()
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
    await act(async () => rendered.result.current.loadMore())
    await act(async () => rendered.result.current.loadMore())
    expect(rendered.result.current.batches).toHaveLength(150)
    let loading!: Promise<void>
    act(() => {
      loading = rendered.result.current.loadMore()
    })
    expect(rendered.result.current.loadingMore).toBe(true)

    rows = [
      ...Array.from({ length: 51 }, (_, index) =>
        caeBatchSummarySchema.parse({ ...completed, id: `new-${index}`, read_event_id: 10 }),
      ),
      ...previous,
    ]
    await act(async () => rendered.result.current.refresh())
    await act(async () => {
      finishHistory({ items: previous.slice(150), total: previous.length, cursor: previous.length })
      await loading
    })
    expect(rendered.result.current.loadingMore).toBe(false)
    expect(rendered.result.current.batches.some((batch) => batch.id === 'previous-199')).toBe(true)
    await act(async () => rendered.result.current.loadMore())
    expect(mocks.list).toHaveBeenLastCalledWith({ offset: 50 }, expect.any(Object))
    expect(rendered.result.current.batches.some((batch) => batch.id === 'new-50')).toBe(true)
    for (let page = 0; rendered.result.current.hasMore && page < 5; page++) {
      await act(async () => rendered.result.current.loadMore())
    }
    expect(rendered.result.current.hasMore).toBe(false)
    expect(new Set(rendered.result.current.batches.map((batch) => batch.id))).toEqual(
      new Set(rows.map((batch) => batch.id)),
    )
  })

  it.each([50, 51])('does not skip history when %i new rows arrive before a refresh', async (added) => {
    const previous = Array.from({ length: 150 }, (_, index) =>
      caeBatchSummarySchema.parse({
        ...completed,
        id: `previous-${index}`,
        read_event_id: 10,
      }),
    )
    let rows = previous
    mocks.list.mockImplementation(async ({ offset = 0, attentionOnly = false } = {}) => ({
      items: attentionOnly ? [] : rows.slice(offset, offset + 50),
      total: attentionOnly ? 0 : rows.length,
      cursor: rows.length,
    }))
    const rendered = renderBatches()
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce())
    await act(async () => rendered.result.current.loadMore())
    expect(rendered.result.current.batches).toHaveLength(100)

    rows = [
      ...Array.from({ length: added }, (_, index) =>
        caeBatchSummarySchema.parse({
          ...completed,
          id: `new-${index}`,
          read_event_id: 10,
        }),
      ),
      ...previous,
    ]
    mocks.list.mockClear()
    await act(async () => rendered.result.current.refresh())
    expect(mocks.list.mock.calls.map(([options]) => options)).toEqual([{}, { offset: 0, attentionOnly: true }])
    await act(async () => rendered.result.current.loadMore())
    expect(mocks.list).toHaveBeenLastCalledWith({ offset: added <= 50 ? 100 + added : 50 }, expect.any(Object))
    expect(rendered.result.current.batches.some((batch) => batch.id === `new-${added - 1}`)).toBe(true)
    for (let page = 0; rendered.result.current.hasMore && page < 4; page++) {
      await act(async () => rendered.result.current.loadMore())
    }
    expect(rendered.result.current.hasMore).toBe(false)
    expect(new Set(rendered.result.current.batches.map((batch) => batch.id))).toEqual(
      new Set(rows.map((batch) => batch.id)),
    )
  })
})
