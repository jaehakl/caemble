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
    if (!scope) return
    const active = state.operations.some(
      (operation) =>
        operation.training?.cleanupPending ||
        !['succeeded', 'completed', 'cancelled', 'failed', 'interrupted', 'superseded'].includes(operation.state),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const schedule = () => {
      if (timer) clearTimeout(timer)
      if (active && !stopped)
        timer = setTimeout(() => void manager.refresh().finally(schedule), document.hidden ? 5_000 : 2_000)
    }
    const reconnect = () => {
      void manager.refresh()
    }
    schedule()
    document.addEventListener('visibilitychange', reconnect)
    window.addEventListener('online', reconnect)
    window.addEventListener('focus', reconnect)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', reconnect)
      window.removeEventListener('online', reconnect)
      window.removeEventListener('focus', reconnect)
    }
  }, [manager, scope, state.operations])
  return manager
}
