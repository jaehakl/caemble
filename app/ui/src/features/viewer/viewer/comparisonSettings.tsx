import type { createComparisonCamera } from './comparisonCamera'
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'

/** Owned by the comparison workspace, independently of data and renderer lifetimes. */
export function createComparisonSettings() {
  const values = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  return {
    values,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(key: string, value: unknown) {
      if (values.has(key) && Object.is(values.get(key), value)) return
      values.set(key, value)
      listeners.forEach((listener) => listener())
    },
  }
}

export type ComparisonSettings = ReturnType<typeof createComparisonSettings>
export type ComparisonCamera = ReturnType<typeof createComparisonCamera>
export type ViewerComparison = {
  settings: ComparisonSettings
  item: string
  side: 'preview' | 'actual'
  controlsHost: HTMLElement | null
  controlsOwner: boolean
  suspended: boolean
  camera: ComparisonCamera
}
/** A standalone Viewer can retain settings and camera while its data renderer changes. */
export type ViewerPersistence = Pick<ViewerComparison, 'settings' | 'item' | 'camera'>
export const ViewerPersistenceContext = createContext<ViewerPersistence | null>(null)
export function useViewerCamera() {
  const comparison = useContext(ViewerComparisonContext)
  const persistent = useContext(ViewerPersistenceContext)
  return comparison?.camera ?? persistent?.camera
}

export const ViewerComparisonContext = createContext<ViewerComparison | null>(null)

export function useViewerComparison() {
  return useContext(ViewerComparisonContext)
}

/** Standalone viewers keep local state; comparisons share result settings by item and toolbar settings by workspace. */
export function useViewerSetting<T>(
  name: string,
  initial: T | (() => T),
  scope: 'item' | 'workspace' = 'item',
): [T, Dispatch<SetStateAction<T>>] {
  const comparison = useViewerComparison()
  const persistent = useContext(ViewerPersistenceContext)
  const [local, setLocal] = useState(initial)
  const owner = comparison ?? persistent
  const settings = owner?.settings
  const key = `${scope === 'workspace' ? '@workspace' : (owner?.item ?? '')}:${name}`
  const subscribe = useCallback((listener: () => void) => settings?.subscribe(listener) ?? (() => {}), [settings])
  const snapshot = useCallback(
    () => (settings?.values.has(key) ? (settings.values.get(key) as T) : local),
    [settings, key, local],
  )
  const value = useSyncExternalStore(subscribe, snapshot, snapshot)
  useLayoutEffect(() => {
    if (settings && !settings.values.has(key)) settings.set(key, local)
  }, [settings, key, local])
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      if (!settings) {
        setLocal(next)
        return
      }
      const previous = settings.values.has(key) ? (settings.values.get(key) as T) : local
      settings.set(key, typeof next === 'function' ? (next as (value: T) => T)(previous) : next)
    },
    [settings, key, local],
  )
  return settings ? [value, setValue] : [local, setLocal]
}

export function ViewerControls({ children }: { children: ReactNode }) {
  const comparison = useViewerComparison()
  if (!comparison) return children
  return comparison.controlsOwner && comparison.controlsHost ? createPortal(children, comparison.controlsHost) : null
}

/** Both result calculations must finish before the single playback driver advances. */
export function useComparisonBusy(busy: boolean) {
  const comparison = useViewerComparison()
  const settings = comparison?.settings
  const key = `busy:${comparison?.side}`
  useLayoutEffect(() => {
    settings?.set(key, busy)
    return () => settings?.set(key, false)
  }, [settings, key, busy])
  const subscribe = useCallback((listener: () => void) => settings?.subscribe(listener) ?? (() => {}), [settings])
  const snapshot = useCallback(
    () => Boolean(settings?.values.get('busy:preview') || settings?.values.get('busy:actual')),
    [settings],
  )
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Both panes use the same physical clock, even when their frequency samples differ. */
export function useComparisonFrequencies(minimum: number, maximum: number) {
  const comparison = useViewerComparison()
  const settings = comparison?.settings
  const prefix = `${comparison?.item ?? ''}:frequencies:`
  const key = `${prefix}${comparison?.side}`
  const local = JSON.stringify([minimum, maximum])
  useLayoutEffect(() => {
    settings?.set(key, local)
    return () => settings?.set(key, undefined)
  }, [settings, key, local])
  const subscribe = useCallback((listener: () => void) => settings?.subscribe(listener) ?? (() => {}), [settings])
  const snapshot = useCallback(() => {
    if (!settings) return local
    const ranges = ['preview', 'actual'].map((side) => {
      const value = settings.values.get(`${prefix}${side}`)
      return typeof value === 'string' ? (JSON.parse(value) as [number, number]) : [0, 0]
    })
    const positive = ranges.map(([min]) => min).filter((min) => min > 0)
    return JSON.stringify([positive.length ? Math.min(...positive) : 0, Math.max(...ranges.map(([, max]) => max))])
  }, [settings, prefix, local])
  return JSON.parse(useSyncExternalStore(subscribe, snapshot, snapshot)) as [number, number]
}
