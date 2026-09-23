import { initialViewerDisplay } from './viewerDisplay'
import type { createComparisonCamera } from './comparisonCamera'
import { type ViewerDefaults, durableViewerSettings } from '@/contracts/viewerDefaults'
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
import { ViewerControlTarget, ViewerToolHosts, type ViewerControlPlacement } from './ViewerTools'

/** Owned by the comparison workspace, independently of data and renderer lifetimes. */
export function createComparisonSettings(initial?: Record<string, unknown>) {
  const values = new Map<string, unknown>(Object.entries(durableViewerSettings(Object.entries(initial ?? {}))))
  const seeded = new Set(values.keys())
  const listeners = new Set<() => void>()
  return {
    values,
    seeded,
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

export function createViewerSettings(defaults?: ViewerDefaults | null) {
  const display = initialViewerDisplay(defaults)
  const migrated = { ...defaults?.settings }
  for (const [key, value] of Object.entries(defaults?.settings ?? {})) {
    const separator = key.lastIndexOf(':')
    const item = key.slice(0, separator),
      setting = key.slice(separator + 1)
    if (item === '@workspace' || item.endsWith('@output-space') || item.endsWith('@output-chart')) continue
    if (!setting.startsWith('box.') && !setting.startsWith('tensor.')) continue
    migrated[`${item}@output-chart:${setting}`] ??= value
    if (
      setting.startsWith('box.') &&
      !['box.kind', 'box.axes', 'box.animation', 'box.playing', 'box.frameIndex'].includes(setting)
    )
      migrated[`${item}@output-space:${setting}`] ??= value
  }
  const sharedBoxGridSettings = [
    'box.wavelength',
    'box.representation',
    'box.component',
    'box.reduce',
    'box.animation',
    'box.timeSeconds',
    'box.frameIndex',
    'box.durationSeconds',
    'box.playing',
    'box.repeat',
    'box.speed',
    'box.fixed',
  ]
  for (const [key, value] of Object.entries(migrated)) {
    const marker = '@output-space:'
    const position = key.indexOf(marker)
    if (position < 0 || !sharedBoxGridSettings.includes(key.slice(position + marker.length))) continue
    migrated[`${key.slice(0, position)}@output-chart:${key.slice(position + marker.length)}`] ??= value
    delete migrated[key]
  }
  return createComparisonSettings({
    ...migrated,
    '@workspace:selectedOutput': display.output,
    '@workspace:geometryMode': display.geometry,
    '@workspace:visualizations': display.visualizations,
  })
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

/** Observe a control's setting without seeding its defaults before the control mounts. */
export function useViewerSettingValue<T>(name: string, fallback: T, item: string): T {
  const comparison = useViewerComparison()
  const persistent = useContext(ViewerPersistenceContext)
  const settings = (comparison ?? persistent)?.settings
  const key = `${item}:${name}`
  const subscribe = useCallback((listener: () => void) => settings?.subscribe(listener) ?? (() => {}), [settings])
  const snapshot = useCallback(
    () => (settings?.values.has(key) ? (settings.values.get(key) as T) : fallback),
    [settings, key, fallback],
  )
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Standalone viewers keep local state; comparisons share result settings by item and toolbar settings by workspace. */
export function useViewerSetting<T>(
  name: string,
  initial: T | (() => T),
  scope: 'item' | 'workspace' = 'item',
  compatible?: (value: T) => boolean,
  item?: string,
): [T, Dispatch<SetStateAction<T>>] {
  const comparison = useViewerComparison()
  const persistent = useContext(ViewerPersistenceContext)
  const [local, setLocal] = useState(initial)
  const owner = comparison ?? persistent
  const settings = owner?.settings
  const key = `${scope === 'workspace' ? '@workspace' : (item ?? owner?.item ?? '')}:${name}`
  const subscribe = useCallback((listener: () => void) => settings?.subscribe(listener) ?? (() => {}), [settings])
  const stored = settings?.values.get(key) as T
  const validateDefault = !comparison || comparison.controlsOwner
  const invalidDefault = Boolean(validateDefault && settings?.seeded.has(key) && compatible && !compatible(stored))
  const snapshot = useCallback(
    () => (!invalidDefault && settings?.values.has(key) ? (settings.values.get(key) as T) : local),
    [settings, key, local, invalidDefault],
  )
  const value = useSyncExternalStore(subscribe, snapshot, snapshot)
  useLayoutEffect(() => {
    if (settings && (!settings.values.has(key) || invalidDefault)) settings.set(key, local)
    if (validateDefault) settings?.seeded.delete(key)
  }, [settings, key, local, invalidDefault, validateDefault])
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

export function ViewerControls({
  children,
  placement = 'side',
}: {
  children: ReactNode
  placement?: ViewerControlPlacement
}) {
  const comparison = useViewerComparison()
  const hosts = useContext(ViewerToolHosts)
  const target = useContext(ViewerControlTarget)
  if (comparison && !comparison.controlsOwner && placement !== 'presentation') return null
  if (target && placement === 'side') return target.host ? createPortal(children, target.host) : null
  if (comparison?.controlsHost && placement === 'side') return createPortal(children, comparison.controlsHost)
  if (hosts) return hosts[placement] ? createPortal(children, hosts[placement]) : null
  if (!comparison) return children
  return comparison.controlsOwner && comparison.controlsHost ? createPortal(children, comparison.controlsHost) : null
}

/** Both result calculations must finish before the single playback driver advances. */
export function useComparisonBusy(busy: boolean) {
  const comparison = useViewerComparison()
  const settings = comparison?.settings
  const key = `busy:${comparison?.side}:${comparison?.item}`
  useLayoutEffect(() => {
    settings?.set(key, busy)
    return () => settings?.set(key, false)
  }, [settings, key, busy])
  const subscribe = useCallback((listener: () => void) => settings?.subscribe(listener) ?? (() => {}), [settings])
  const snapshot = useCallback(
    () =>
      Boolean(
        settings?.values.get(`busy:preview:${comparison?.item}`) ||
        settings?.values.get(`busy:actual:${comparison?.item}`),
      ),
    [settings, comparison?.item],
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
