import { useState } from 'react'
import type { CadViewerSelectionQuery } from './model'

/** Transient selection shared by a Viewer workspace and its input adapters. */
export function createViewerSelection() {
  let query: CadViewerSelectionQuery | null = null
  const listeners = new Set<() => void>()
  const select = (next: CadViewerSelectionQuery | null) => {
    if (
      query === next ||
      (query &&
        next &&
        query.kind === next.kind &&
        query.match === next.match &&
        query.origin === next.origin &&
        query.value === next.value &&
        query.scope.source === next.scope.source &&
        (query.scope.source !== 'task' ||
          (next.scope.source === 'task' && query.scope.taskName === next.scope.taskName)))
    )
      return
    query = next
    listeners.forEach((listener) => listener())
  }
  return {
    getSnapshot: () => query,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    select,
    selectFromCode(next: CadViewerSelectionQuery | null) {
      if (next) select({ ...next, origin: 'code' })
      else if (query?.origin === 'code') select(null)
    },
  }
}

export type ViewerSelectionStore = ReturnType<typeof createViewerSelection>

/** Keep selection through result changes, but start fresh for a different workspace session. */
export function useViewerSelectionStore(session: number) {
  const [current, setCurrent] = useState(() => ({ session, store: createViewerSelection() }))
  if (current.session !== session) {
    const next = { session, store: createViewerSelection() }
    setCurrent(next)
    return next.store
  }
  return current.store
}
