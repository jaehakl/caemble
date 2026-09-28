import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type {
  AnalysisProfile,
  AnalysisRelationshipPlot,
  AnalysisRelationshipsResult,
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
} from './analysis-types'
import { analysisLifecycleReducer, initialAnalysisLifecycleState, selectAnalysisLifecycle } from './analysisLifecycle'
import { parseAnalysisWorkerResponse } from './analysisProtocol'
import analysisWorkerAssetUrl from './analysis.worker.ts?worker&url'

export function useAnalysisController({
  dataReadable,
  experimentId,
}: {
  dataReadable: boolean
  experimentId: number | null
}) {
  const [profile, setProfile] = useState<AnalysisProfile | null>(null)
  const [relationships, setRelationships] = useState<AnalysisRelationshipsResult | null>(null)
  const [relationshipPlot, setRelationshipPlot] = useState<AnalysisRelationshipPlot | null>(null)
  const [relationshipOffset, setRelationshipOffset] = useState(0)
  const [exploreInputKey, setExploreInputKey] = useState('')
  const [exploreTargetKey, setExploreTargetKey] = useState('')
  const [lifecycle, dispatchLifecycle] = useReducer(analysisLifecycleReducer, initialAnalysisLifecycleState)
  const workerRef = useRef<Worker | null>(null)
  const requestSequence = useRef(0)
  const loadRequestId = useRef('')
  const relationshipsRequestId = useRef('')
  const plotRequestId = useRef('')
  const staleRequestId = useRef('')
  const exploreInputRef = useRef('')
  const exploreTargetRef = useRef('')

  exploreInputRef.current = exploreInputKey
  exploreTargetRef.current = exploreTargetKey

  const nextRequestId = useCallback((kind: string) => {
    requestSequence.current += 1
    return `analysis-${kind}-${requestSequence.current}`
  }, [])

  useEffect(() => {
    if (!dataReadable || experimentId === null) return
    const workerUrl = new URL(analysisWorkerAssetUrl, window.location.href)
    workerUrl.searchParams.set('response-policy', 'connect-self-v1')
    const worker = new Worker(workerUrl, { type: 'module' })
    workerRef.current = worker
    setProfile(null)
    setRelationships(null)
    setRelationshipPlot(null)
    dispatchLifecycle({ type: 'loadStarted' })
    const requestId = nextRequestId('load')
    loadRequestId.current = requestId

    worker.onmessage = (event: MessageEvent<unknown>) => {
      let response: AnalysisWorkerResponse
      try {
        response = parseAnalysisWorkerResponse(event.data)
      } catch {
        dispatchLifecycle({
          type: 'failed',
          message: 'Analysis Worker 응답 계약이 일치하지 않습니다.',
          clearProgress: true,
        })
        return
      }
      if (response.type === 'progress') {
        if ([loadRequestId.current, relationshipsRequestId.current].includes(response.requestId)) {
          dispatchLifecycle({
            type: 'progress',
            stage: response.stage,
            ...(response.completed === undefined ? {} : { completed: response.completed }),
            ...(response.total === undefined ? {} : { total: response.total }),
          })
        }
        return
      }
      if (response.type === 'profile' && response.requestId === loadRequestId.current) {
        const features = response.profile.columns
          .filter((column) => column.kind === 'feature' && column.eligible)
          .sort(
            (left, right) =>
              Number(left.source !== 'measurement-vars') - Number(right.source !== 'measurement-vars') ||
              left.key.localeCompare(right.key),
          )
        const inputs = features.filter((column) => column.source === 'measurement-vars')
        const targets = response.profile.columns.filter((column) => column.kind === 'target' && column.eligible)
        const initialInput = inputs[0]?.key ?? ''
        const initialTarget = targets[0]?.key ?? ''
        setProfile(response.profile)
        setExploreInputKey(initialInput)
        setExploreTargetKey(initialTarget)
        exploreInputRef.current = initialInput
        exploreTargetRef.current = initialTarget
        dispatchLifecycle({ type: 'loadSucceeded' })
        const relationshipsId = nextRequestId('relationships')
        relationshipsRequestId.current = relationshipsId
        dispatchLifecycle({ type: 'relationshipsStarted' })
        worker.postMessage({ type: 'relationships', requestId: relationshipsId } satisfies AnalysisWorkerRequest)
        return
      }
      if (response.type === 'relationships' && response.requestId === relationshipsRequestId.current) {
        setRelationships(response.result)
        setRelationshipOffset(0)
        dispatchLifecycle({ type: 'relationshipsSucceeded' })
        const first = response.result.pairs[0]
        const inputKey = first?.inputKey ?? exploreInputRef.current
        const targetKey = first?.targetKey ?? exploreTargetRef.current
        if (inputKey && targetKey) {
          setExploreInputKey(inputKey)
          setExploreTargetKey(targetKey)
          exploreInputRef.current = inputKey
          exploreTargetRef.current = targetKey
          const plotId = nextRequestId('plot')
          plotRequestId.current = plotId
          dispatchLifecycle({ type: 'plotStarted' })
          worker.postMessage({
            type: 'relationship-plot',
            requestId: plotId,
            inputKey,
            targetKey,
          } satisfies AnalysisWorkerRequest)
        }
        return
      }
      if (response.type === 'relationship-plot' && response.requestId === plotRequestId.current) {
        setRelationshipPlot(response.result)
        dispatchLifecycle({ type: 'plotSucceeded' })
        return
      }
      if (response.type === 'stale' && response.requestId === staleRequestId.current) {
        dispatchLifecycle({ type: 'staleResolved', stale: response.stale })
        return
      }
      if (response.type === 'error') {
        if (response.requestId === staleRequestId.current) {
          dispatchLifecycle({ type: 'staleFailed', message: response.message })
          return
        }
        if (
          [loadRequestId.current, relationshipsRequestId.current, plotRequestId.current].includes(response.requestId)
        ) {
          dispatchLifecycle({ type: 'failed', message: response.message, clearProgress: true })
        }
      }
    }
    worker.onerror = () => {
      dispatchLifecycle({ type: 'failed', message: 'Analysis Worker를 실행하지 못했습니다.', clearProgress: false })
    }
    worker.postMessage({ type: 'load-context', requestId, experimentId } satisfies AnalysisWorkerRequest)
    return () => {
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
    }
  }, [dataReadable, experimentId, lifecycle.generation, nextRequestId])

  const lifecycleView = selectAnalysisLifecycle(lifecycle)
  const { busy } = lifecycleView
  useEffect(() => {
    const check = () => {
      if (!profile || busy || !workerRef.current) return
      const requestId = nextRequestId('stale')
      staleRequestId.current = requestId
      dispatchLifecycle({ type: 'staleCheckStarted' })
      workerRef.current.postMessage({ type: 'check-stale', requestId } satisfies AnalysisWorkerRequest)
    }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [busy, nextRequestId, profile])

  const requestRelationshipPlot = useCallback(
    (inputKey: string, targetKey: string) => {
      if (!workerRef.current || !inputKey || !targetKey) return
      setExploreInputKey(inputKey)
      setExploreTargetKey(targetKey)
      exploreInputRef.current = inputKey
      exploreTargetRef.current = targetKey
      setRelationshipPlot(null)
      dispatchLifecycle({ type: 'plotStarted' })
      const requestId = nextRequestId('plot')
      plotRequestId.current = requestId
      workerRef.current.postMessage({
        type: 'relationship-plot',
        requestId,
        inputKey,
        targetKey,
      } satisfies AnalysisWorkerRequest)
    },
    [nextRequestId],
  )

  const restartWorker = useCallback(() => dispatchLifecycle({ type: 'generationAdvanced' }), [])

  return {
    ...lifecycleView,
    exploreInputKey,
    exploreTargetKey,
    profile,
    relationshipOffset,
    relationshipPlot,
    relationships,
    requestRelationshipPlot,
    restartWorker,
    setRelationshipOffset,
  }
}
