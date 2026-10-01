import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { predictionAssetView, disconnectPredictionOwner } from './assetManagement'

export function usePredictionAssets(
  scope: string | null,
  experimentId: number | null | 'all',
  onActivity?: RuntimeActivityCallback,
) {
  const manager = useMemo(() => predictionAssetView(scope, experimentId), [scope, experimentId])
  const previous = useRef(manager)
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  useEffect(() => {
    if (previous.current.scope && previous.current.scope !== manager.scope)
      void disconnectPredictionOwner(previous.current.scope)
    previous.current = manager
    manager.onActivity = onActivity
  }, [manager, onActivity])
  useEffect(() => {
    manager.active = true
    void manager.refresh()
    return () => {
      manager.active = false
    }
  }, [manager])
  useEffect(() => {
    if (
      !scope ||
      !state.operations.some(
        (operation) => !['succeeded', 'completed', 'cancelled', 'failed', 'interrupted'].includes(operation.state),
      )
    )
      return
    const timer = setInterval(() => {
      void manager.refresh()
    }, 5_000)
    return () => clearInterval(timer)
  }, [manager, scope, state.operations])
  return manager
}
