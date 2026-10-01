import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/api/http'
import { optimizationApi } from '@/api/optimization'
import type {
  Optimization,
  OptimizationCreateRequest,
  OptimizationEvaluation,
  OptimizationSummary,
  OptimizationTrial,
} from '@/contracts/api/optimization'
import { useAuth } from '@/features/auth/use-auth'
import { optimizationQueryKeys } from './queryKeys'

function isExecuting(optimization: OptimizationSummary | undefined) {
  return (
    !!optimization &&
    (['running', 'pausing'].includes(optimization.state) ||
      optimization.executions_active > 0 ||
      optimization.cleanup_pending ||
      optimization.manual_retry_pending)
  )
}

export function useOptimizationData({
  experimentId,
  selectedId,
  onSelect,
  includeTrials = true,
}: {
  experimentId?: number
  selectedId?: string | null
  onSelect?: (id: string | null) => void
  includeTrials?: boolean
}) {
  const auth = useAuth()
  const client = useQueryClient()
  const [selection, setSelection] = useState<{
    requestedId: string | null | undefined
    localId: string | null
    ignoredId: string | null
  }>({ requestedId: selectedId, localId: null, ignoredId: null })
  const [offset, setOffset] = useState(0)
  const [trialPage, setTrialPage] = useState<{ id: string | null; offset: number }>({ id: null, offset: 0 })
  const [actions, setActions] = useState<Record<string, { pending: boolean; error: string | null }>>({})
  const requests = useRef(new Set<string>())
  const retryRequests = useRef(new Map<string, string>())
  const mounted = useRef(true)
  const previousExecution = useRef<{ id: string; active: boolean } | null>(null)
  const sameRequest = selection.requestedId === selectedId
  const requestedId = sameRequest && selectedId === selection.ignoredId ? null : selectedId
  const id = requestedId ?? (sameRequest ? selection.localId : null)
  const currentId = useRef(id)
  currentId.current = id
  const trialOffset = trialPage.id === id ? trialPage.offset : 0
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    setSelection((current) =>
      current.requestedId === selectedId
        ? current
        : {
            requestedId: selectedId,
            localId: null,
            ignoredId: selectedId == null ? current.ignoredId : null,
          },
    )
  }, [selectedId])
  const select = useCallback(
    (next: string | null) => {
      setSelection({ requestedId: selectedId, localId: next, ignoredId: null })
      setTrialPage({ id: next, offset: 0 })
      onSelect?.(next)
    },
    [onSelect, selectedId],
  )
  const list = useQuery({
    queryKey: optimizationQueryKeys.list(auth.queryScope, experimentId, offset),
    queryFn: ({ signal }) => optimizationApi.list({ experimentId, offset }, { signal }),
    enabled: auth.isAuthenticated,
    refetchInterval: 5_000,
  })
  useEffect(() => {
    if (id !== null) return
    const first = list.data?.items.find((item) => item.id !== selection.ignoredId)
    if (first) setSelection((current) => ({ ...current, requestedId: selectedId, localId: first.id }))
  }, [id, list.data, selectedId, selection.ignoredId])
  useEffect(() => {
    if (!list.data || list.data.items.length || offset === 0) return
    setOffset(Math.floor(Math.max(0, list.data.total - 1) / 20) * 20)
  }, [list.data, offset])
  const detail = useQuery({
    queryKey: optimizationQueryKeys.detail(auth.queryScope, id),
    queryFn: ({ signal }) => optimizationApi.read(id!, { signal }),
    enabled: auth.isAuthenticated && id !== null,
    retry: (attempt, cause) => !(cause instanceof ApiError && [403, 404].includes(cause.status)) && attempt < 2,
    refetchInterval: (query) => (isExecuting(query.state.data) ? 3_000 : false),
  })
  const unavailable =
    (detail.error instanceof ApiError && [403, 404].includes(detail.error.status)) ||
    (!!detail.data && experimentId !== undefined && detail.data.experiment_id !== experimentId)
  const optimization = !unavailable && detail.data?.id === id ? detail.data : undefined
  const executionBusy =
    !!optimization &&
    (optimization.executions_active > 0 || optimization.cleanup_pending || optimization.manual_retry_pending)
  const trials = useQuery({
    queryKey: optimizationQueryKeys.trials(auth.queryScope, id, trialOffset),
    queryFn: ({ signal }) => optimizationApi.trials(id!, trialOffset, { signal }),
    enabled: auth.isAuthenticated && optimization !== undefined && includeTrials,
    refetchInterval: includeTrials && isExecuting(optimization) ? 3_000 : false,
  })
  useEffect(() => {
    if (!optimization || !includeTrials) return
    const active = isExecuting(optimization)
    if (previousExecution.current?.id === optimization.id && previousExecution.current.active && !active) {
      void client.invalidateQueries({
        queryKey: optimizationQueryKeys.trials(auth.queryScope, optimization.id, trialOffset),
      })
    }
    previousExecution.current = { id: optimization.id, active }
  }, [auth.queryScope, client, includeTrials, optimization, trialOffset])

  async function action(target: string, run: () => Promise<unknown>, afterSuccess?: () => void) {
    if (requests.current.has(target)) return
    requests.current.add(target)
    setActions((current) => ({ ...current, [target]: { pending: true, error: null } }))
    try {
      await run()
      if (!mounted.current) return
      await client.invalidateQueries({ queryKey: optimizationQueryKeys.all(auth.queryScope) })
      if (!mounted.current) return
      if (currentId.current === target) afterSuccess?.()
    } catch (cause) {
      if (mounted.current)
        setActions((current) => ({
          ...current,
          [target]: {
            pending: false,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        }))
    } finally {
      requests.current.delete(target)
      if (mounted.current)
        setActions((current) => ({ ...current, [target]: { pending: false, error: current[target]?.error ?? null } }))
    }
  }

  return {
    id,
    optimization,
    executionBusy,
    list,
    detail,
    trials,
    offset,
    trialOffset,
    unavailableId: unavailable ? id : null,
    busy: id !== null && (actions[id]?.pending ?? false),
    error: id !== null ? (actions[id]?.error ?? null) : null,
    select,
    recover: () => {
      setSelection({ requestedId: selectedId, localId: null, ignoredId: id })
      onSelect?.(null)
    },
    page: (next: number) => {
      setOffset(Math.max(0, next))
      select(null)
    },
    pageTrials: (next: number) => setTrialPage({ id, offset: Math.max(0, next) }),
    refresh: () => client.invalidateQueries({ queryKey: optimizationQueryKeys.all(auth.queryScope) }),
    stop: (target: string) => action(target, () => optimizationApi.stop(target)),
    resume: (target: string) => action(target, () => optimizationApi.resume(target)),
    remove: (target: string) =>
      action(
        target,
        () => optimizationApi.remove(target),
        () => select(null),
      ),
    retry: (target: string, trial: OptimizationTrial) => {
      const key = `${target}:${trial.id}:${trial.retry_count}`
      const requestId = retryRequests.current.get(key) ?? crypto.randomUUID()
      retryRequests.current.set(key, requestId)
      return action(target, () => optimizationApi.retry(target, trial.id, requestId))
    },
    retryEvaluation: (target: string, evaluation: OptimizationEvaluation) => {
      const key = `${target}:evaluation:${evaluation.id}:${evaluation.retry_count}`
      const requestId = retryRequests.current.get(key) ?? crypto.randomUUID()
      retryRequests.current.set(key, requestId)
      return action(target, () => optimizationApi.retryEvaluation(target, evaluation.id, requestId))
    },
  }
}

export function useOptimizationCreation(onCreated: (optimization: Optimization) => void) {
  const { queryScope } = useAuth()
  const client = useQueryClient()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<{ fingerprint: string; id: string } | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const onCreatedRef = useRef(onCreated)
  onCreatedRef.current = onCreated
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function create(payload: Omit<OptimizationCreateRequest, 'request_id'>) {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(null)
    const fingerprint = JSON.stringify(payload)
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
    try {
      const optimization = await optimizationApi.create({ ...payload, request_id: request.current.id })
      if (!mounted.current) return
      await client.invalidateQueries({ queryKey: optimizationQueryKeys.lists(queryScope) })
      if (!mounted.current) return
      request.current = null
      onCreatedRef.current(optimization)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }
  return { create, pending, error }
}
