import { createContext, useCallback, useContext, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react'
import type { MeshRenderData } from './meshFields'
import type { HeatmapRenderData } from './structuredField'
import type { PolylineBundle } from '@/lib/cad/model'
import { ViewerComparisonContext, ViewerPersistenceContext } from './comparisonSettings'

export type SceneLayer = {
  mesh?: MeshRenderData
  heatmap?: HeatmapRenderData
  lines?: readonly PolylineBundle[]
  deformed?: boolean
}
export const SceneLayersContext = createContext<(name: string, layer: SceneLayer | null) => void>(() => {})

/** Result controllers publish render data; the owning Viewer draws one shared canvas. */
export function ViewerSceneLayer({ name, mesh, heatmap, lines, deformed }: SceneLayer & { name: string }) {
  const publish = useContext(SceneLayersContext)
  useLayoutEffect(() => {
    publish(name, { mesh, heatmap, lines, deformed })
  }, [publish, name, mesh, heatmap, lines, deformed])
  useLayoutEffect(() => () => publish(name, null), [publish, name])
  return null
}

export function ViewerResultScope({
  name,
  available,
  children,
}: {
  name: string
  available: boolean
  children: ReactNode
}) {
  const persistent = useContext(ViewerPersistenceContext)
  const comparison = useContext(ViewerComparisonContext)
  const settings = comparison?.settings
  const side = comparison?.side
  useLayoutEffect(() => {
    settings?.set(`available:${name}:${side}`, available)
    return () => settings?.set(`available:${name}:${side}`, false)
  }, [settings, name, side, available])
  const subscribe = useCallback((listener: () => void) => settings?.subscribe(listener) ?? (() => {}), [settings])
  const snapshot = useCallback(() => Boolean(settings?.values.get(`available:${name}:actual`)), [settings, name])
  const actualAvailable = useSyncExternalStore(subscribe, snapshot, snapshot)
  const controlsOwner = actualAvailable ? side === 'actual' : available ? side === 'preview' : comparison?.controlsOwner
  return (
    <ViewerPersistenceContext.Provider value={persistent ? { ...persistent, item: name } : null}>
      <ViewerComparisonContext.Provider
        value={comparison ? { ...comparison, item: name, controlsOwner: Boolean(controlsOwner) } : null}
      >
        {children}
      </ViewerComparisonContext.Provider>
    </ViewerPersistenceContext.Provider>
  )
}

export function combineMeshes(layers: readonly SceneLayer[]): MeshRenderData | undefined {
  const meshes = layers.flatMap((layer) => (layer.mesh ? [layer.mesh] : []))
  if (!meshes.length) return undefined
  return {
    geometries: meshes.flatMap((mesh) => mesh.geometries),
    bounds: {
      min: [0, 1, 2].map((axis) => Math.min(...meshes.map((mesh) => mesh.bounds.min[axis]))),
      max: [0, 1, 2].map((axis) => Math.max(...meshes.map((mesh) => mesh.bounds.max[axis]))),
    },
  }
}
