import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeBatch } from '@/contracts/api/cae'
import { createBatchObservation } from './batchObservation'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/api/cae', () => ({ caeBatches: { read } }))
const batch: CaeBatch = {
  id: 'one',
  experiment_id: 1,
  mode: 'generate',
  total: 1,
  uploaded_count: 0,
  created_count: 1,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  state: 'running',
  created_at: '',
  updated_at: '',
  finished_at: null,
  last_event_id: 1,
  read_event_id: 0,
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
beforeEach(() => read.mockReset())
describe('shared batch observation', () => {
  it('shares in-flight pages and caches them until a newer snapshot arrives', async () => {
    const store = createBatchObservation()
    let resolve!: (value: CaeBatch) => void
    read.mockReturnValueOnce(
      new Promise<CaeBatch>((done) => {
        resolve = done
      }),
    )
    const first = store.readPage('one')
    const second = store.readPage('one')
    expect(first).toBe(second)
    resolve(batch)
    await first
    await store.readPage('one')
    expect(read).toHaveBeenCalledOnce()
    store.update({ ...batch, last_event_id: 4 })
    read.mockResolvedValue({ ...batch, last_event_id: 4 })
    await store.readPage('one')
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('keeps shared detail reads pending until they catch up with summaries received in flight', async () => {
    const store = createBatchObservation()
    store.update(batch)
    let resolveFirst!: (value: CaeBatch) => void
    let resolveRetry!: (value: CaeBatch) => void
    const completed: CaeBatch = {
      ...batch,
      state: 'completed',
      succeeded: 1,
      finished_at: 'finished',
      last_event_id: 3,
      jobs: [{ ...batch.jobs[0], state: 'succeeded' }],
    }
    read
      .mockReturnValueOnce(
        new Promise<CaeBatch>((resolve) => {
          resolveFirst = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise<CaeBatch>((resolve) => {
          resolveRetry = resolve
        }),
      )
      .mockResolvedValueOnce(completed)
    const pending = store.readPage('one')
    const delivered = vi.fn()
    void pending.then(delivered)
    store.update({ ...batch, last_event_id: 2 })
    resolveFirst(batch)
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(2)
    expect(delivered).not.toHaveBeenCalled()
    expect(store.readPage('one')).toBe(pending)

    store.update(completed)
    resolveRetry({ ...batch, last_event_id: 2 })
    const detail = await pending
    expect(detail.state).toBe('completed')
    expect(detail.jobs[0].state).toBe('succeeded')
    expect(detail.last_event_id).toBe(3)
    expect(read).toHaveBeenCalledTimes(3)
    expect(await store.readPage('one')).toEqual(detail)
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('overlays progress arriving during a snapshot fetch without hiding its state changes', async () => {
    const store = createBatchObservation()
    store.update(batch)
    let resolve!: (value: CaeBatch) => void
    read.mockReturnValueOnce(
      new Promise<CaeBatch>((done) => {
        resolve = done
      }),
    )
    const pending = store.readPage('one')
    store.applyEvent({
      id: 5,
      type: 'job.progress',
      batch_id: 'one',
      job_id: 'job',
      attempt_count: 1,
      created_at: 'new',
      payload: { progress: { completed: 9 } },
    })
    resolve({ ...batch, total: 2, last_event_id: 4 })
    const detail = await pending
    expect(store.batches.get('one')?.total).toBe(2)
    expect(store.batches.get('one')).not.toHaveProperty('jobs')
    expect(detail.jobs[0].progress).toEqual({ completed: 9 })
    expect(read).toHaveBeenCalledOnce()
  })
  it('keeps detail pages separate from summary-only refreshes and reloads only after a newer summary', async () => {
    const store = createBatchObservation()
    read.mockResolvedValueOnce(batch)
    await store.readPage('one')
    read.mockResolvedValueOnce({ ...batch, jobs: [] })
    await store.readPage('one', { limit: 0 }, true)
    expect((await store.readPage('one')).jobs).toEqual(batch.jobs)
    expect(read).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenLastCalledWith('one', { offset: 0, limit: 0 }, expect.any(Object))
    expect(store.batches.get('one')).not.toHaveProperty('jobs')

    read.mockResolvedValueOnce({ ...batch, last_event_id: 2, jobs: [] })
    await store.readPage('one', { limit: 0 }, true)
    const completed = { ...batch, last_event_id: 2, jobs: [{ ...batch.jobs[0], state: 'succeeded' }] }
    read.mockResolvedValueOnce(completed)
    expect((await store.readPage('one')).jobs).toEqual(completed.jobs)
    expect(read).toHaveBeenCalledTimes(4)
  })
  it('overlays only the current attempt without notifying summary observers for progress', () => {
    const store = createBatchObservation()
    const snapshot = store.update(batch)
    const changed = vi.fn()
    store.subscribe(changed)
    const progress = {
      id: 5,
      type: 'job.progress',
      batch_id: 'one',
      job_id: 'job',
      attempt_count: 1,
      created_at: 'new',
      payload: { progress: { completed: 9 } },
    }
    store.applyEvent(progress)
    expect(store.withProgress(batch).jobs[0].progress).toEqual({ completed: 9 })
    expect(store.withProgress({ ...batch, jobs: [{ ...batch.jobs[0], attempt_count: 2 }] }).jobs[0].progress).toBeNull()
    expect(store.withProgress({ ...batch, last_event_id: 6 }).jobs[0].progress).toBeNull()
    expect(store.batches.get('one')).toBe(snapshot)
    expect(changed).not.toHaveBeenCalled()
    store.applyEvent({ ...progress, id: 6, type: 'job.succeeded', payload: {} })
    expect(store.withProgress(batch).jobs[0].progress).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it('waits for snapshots without polling, resolves already received changes, and aborts observation', async () => {
    const store = createBatchObservation()
    const previous = store.update(batch)
    const controller = new AbortController()
    const waiting = store.waitForChange('one', previous, controller.signal)
    const complete = store.update({ ...batch, state: 'completed', last_event_id: 3 })
    expect(await waiting).toBe(complete)
    expect(await store.waitForChange('one', previous, controller.signal)).toBe(complete)
    const aborted = store.waitForChange('one', complete, controller.signal)
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
  })
})
