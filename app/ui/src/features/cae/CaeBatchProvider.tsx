import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { caeBatches, subscribeCaeEvents } from '@/api/cae'
import type { CaeBatchSummary, CaeEvent } from '@/contracts/api/cae'
import { useAuth } from '@/features/auth/use-auth'
import { createBatchObservation } from './batchObservation'
import { invalidateMeasurementMutation } from '@/features/measurement/queryInvalidation'

const CaeBatchContext = createContext<{
  batches: readonly CaeBatchSummary[]
  events: readonly CaeEvent[]
  connected: boolean
  loading: boolean
  error: string | null
  inspectedBatchId: string | null
  inspectBatch: (id: string | null) => void
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  hasMore: boolean
  loadingMore: boolean
  update: (batch: CaeBatchSummary) => CaeBatchSummary
  withProgress: ReturnType<typeof createBatchObservation>['withProgress']
  readPage: ReturnType<typeof createBatchObservation>['readPage']
  waitForChange: ReturnType<typeof createBatchObservation>['waitForChange']
} | null>(null)

export function CaeBatchProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [batches, setBatches] = useState<readonly CaeBatchSummary[]>([])
  const [events, setEvents] = useState<readonly CaeEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inspectedBatchId, inspectBatch] = useState<string | null>(null)
  const [dataScope, setDataScope] = useState(auth.queryScope)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  const loadMoreRef = useRef<() => Promise<void>>(async () => {})
  const [history, setHistory] = useState({ hasMore: false, loading: false })
  const observation = useMemo(() => createBatchObservation(auth.queryScope), [auth.queryScope])
  const update = observation.update
  const refresh = useCallback(() => refreshRef.current(), [])
  const loadMore = useCallback(() => loadMoreRef.current(), [])

  useEffect(() => {
    setDataScope(auth.queryScope)
    setBatches([])
    setEvents([])
    setConnected(false)
    setError(null)
    inspectBatch(null)
    setHistory({ hasMore: false, loading: false })
    if (!auth.isAuthenticated) {
      setLoading(false)
      refreshRef.current = async () => {}
      loadMoreRef.current = async () => {}
      return
    }
    const unsubscribe = observation.subscribe(() => {
      setBatches([...observation.batches.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)))
    })
    let active = true
    let closeStream: (() => void) | undefined
    let cursor: number | null = null
    let loadingList = false
    let loadingHistory = false
    let historyOffset = 0
    let historyTotal = 0
    let historyRevision = 0
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
            .readPage(id, { limit: 0 }, true)
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
        let firstCursor = first.cursor
        for (let offset = 0; ;) {
          const page = await caeBatches.list({ offset, attentionOnly: true }, { signal: controller.signal })
          firstCursor = Math.min(firstCursor, page.cursor)
          items.push(...page.items)
          offset += page.items.length
          if (!page.items.length || offset >= page.total) break
        }
        if (!active) return
        items.forEach(update)
        historyRevision++
        const added = first.total - historyTotal
        // Preserve loaded history only when the newest page covers all new rows.
        historyOffset =
          historyTotal && added <= first.items.length
            ? Math.max(first.items.length, historyOffset + added)
            : first.items.length
        historyTotal = first.total
        setHistory({ hasMore: historyOffset < historyTotal, loading: loadingHistory })
        setError(null)
        cursor ??= firstCursor
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
    loadMoreRef.current = async () => {
      if (!active || loadingList || loadingHistory || historyOffset >= historyTotal) return
      loadingHistory = true
      setHistory({ hasMore: true, loading: true })
      const offset = historyOffset
      const revision = historyRevision
      try {
        const page = await caeBatches.list({ offset }, { signal: controller.signal })
        if (!active) return
        page.items.forEach(update)
        if (revision === historyRevision) {
          historyOffset = offset + page.items.length
          historyTotal = page.items.length ? Math.max(historyTotal, page.total) : historyOffset
        }
        setError(null)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '이전 CAE 작업을 불러오지 못했습니다.')
      } finally {
        loadingHistory = false
        if (active) setHistory({ hasMore: historyOffset < historyTotal, loading: false })
      }
    }
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
      loadMoreRef.current = async () => {}
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
        loadMore,
        hasMore: dataScope === auth.queryScope && history.hasMore,
        loadingMore: dataScope === auth.queryScope && history.loading,
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
