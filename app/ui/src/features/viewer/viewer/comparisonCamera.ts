import type { ComponentProps } from 'react'
import type { ViewerToolbar } from './ViewerToolbar'

export type CameraPose = {
  position: number[]
  target: number[]
  up: number[]
  fov: number
}
export type ComparisonRenderer = {
  apply: (pose: CameraPose) => void
  bounds: () => readonly [readonly number[], readonly number[]] | null
  viewport: () => { width: number; height: number } | undefined
  toolbar: ComponentProps<typeof ViewerToolbar>
}

/** Camera lifetime follows the workspace, not the selected result renderer. */
export function createComparisonCamera(initial?: CameraPose | null) {
  let pose: CameraPose | null = initial ? structuredClone(initial) : null
  const renderers = new Map<object, ComparisonRenderer>()
  let snapshot: ComparisonRenderer[] = []
  const listeners = new Set<() => void>()
  const notify = () => {
    snapshot = [...renderers.values()]
    listeners.forEach((listener) => listener())
  }
  return {
    get current() {
      return pose
    },
    publish(source: object, camera: CameraPose) {
      const next = structuredClone(camera)
      pose = next
      renderers.forEach((renderer, token) => {
        if (token !== source) renderer.apply(structuredClone(next))
      })
    },
    register(token: object, renderer: ComparisonRenderer) {
      const fresh = !renderers.has(token)
      renderers.set(token, renderer)
      if (fresh && pose) renderer.apply(structuredClone(pose))
      notify()
    },
    unregister(token: object) {
      renderers.delete(token)
      notify()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    fitExtent() {
      const bounds = [...renderers.values()].flatMap((renderer) => {
        const box = renderer.bounds()
        return box ? [box] : []
      })
      const aspects = [...renderers.values()].flatMap((renderer) => {
        const viewport = renderer.viewport()
        return viewport && viewport.width > 0 && viewport.height > 0 ? [viewport.width / viewport.height] : []
      })
      if (!bounds.length || !aspects.length) return null
      return {
        bounds: [
          [0, 1, 2].map((axis) => Math.min(...bounds.map((box) => box[0][axis]))),
          [0, 1, 2].map((axis) => Math.max(...bounds.map((box) => box[1][axis]))),
        ] as [number[], number[]],
        width: Math.min(...aspects),
        height: 1,
      }
    },
  }
}
