import { geometries } from '@jscad/modeling'
import type { CadScenePart, CadSceneTreeNode } from '@/lib/cad'
import type { CadViewerSource, JscadViewerLayer } from './sourceLayers'

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
  position: readonly number[]
  target: readonly number[]
  up: readonly number[]
}>

type PickPolygon = Readonly<{ vertices: readonly (readonly number[])[] }>
type Vec3 = readonly [number, number, number]

type CadViewerPickPart = Readonly<{
  bounds: readonly [Vec3, Vec3]
  part: CadScenePart
  polygons: readonly PickPolygon[]
  source: CadViewerSource
  surfaceByPolygon: ReadonlyMap<number, string>
  taskName?: string
}>

function layerMatchesScope(layer: JscadViewerLayer, scope: CadViewerLayerScope) {
  if (scope.source === 'visible') return true
  if (scope.source === 'experiment') return layer.source === 'experiment'
  return layer.source === 'task' && layer.taskName === scope.taskName
}

function visitSceneTree(node: CadSceneTreeNode, visit: (node: CadSceneTreeNode) => void) {
  visit(node)
  node.children.forEach((child) => visitSceneTree(child, visit))
}

function treeGeometryIds(tree: CadSceneTreeNode, query: CadViewerSelectionQuery) {
  const geometryIds = new Set<string>()
  visitSceneTree(tree, (node) => {
    const matches =
      query.match === 'exact'
        ? node.globalId === query.value || node.groupId === query.value || node.geometryId === query.value
        : node.globalId?.split('.').slice(-1)[0] === query.value
    if (!matches) return
    if (node.geometryId) geometryIds.add(node.geometryId)
    node.geometryIds?.forEach((geometryId) => geometryIds.add(geometryId))
  })
  return geometryIds
}

export function resolveCadViewerSelection(
  layers: readonly JscadViewerLayer[],
  query: CadViewerSelectionQuery | null,
): CadViewerSelectionMatch[] {
  if (!query) return []
  const matches: CadViewerSelectionMatch[] = []
  layers
    .filter((layer) => layerMatchesScope(layer, query.scope))
    .forEach((layer) => {
      if (query.kind === 'surface') {
        layer.parts.forEach((part) => {
          const surface = part.surfaces.find((candidate) => candidate.id === query.value)
          if (surface) {
            matches.push({
              geometryId: part.id,
              source: layer.source,
              surfaceId: surface.id,
              ...(layer.taskName ? { taskName: layer.taskName } : {}),
            })
          }
        })
        return
      }

      const geometryIds = treeGeometryIds(layer.tree, query)
      if (query.match === 'exact' && layer.parts.some((part) => part.id === query.value)) geometryIds.add(query.value)
      layer.parts.forEach((part) => {
        if (!geometryIds.has(part.id)) return
        matches.push({
          geometryId: part.id,
          source: layer.source,
          ...(layer.taskName ? { taskName: layer.taskName } : {}),
        })
      })
    })

  return matches.sort((left, right) => {
    const leftLayer = `${left.source}:${left.taskName ?? ''}`
    const rightLayer = `${right.source}:${right.taskName ?? ''}`
    return leftLayer.localeCompare(rightLayer) || left.geometryId.localeCompare(right.geometryId)
  })
}

export function createCadViewerPickParts(layers: readonly JscadViewerLayer[]): CadViewerPickPart[] {
  return layers.flatMap((layer) =>
    layer.parts.flatMap((part) => {
      const geometry = geometries.geom3.clone(part.geometry as Parameters<typeof geometries.geom3.clone>[0])
      const polygons = geometries.geom3.toPolygons(geometry) as unknown as readonly PickPolygon[]
      const points = polygons.flatMap((polygon) => polygon.vertices)
      if (points.length === 0) return []
      const minimum: [number, number, number] = [
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      ]
      const maximum: [number, number, number] = [
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]
      points.forEach((point) => {
        for (let axis = 0; axis < 3; axis += 1) {
          minimum[axis] = Math.min(minimum[axis], point[axis])
          maximum[axis] = Math.max(maximum[axis], point[axis])
        }
      })
      const surfaceByPolygon = new Map<number, string>()
      part.surfaces.forEach((surface) => {
        surface.polygonIndices.forEach((polygonIndex) => surfaceByPolygon.set(polygonIndex, surface.id))
      })
      return [
        {
          bounds: [minimum, maximum],
          part,
          polygons,
          source: layer.source,
          surfaceByPolygon,
          ...(layer.taskName ? { taskName: layer.taskName } : {}),
        },
      ]
    }),
  )
}

function subtract(left: readonly number[], right: readonly number[]): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

function cross(left: readonly number[], right: readonly number[]): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ]
}

function dot(left: readonly number[], right: readonly number[]) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

function normalize(value: readonly number[]): Vec3 | null {
  const length = Math.hypot(value[0], value[1], value[2])
  return Number.isFinite(length) && length > 1e-12 ? [value[0] / length, value[1] / length, value[2] / length] : null
}

function pointerRay(
  camera: CadViewerPickingCamera,
  point: Readonly<{ height: number; width: number; x: number; y: number }>,
) {
  const forward = normalize(subtract(camera.target, camera.position))
  if (!forward) return null
  const right = normalize(cross(forward, camera.up))
  if (!right) return null
  const screenUp = normalize(cross(right, forward))
  if (!screenUp) return null
  const tangent = Math.tan(camera.fov / 2)
  const x = (point.x / point.width) * 2 - 1
  const y = 1 - (point.y / point.height) * 2
  const direction = normalize([
    forward[0] + right[0] * x * camera.aspect * tangent + screenUp[0] * y * tangent,
    forward[1] + right[1] * x * camera.aspect * tangent + screenUp[1] * y * tangent,
    forward[2] + right[2] * x * camera.aspect * tangent + screenUp[2] * y * tangent,
  ])
  return direction ? { direction, origin: camera.position } : null
}

function rayIntersectsBounds(origin: readonly number[], direction: readonly number[], bounds: readonly [Vec3, Vec3]) {
  let near = 0
  let far = Number.POSITIVE_INFINITY
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(direction[axis]) < 1e-12) {
      if (origin[axis] < bounds[0][axis] || origin[axis] > bounds[1][axis]) return false
      continue
    }
    const first = (bounds[0][axis] - origin[axis]) / direction[axis]
    const second = (bounds[1][axis] - origin[axis]) / direction[axis]
    near = Math.max(near, Math.min(first, second))
    far = Math.min(far, Math.max(first, second))
    if (far < near) return false
  }
  return far >= 0
}

function rayTriangleDistance(
  origin: readonly number[],
  direction: readonly number[],
  first: readonly number[],
  second: readonly number[],
  third: readonly number[],
) {
  const firstEdge = subtract(second, first)
  const secondEdge = subtract(third, first)
  const determinantVector = cross(direction, secondEdge)
  const determinant = dot(firstEdge, determinantVector)
  if (Math.abs(determinant) < 1e-10) return null
  const inverse = 1 / determinant
  const fromFirst = subtract(origin, first)
  const u = dot(fromFirst, determinantVector) * inverse
  if (u < 0 || u > 1) return null
  const q = cross(fromFirst, firstEdge)
  const v = dot(direction, q) * inverse
  if (v < 0 || u + v > 1) return null
  const distance = dot(secondEdge, q) * inverse
  return distance > 1e-8 ? distance : null
}

export function pickCadViewerTargets(
  parts: readonly CadViewerPickPart[],
  camera: CadViewerPickingCamera,
  point: Readonly<{ height: number; width: number; x: number; y: number }>,
  mode: Exclude<CadViewerPickMode, 'off'>,
): CadViewerSelectionMatch[] {
  const ray = pointerRay(camera, point)
  if (!ray) return []
  const hits: Array<Readonly<{ distance: number; part: CadViewerPickPart; polygonIndex: number }>> = []
  parts.forEach((part) => {
    if (!rayIntersectsBounds(ray.origin, ray.direction, part.bounds)) return
    part.polygons.forEach((polygon, polygonIndex) => {
      let polygonDistance: number | null = null
      for (let vertexIndex = 2; vertexIndex < polygon.vertices.length; vertexIndex += 1) {
        const distance = rayTriangleDistance(
          ray.origin,
          ray.direction,
          polygon.vertices[0],
          polygon.vertices[vertexIndex - 1],
          polygon.vertices[vertexIndex],
        )
        if (distance !== null && (polygonDistance === null || distance < polygonDistance)) polygonDistance = distance
      }
      if (polygonDistance !== null) hits.push({ distance: polygonDistance, part, polygonIndex })
    })
  })
  hits.sort((left, right) => left.distance - right.distance)

  const geometryOrder: string[] = []
  const matches = new Map<string, CadViewerSelectionMatch | null>()
  hits.forEach((hit) => {
    const key = `${hit.part.source}:${hit.part.taskName ?? ''}:${hit.part.part.id}`
    if (!matches.has(key)) {
      geometryOrder.push(key)
      matches.set(key, null)
    }
    if (matches.get(key)) return

    const surfaceId = hit.part.surfaceByPolygon.get(hit.polygonIndex)
    if (mode === 'surface' && !surfaceId) return
    matches.set(key, {
      geometryId: hit.part.part.id,
      source: hit.part.source,
      ...(mode === 'surface' ? { surfaceId } : {}),
      ...(hit.part.taskName ? { taskName: hit.part.taskName } : {}),
    })
  })
  return geometryOrder.flatMap((key) => {
    const match = matches.get(key)
    return match ? [match] : []
  })
}
