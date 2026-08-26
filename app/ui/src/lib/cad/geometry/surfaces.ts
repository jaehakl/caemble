import { geometries, measurements, modifiers } from '@jscad/modeling'
import { CadModelError } from '../model/core'
import type { EvaluatedSurface } from '../evaluation/types'

type CadGeom3 = ReturnType<typeof geometries.geom3.create>

const cadGeneralize = modifiers.generalize as unknown as (
  options: { triangulate: boolean },
  geometry: CadGeom3,
) => CadGeom3

export function deriveGeometrySurfaces(geometry: unknown) {
  if (!geometries.geom3.isA(geometry)) {
    throw new CadModelError('CAD scene parts must be valid geom3 solids.')
  }

  const snapEpsilon = Math.max(measurements.measureEpsilon(geometry) * 1e-6, Number.EPSILON)
  const snappedPolygons = geometries.geom3.toPolygons(geometry as CadGeom3).map((polygon) => {
    const snapped = geometries.poly3.create(
      polygon.vertices.map((vertex) => [
        Math.round(vertex[0] / snapEpsilon) * snapEpsilon,
        Math.round(vertex[1] / snapEpsilon) * snapEpsilon,
        Math.round(vertex[2] / snapEpsilon) * snapEpsilon,
      ]),
    )
    if (polygon.color) snapped.color = polygon.color
    return snapped
  })
  const normalizedGeometry = cadGeneralize({ triangulate: true }, geometries.geom3.create(snappedPolygons))
  const polygons = geometries.geom3.toPolygons(normalizedGeometry)
  const normals = polygons.map((polygon) => geometries.poly3.plane(polygon))
  const adjacentPolygons = polygons.map(() => new Set<number>())
  const edgeOwners = new Map<string, number[]>()
  const minimumDot = Math.cos(Math.PI / 4) - 1e-10

  polygons.forEach((polygon, polygonIndex) => {
    polygon.vertices.forEach((vertex, vertexIndex) => {
      const nextVertex = polygon.vertices[(vertexIndex + 1) % polygon.vertices.length]
      const edge = [String(vertex), String(nextVertex)].sort().join('/')
      const owners = edgeOwners.get(edge) ?? []

      owners.forEach((owner) => {
        const dot =
          normals[polygonIndex][0] * normals[owner][0] +
          normals[polygonIndex][1] * normals[owner][1] +
          normals[polygonIndex][2] * normals[owner][2]
        if (dot >= minimumDot) {
          adjacentPolygons[polygonIndex].add(owner)
          adjacentPolygons[owner].add(polygonIndex)
        }
      })

      owners.push(polygonIndex)
      edgeOwners.set(edge, owners)
    })
  })

  const surfaces: EvaluatedSurface[] = []
  const visitedPolygons = new Set<number>()
  polygons.forEach((_polygon, polygonIndex) => {
    if (visitedPolygons.has(polygonIndex)) return

    const pending = [polygonIndex]
    const polygonIndices: number[] = []
    visitedPolygons.add(polygonIndex)
    while (pending.length > 0) {
      const current = pending.pop()!
      polygonIndices.push(current)
      adjacentPolygons[current].forEach((neighbor) => {
        if (visitedPolygons.has(neighbor)) return
        visitedPolygons.add(neighbor)
        pending.push(neighbor)
      })
    }

    polygonIndices.sort((first, second) => first - second)
    const surfaceIndex = surfaces.length
    surfaces.push({ surfaceIndex, label: `Derived surface ${surfaceIndex}`, polygonIndices })
  })

  return { geometry: normalizedGeometry, surfaces }
}

export function validateSurfacePartition(geometry: unknown, surfaces: readonly EvaluatedSurface[]) {
  if (!geometries.geom3.isA(geometry)) {
    throw new CadModelError('CAD scene parts must be valid geom3 solids.')
  }

  const polygonCount = geometries.geom3.toPolygons(geometry as CadGeom3).length
  const owners = Array.from({ length: polygonCount }, () => 0)
  surfaces.forEach((surface) => {
    if (!Number.isSafeInteger(surface.surfaceIndex) || surface.surfaceIndex < 0) {
      throw new CadModelError('CAD surface indices must be non-negative safe integers.')
    }
    if (!surface.label.trim()) throw new CadModelError('CAD surface labels must not be empty.')
    surface.polygonIndices.forEach((polygonIndex) => {
      if (!Number.isSafeInteger(polygonIndex) || polygonIndex < 0 || polygonIndex >= polygonCount) {
        throw new CadModelError(`CAD surface ${surface.surfaceIndex} contains an invalid polygon index.`)
      }
      owners[polygonIndex] += 1
    })
  })

  if (owners.some((ownerCount) => ownerCount !== 1)) {
    throw new CadModelError('CAD surfaces must partition every geometry polygon exactly once.')
  }
}
