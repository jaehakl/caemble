import { geometries } from '@jscad/modeling'
import type { CadScenePart } from '@/lib/cad'
import { scenePartColor, unassignedGeometryColor } from './materialColor'

type RenderColor = [number, number, number, number]
type RenderPolygon = Record<string, unknown> & { color?: number[]; vertices?: number[][] }
type RenderSolid = Record<string, unknown> & { polygons: RenderPolygon[]; transforms?: unknown }

export type RenderPart = Readonly<{
  color: RenderColor
  edgeColor: RenderColor
  geometry: unknown
  selectionGeometry?: unknown
  wireframe: boolean
}>

export type RenderPartSelection = Readonly<{
  geometry: boolean
  polygonIndices: ReadonlySet<number>
}>

export type WireframeGeometry = Readonly<{
  colors: RenderColor[]
  indices: number[]
  isTransparent: boolean
  normals: number[][]
  positions: number[][]
  transforms: unknown
  type: '3d'
}>

const maximumWireframeVertices = Math.floor(65_535 / 2) * 2
export function colorFromHex(hex: string): RenderColor {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
    1,
  ]
}

const wireframeColor = colorFromHex(unassignedGeometryColor)
export const viewerSelectionColor: RenderColor = [0.96, 0.47, 0.08, 1]
const xrayEdgeBrightness = 0.65
const xrayOpacity = 0

export function geometryWithSelectedPolygons(
  value: unknown,
  selectedPolygonIndices: ReadonlySet<number> | null,
  selectedOnly = false,
) {
  if (typeof value !== 'object' || value === null || !('polygons' in value)) return value
  const geometry = value as RenderSolid
  if (!Array.isArray(geometry.polygons)) return value
  const clone = geometries.geom3.clone(value as Parameters<typeof geometries.geom3.clone>[0]) as unknown as RenderSolid
  clone.polygons = geometry.polygons.flatMap((polygon, polygonIndex) => {
    const selected = selectedPolygonIndices === null || selectedPolygonIndices.has(polygonIndex)
    if (selectedOnly && !selected) return []
    return [selected ? { ...polygon, color: [...viewerSelectionColor] } : polygon]
  })
  return clone
}

export function createRenderParts(
  parts: CadScenePart[],
  selections: ReadonlyMap<string, RenderPartSelection> = new Map(),
  xrayEnabled = false,
): RenderPart[] {
  return parts.map((part) => {
    const color = scenePartColor(part)
    const selection = selections.get(part.id)
    const wireframe = color === undefined
    const selectedSurface = selection && !selection.geometry && selection.polygonIndices.size > 0
    const geometry = selection?.geometry ? geometryWithSelectedPolygons(part.geometry, null) : part.geometry
    const baseColor = color === undefined ? wireframeColor : colorFromHex(color)
    const edgeColor: RenderColor =
      !wireframe && xrayEnabled
        ? [baseColor[0] * xrayEdgeBrightness, baseColor[1] * xrayEdgeBrightness, baseColor[2] * xrayEdgeBrightness, 1]
        : baseColor
    let renderColor = baseColor
    if (selection?.geometry) renderColor = viewerSelectionColor
    else if (!wireframe && xrayEnabled) {
      renderColor = [renderColor[0], renderColor[1], renderColor[2], xrayOpacity]
    }
    return {
      geometry,
      color: renderColor,
      edgeColor,
      ...(selectedSurface
        ? { selectionGeometry: geometryWithSelectedPolygons(part.geometry, selection.polygonIndices, true) }
        : {}),
      wireframe,
    }
  })
}

export function createWireframeGeometries(part: RenderPart, includeFilled = false): WireframeGeometry[] {
  if (
    (!part.wireframe && !includeFilled) ||
    typeof part.geometry !== 'object' ||
    part.geometry === null ||
    !('polygons' in part.geometry)
  )
    return []

  const geometry = part.geometry as RenderSolid
  if (!Array.isArray(geometry.polygons) || geometry.transforms === undefined) return []

  const edges = new Map<string, { first: number[]; second: number[] }>()
  geometry.polygons.forEach((polygon) => {
    if (!Array.isArray(polygon.vertices) || polygon.vertices.length < 2) return

    polygon.vertices.forEach((first, vertexIndex) => {
      const second = polygon.vertices![(vertexIndex + 1) % polygon.vertices!.length]
      if (!Array.isArray(first) || !Array.isArray(second) || first.length < 3 || second.length < 3) return

      const firstKey = first.join(',')
      const secondKey = second.join(',')
      const key = firstKey < secondKey ? `${firstKey}/${secondKey}` : `${secondKey}/${firstKey}`
      if (edges.has(key)) return
      edges.set(key, {
        first: [first[0], first[1], first[2]],
        second: [second[0], second[1], second[2]],
      })
    })
  })

  const edgeList = [...edges.values()]
  const maximumEdgesPerGeometry = maximumWireframeVertices / 2
  const geometries: WireframeGeometry[] = []
  for (let start = 0; start < edgeList.length; start += maximumEdgesPerGeometry) {
    const positions: number[][] = []
    const colors: RenderColor[] = []
    edgeList.slice(start, start + maximumEdgesPerGeometry).forEach((edge) => {
      positions.push(edge.first, edge.second)
      colors.push(part.edgeColor, part.edgeColor)
    })
    geometries.push({
      colors,
      indices: positions.map((_, index) => index),
      isTransparent: false,
      normals: positions.map(() => [0, 0, 1]),
      positions,
      transforms: geometry.transforms,
      type: '3d',
    })
  }
  return geometries
}
