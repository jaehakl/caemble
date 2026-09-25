import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react'
import { emitRuntimeActivity, type RuntimeActivityCallback } from '@/features/runtime-console/types'

type Diagnostic = { message: string; level: 'warning' | 'error'; result?: string }
export const ViewerDiagnosticResult = createContext<string | undefined>(undefined)
export const ViewerDiagnosticsContext = createContext<((diagnostic: Diagnostic) => () => void) | null>(null)

/** One reporting boundary for both the scene and chart of a Viewer. */
export function ViewerDiagnostics({ onActivity, children }: { onActivity?: RuntimeActivityCallback; children: ReactNode }) {
  const callback = useRef(onActivity)
  callback.current = onActivity
  const active = useRef(new Map<string, number>())
  const report = useCallback((diagnostic: Diagnostic) => {
    const key = JSON.stringify(diagnostic)
    const count = active.current.get(key)
    active.current.set(key, (count ?? 0) + 1)
    if (count === undefined) {
      emitRuntimeActivity(callback.current, {
        source: 'viewer',
        level: diagnostic.level,
        phase: 'viewer.display',
        message: diagnostic.result ? `${diagnostic.result}: ${diagnostic.message}` : diagnostic.message,
        details: diagnostic.result ? { result: diagnostic.result } : undefined,
      })
    }
    return () => {
      active.current.set(key, (active.current.get(key) ?? 1) - 1)
      // Preserve deduplication across effect replay and scene/chart handoffs in the same commit.
      queueMicrotask(() => {
        if (active.current.get(key) === 0) active.current.delete(key)
      })
    }
  }, [])
  return <ViewerDiagnosticsContext.Provider value={report}>{children}</ViewerDiagnosticsContext.Provider>
}

export function ViewerDiagnostic({ message, level = 'error', result, children }: {
  message?: string | null
  level?: Diagnostic['level']
  result?: string
  /** Shared data-detail views retain their original presentation outside a Viewer. */
  children?: ReactNode
}) {
  const report = useContext(ViewerDiagnosticsContext)
  const inheritedResult = useContext(ViewerDiagnosticResult)
  const name = result ?? inheritedResult
  useEffect(() => {
    if (message && report) return report({ message, level, result: name })
  }, [report, message, level, name])
  return report ? null : children
}
