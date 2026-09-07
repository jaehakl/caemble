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
    await pending
    expect(store.batches.get('one')?.total).toBe(2)
    expect(store.batches.get('one')?.jobs[0].progress).toEqual({ completed: 9 })
    expect(read).toHaveBeenCalledOnce()
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
