import type { CadScenePart, CadSceneTreeNode } from '@/lib/cad/evaluation/types'
import type { UcumUnit } from '@/lib/cad/model'

export type CadViewerSource = 'experiment' | 'task'

export type JscadViewerLayer = Readonly<{
  source: CadViewerSource
  taskName?: string
  lengthUnit: UcumUnit
  parts: CadScenePart[]
  tree: CadSceneTreeNode
  sceneHash?: string | null
}>

export type CadViewerPickMode = 'off' | 'geometry' | 'surface'
export type CadViewerSourceLookupStatus = 'checking' | 'available' | 'missing'

export type CadViewerLayerScope =
  Readonly<{ source: 'experiment' }> | Readonly<{ source: 'task'; taskName: string }> | Readonly<{ source: 'visible' }>

export type CadViewerSelectionQuery = Readonly<{
  kind: 'geometry' | 'surface'
  match: 'exact' | 'local'
  origin: 'code' | 'viewer'
  scope: CadViewerLayerScope
  value: string
}>

export type CadViewerSelectionMatch = Readonly<{
  geometryId: string
  source: CadViewerSource
  surfaceId?: string
  taskName?: string
}>

export type CadViewerPickingCamera = Readonly<{
  aspect: number
  fov: number
  position: readonly [number, number, number]
  target: readonly [number, number, number]
  up: readonly [number, number, number]
}>
