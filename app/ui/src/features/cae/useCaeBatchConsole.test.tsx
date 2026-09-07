import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { CaeBatch, CaeEvent } from '@/contracts/api/cae'
import { createRuntimeConsoleStore } from '@/features/runtime-console/store'
import { useCaeBatchConsole } from './useCaeBatchConsole'

const mocks = vi.hoisted(() => ({
  events: [] as CaeEvent[],
  batches: [] as CaeBatch[],
  update: vi.fn(),
  markRead: vi.fn(),
}))
vi.mock('./CaeBatchProvider', () => ({ useCaeBatches: () => mocks }))
vi.mock('@/api/cae', () => ({ caeBatches: { markRead: mocks.markRead } }))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.events = []
  mocks.batches = []
  mocks.markRead.mockResolvedValue(undefined)
})

function event(
  id: number,
  type = 'job.progress',
  job = 'one',
  attempt = 1,
  progress: Record<string, unknown> = { completed: id, total: 100 },
): CaeEvent {
  return {
    id,
    type,
    batch_id: 'batch',
    job_id: job,
    attempt_count: attempt,
    created_at: '2026-09-07T00:00:00Z',
    payload: { progress },
  }
}

it('updates one row through numeric and message-only progress, preserving parallel runs and retries', () => {
  const store = createRuntimeConsoleStore()
  const view = renderHook(() => useCaeBatchConsole(store, false))
  mocks.events = Array.from({ length: 80 }, (_, i) => event(i + 1))
  view.rerender()
  expect(store.getSnapshot().events).toHaveLength(1)
  expect(store.getSnapshot().events[0].progress).toBe(0.8)
  mocks.events = [
    ...mocks.events,
    event(81, 'job.progress', 'one', 1, { message: 'cleanup' }),
    event(82, 'job.progress', 'two'),
    event(83, 'job.progress', 'one', 2),
  ]
  view.rerender()
  expect(store.getSnapshot().events).toHaveLength(3)
  expect(store.getSnapshot().events[0]).toMatchObject({ progress: 0.8, message: 'cleanup' })
  view.rerender()
  expect(store.getSnapshot().events).toHaveLength(3)
})

it.each(['job.succeeded', 'job.failed', 'job.cancelled'])(
  'freezes %s and rejects late progress while logging completion once',
  (type) => {
    const store = createRuntimeConsoleStore()
    mocks.events = [event(1), event(2, type, 'one', 1, {}), event(3)]
    const view = renderHook(() => useCaeBatchConsole(store, false))
    expect(store.getSnapshot().events).toHaveLength(2)
    expect(store.getSnapshot().events[0]).toMatchObject({ phase: type, progress: type === 'job.succeeded' ? 1 : 0.01 })
    view.rerender()
    expect(store.getSnapshot().events).toHaveLength(2)
  },
)

it('restores unread completions once and marks them read only when Console is visible', async () => {
  const store = createRuntimeConsoleStore()
  mocks.batches = [
    {
      id: 'batch',
      experiment_id: 1,
      mode: 'generate',
      total: 1,
      created_count: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      state: 'completed',
      created_at: '',
      updated_at: '',
      finished_at: 'now',
      last_event_id: 10,
      read_event_id: 0,
      jobs: [],
    },
  ]
  const view = renderHook(({ visible }) => useCaeBatchConsole(store, visible), { initialProps: { visible: false } })
  expect(store.getSnapshot().events).toHaveLength(1)
  expect(mocks.markRead).not.toHaveBeenCalled()
  mocks.events = [event(10, 'batch.completed')]
  view.rerender({ visible: true })
  await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce())
  view.rerender({ visible: true })
  expect(mocks.markRead).toHaveBeenCalledExactlyOnceWith('batch', 10)
  expect(store.getSnapshot().events).toHaveLength(1)
})
