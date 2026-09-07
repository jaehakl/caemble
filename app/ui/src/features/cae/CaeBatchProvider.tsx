import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { caeBatches, subscribeCaeEvents } from '@/api/cae'
import type { CaeBatch, CaeEvent } from '@/contracts/api/cae'
import { useAuth } from '@/features/auth/use-auth'
import { createBatchObservation } from './batchObservation'
import { invalidateMeasurementMutation } from '@/features/measurement/queryInvalidation'

const CaeBatchContext = createContext<{
  batches: readonly CaeBatch[]
  events: readonly CaeEvent[]
  connected: boolean
  loading: boolean
  error: string | null
  inspectedBatchId: string | null
  inspectBatch: (id: string | null) => void
  refresh: () => Promise<void>
  update: (batch: CaeBatch) => CaeBatch
  withProgress: ReturnType<typeof createBatchObservation>['withProgress']
  readPage: ReturnType<typeof createBatchObservation>['readPage']
  waitForChange: ReturnType<typeof createBatchObservation>['waitForChange']
} | null>(null)

export function CaeBatchProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [batches, setBatches] = useState<readonly CaeBatch[]>([])
  const [events, setEvents] = useState<readonly CaeEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inspectedBatchId, inspectBatch] = useState<string | null>(null)
  const [dataScope, setDataScope] = useState(auth.queryScope)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  const observation = useMemo(() => createBatchObservation(auth.queryScope), [auth.queryScope])
  const update = observation.update
  const refresh = useCallback(() => refreshRef.current(), [])

  useEffect(() => {
    setDataScope(auth.queryScope)
    setBatches([])
    setEvents([])
    setConnected(false)
    setError(null)
    inspectBatch(null)
    if (!auth.isAuthenticated) {
      setLoading(false)
      refreshRef.current = async () => {}
      return
    }
    const unsubscribe = observation.subscribe(() => {
      setBatches([...observation.batches.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)))
    })
    let active = true
    let closeStream: (() => void) | undefined
    let cursor: number | null = null
    let loadingList = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const pending = new Map<string, ReturnType<typeof setTimeout>>()
    const required = new Map<string, number>()
    const failures = new Map<string, number>()
    let reconnectAttempt = 0
    const controller = new AbortController()
    const refreshBatch = (id: string, delay = 250) => {
      if (!active || pending.has(id)) return
      pending.set(
        id,
        setTimeout(() => {
          const target = required.get(id)
          void observation
            .readPage(id, {}, true)
            .then(() => {
              if (!active) return
              failures.delete(id)
              pending.delete(id)
              if (required.get(id) !== target) refreshBatch(id)
            })
            .catch(() => {
              pending.delete(id)
              const attempt = failures.get(id) ?? 0
              failures.set(id, attempt + 1)
              refreshBatch(id, [5000, 10000, 30000][Math.min(attempt, 2)])
            })
        }, delay),
      )
    }
    const receive = (event: CaeEvent) => {
      if (!active || (cursor !== null && event.id <= cursor)) return
      cursor = event.id
      setEvents((current) => [...current, event].slice(-500))
      observation.applyEvent(event)
      if (event.type !== 'job.progress') {
        required.set(event.batch_id, event.id)
        refreshBatch(event.batch_id)
      }
      if (event.type === 'job.succeeded' && event.measurement_id) {
        void invalidateMeasurementMutation(queryClient, auth.queryScope, null, [event.measurement_id])
      }
    }
    const load = async () => {
      if (loadingList || !active) return
      loadingList = true
      closeStream?.()
      closeStream = undefined
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = undefined
      setConnected(false)
      setLoading(true)
      try {
        const first = await caeBatches.list({}, { signal: controller.signal })
        const items = [...first.items]
        for (let offset = items.length; offset < first.total; offset += 50) {
          const page = await caeBatches.list({ offset }, { signal: controller.signal })
          items.push(...page.items)
          if (!page.items.length) break
        }
        if (!active) return
        items.forEach(update)
        setError(null)
        cursor ??= first.cursor
        closeStream = subscribeCaeEvents(cursor, receive, (value) => {
          if (!active) return
          setConnected(value)
          if (value) {
            if (retryTimer) clearTimeout(retryTimer)
            retryTimer = undefined
            reconnectAttempt = 0
          } else if (!retryTimer) {
            retryTimer = setTimeout(() => void load(), [5000, 10000, 30000][Math.min(reconnectAttempt++, 2)])
          }
        })
      } catch (cause) {
        if (!active) return
        setError(cause instanceof Error ? cause.message : 'CAE 작업을 불러오지 못했습니다.')
        retryTimer = setTimeout(() => void load(), [5000, 10000, 30000][Math.min(reconnectAttempt++, 2)])
      } finally {
        loadingList = false
        if (active) setLoading(false)
      }
    }
    refreshRef.current = load
    void load()
    return () => {
      active = false
      unsubscribe()
      observation.dispose()
      controller.abort()
      closeStream?.()
      if (retryTimer) clearTimeout(retryTimer)
      pending.forEach(clearTimeout)
      refreshRef.current = async () => {}
    }
  }, [auth.isAuthenticated, auth.queryScope, queryClient, update, observation])

  return (
    <CaeBatchContext.Provider
      value={{
        batches: dataScope === auth.queryScope ? batches : [],
        events: dataScope === auth.queryScope ? events : [],
        inspectedBatchId: dataScope === auth.queryScope ? inspectedBatchId : null,
        inspectBatch,
        connected: dataScope === auth.queryScope && connected,
        loading: auth.isAuthenticated && (dataScope !== auth.queryScope || loading),
        error: dataScope === auth.queryScope ? error : null,
        refresh,
        update,
        readPage: observation.readPage,
        withProgress: observation.withProgress,
        waitForChange: observation.waitForChange,
      }}
    >
      {children}
    </CaeBatchContext.Provider>
  )
}

export function useCaeBatches() {
  const context = useContext(CaeBatchContext)
  if (!context) throw new Error('CaeBatchProvider is required.')
  return context
}
