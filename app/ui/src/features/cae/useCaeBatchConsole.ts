import { useEffect, useRef } from 'react'
import { caeBatches } from '@/api/cae'
import type { RuntimeConsoleStore } from '@/features/runtime-console/store'
import { useCaeBatches } from './CaeBatchProvider'
import { describeCaeProgress } from './progress'

// Mounted once in the account-scoped Workbench, independently of the selected tab or run.
export function useCaeBatchConsole(store: RuntimeConsoleStore, visible: boolean) {
  const { batches, events, update } = useCaeBatches()
  const cursor = useRef(0)
  const ended = useRef(new Set<string>())
  const summaries = useRef(new Map<string, number>())
  const reading = useRef(new Set<string>())

  useEffect(() => {
    for (const event of events) {
      if (event.id <= cursor.current) continue
      cursor.current = event.id
      // Completion summaries come from snapshots, including completions while offline.
      if (event.type === 'batch.completed' || event.type === 'batch.cancelled') continue
      const id = `cae-progress-${event.batch_id}-${event.job_id}-${event.attempt_count}`
      const progress = event.type === 'job.progress'
      const terminal = ['job.succeeded', 'job.failed', 'job.cancelled'].includes(event.type)
      if (progress && ended.current.has(id)) continue
      const previous = store.getSnapshot().events.find((item) => item.id === id)
      const description = progress ? describeCaeProgress(event.payload.progress) : null
      const fraction = description?.fraction ?? previous?.progress
      const message =
        description?.message ?? (typeof event.payload.last_error === 'string' ? event.payload.last_error : event.type)
      if (progress || (terminal && previous)) {
        store.append({
          id,
          timestamp: previous?.timestamp ?? Date.parse(event.created_at),
          source: 'cae',
          level: event.type === 'job.failed' ? 'error' : event.type === 'job.cancelled' ? 'warning' : 'info',
          phase: event.type,
          message,
          jobId: event.job_id ?? undefined,
          progress: event.type === 'job.succeeded' ? 1 : fraction,
          details: { batchId: event.batch_id, attempt: event.attempt_count ?? null },
        })
      }
      if (terminal) ended.current.add(id)
      if (!progress)
        store.append({
          id: `cae-event-${event.id}`,
          timestamp: Date.parse(event.created_at),
          source: 'cae',
          level: event.type === 'job.failed' ? 'error' : event.type === 'job.cancelled' ? 'warning' : 'info',
          phase: event.type,
          message: `${message}${event.measurement_id ? ` · Measurement #${event.measurement_id}` : ''}`,
          jobId: event.job_id ?? undefined,
          details: { ...event.payload, batchId: event.batch_id },
        })
    }
    for (const batch of batches) {
      if (!batch.finished_at || batch.read_event_id >= batch.last_event_id) continue
      const id = `cae-batch-${batch.id}-${batch.last_event_id}`
      if ((summaries.current.get(batch.id) ?? 0) < batch.last_event_id) {
        summaries.current.set(batch.id, batch.last_event_id)
        store.append({
          id,
          source: 'cae',
          level: batch.failed ? 'error' : batch.cancelled ? 'warning' : 'info',
          phase: `batch.${batch.state}`,
          message: `CAE ${batch.total}회 ${batch.state === 'cancelled' ? '취소' : '완료'} · 성공 ${batch.succeeded}, 실패 ${batch.failed}, 취소 ${batch.cancelled}`,
          details: { batchId: batch.id, experimentId: batch.experiment_id },
        })
      }
      if (!visible || reading.current.has(id) || !store.getSnapshot().events.some((item) => item.id === id)) continue
      reading.current.add(id)
      void caeBatches
        .markRead(batch.id, batch.last_event_id)
        .then(() => update({ ...batch, read_event_id: batch.last_event_id }))
        .catch(() => {
          reading.current.delete(id)
        })
    }
  }, [batches, events, store, update, visible])
}
