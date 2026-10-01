import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { PredictionAssetController } from './assetManagement'

export function usePredictionAssets(
  scope: string | null,
  experimentId: number | null,
  onActivity?: RuntimeActivityCallback,
) {
  const manager = useMemo(() => new PredictionAssetController(scope, experimentId), [scope, experimentId])
  const previous = useRef(manager)
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot)
  useEffect(() => {
    if (previous.current.scope !== manager.scope) void previous.current.disconnectOwner()
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
