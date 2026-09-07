import { caeBatches } from '@/api/cae'
import type { CaeBatch, CaeEvent } from '@/contracts/api/cae'

/** One account's snapshots, page requests and foreground observers. */
export function createBatchObservation(scope = '') {
  const batches = new Map<string, CaeBatch>()
  const pages = new Map<string, CaeBatch>()
  const requests = new Map<string, Promise<CaeBatch>>()
  const controllers = new Set<AbortController>()
  const progress = new Map<string, CaeEvent>()
  const listeners = new Set<(batch: CaeBatch) => void>()

  function overlay(batch: CaeBatch): CaeBatch {
    return {
      ...batch,
      jobs: batch.jobs.map((job) => {
        const event = progress.get(job.id)
        return event && event.id > batch.last_event_id && event.attempt_count === job.attempt_count
          ? {
              ...job,
              progress: event.payload.progress as CaeBatch['jobs'][number]['progress'],
              updated_at: event.created_at,
            }
          : job
      }),
    }
  }
  function update(batch: CaeBatch) {
    const previous = batches.get(batch.id)
    if (previous && previous.last_event_id > batch.last_event_id) return previous
    const next = overlay({ ...batch, read_event_id: Math.max(batch.read_event_id, previous?.read_event_id ?? 0) })
    batches.set(next.id, next)
    for (const listener of listeners) listener(next)
    return next
  }
  function readPage(id: string, { offset = 0, limit = 100 } = {}, force = false): Promise<CaeBatch> {
    const key = `${scope}:${id}:${offset}:${limit}`
    const pending = requests.get(key)
    if (pending) return pending
    const cached = pages.get(key)
    if (!force && cached && cached.last_event_id >= (batches.get(id)?.last_event_id ?? 0))
      return Promise.resolve(overlay(cached))
    const controller = new AbortController()
    controllers.add(controller)
    const request = caeBatches
      .read(id, { offset, limit }, { signal: controller.signal })
      .then((batch) => {
        controller.signal.throwIfAborted()
        pages.set(key, batch)
        // Retain recently viewed pages, not every item of a large finished batch.
        if (pages.size > 32) pages.delete(pages.keys().next().value!)
        if (offset === 0) update(batch)
        return overlay(batch)
      })
      .finally(() => {
        requests.delete(key)
        controllers.delete(controller)
      })
    requests.set(key, request)
    return request
  }
  function applyEvent(event: CaeEvent) {
    if (!event.job_id) return
    if (event.type !== 'job.progress') {
      progress.delete(event.job_id)
      return
    }
    progress.set(event.job_id, event)
    const batch = batches.get(event.batch_id)
    if (batch) update(batch)
  }
  function waitForChange(id: string, previous: CaeBatch, signal: AbortSignal): Promise<CaeBatch> {
    signal.throwIfAborted()
    const current = batches.get(id)
    if (current && current !== previous) return Promise.resolve(current)
    return new Promise((resolve, reject) => {
      const changed = (batch: CaeBatch) => {
        if (batch.id !== id) return
        listeners.delete(changed)
        signal.removeEventListener('abort', abort)
        resolve(batch)
      }
      const abort = () => {
        listeners.delete(changed)
        reject(signal.reason)
      }
      listeners.add(changed)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  return {
    withProgress: overlay,
    batches,
    update,
    readPage,
    applyEvent,
    waitForChange,
    subscribe(listener: (batch: CaeBatch) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      controllers.forEach((controller) => controller.abort())
      pages.clear()
      progress.clear()
    },
  }
}
