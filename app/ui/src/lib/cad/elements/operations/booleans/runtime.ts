import { booleans, geometries, measurements, modifiers, transforms } from '@jscad/modeling'
import { CadModelError } from '../../../model/core'
import type { CadElementManifest, EvaluatedPart, GeometryOperationDefinition } from '../../../evaluation/types'
import { intersectManifest, subtractManifest, unionManifest } from './definition'

type CadGeom3 = ReturnType<typeof geometries.geom3.create>

const cadIntersect = booleans.intersect as (...geometries: unknown[]) => CadGeom3
const cadGeneralize = modifiers.generalize as unknown as (
  options: { simplify?: boolean; triangulate?: boolean },
  geometry: CadGeom3,
) => CadGeom3
const cadRetessellate = modifiers.retessellate as unknown as (geometry: CadGeom3) => CadGeom3
const cadSubtract = booleans.subtract as (...geometries: unknown[]) => CadGeom3
const cadUnion = booleans.union as (...geometries: unknown[]) => CadGeom3

function matchingMaterial(parts: EvaluatedPart[], operation: string) {
  if (parts.length === 0) throw new CadModelError(`<${operation}> did not receive any geometry.`)
  const material = parts[0].material
  if (parts.some((part) => part.material !== material)) {
    throw new CadModelError(`<${operation}> cannot combine Geometry with different Materials.`)
  }
  return material
}

function createBooleanDefinition<Tag extends 'union' | 'subtract' | 'intersect'>(manifest: CadElementManifest<Tag>) {
  return {
    kind: 'operation',
    tag: manifest.tag,
    manifest,
    surfacePolicy: 'derive',
    evaluate(node, context) {
      const minimum = manifest.tag === 'union' ? 1 : 2
      if (node.children.length < minimum) {
        throw new CadModelError(
          `<${manifest.tag}> requires at least ${minimum} child geometr${minimum === 1 ? 'y' : 'ies'}.`,
        )
      }

      const childParts = node.children.map((child) => context.evaluate(child, context.inheritedMaterials))
      if (manifest.tag === 'subtract') {
        if (childParts.some((parts) => parts.length === 0)) {
          throw new CadModelError('<subtract> did not receive any geometry.')
        }

        const snapEpsilon = Math.max(...childParts[0].map((part) => measurements.measureEpsilon(part.geometry))) * 2
        const decomposedParts = childParts.map((parts) =>
          parts.map((part) => {
            const polygons = geometries.geom3.toPolygons(part.geometry as CadGeom3)
            const adjacentPolygons = polygons.map(() => new Set<number>())
            const edgeOwners = new Map<string, number[]>()

            polygons.forEach((polygon, polygonIndex) => {
              polygon.vertices.forEach((vertex, vertexIndex) => {
                const nextVertex = polygon.vertices[(vertexIndex + 1) % polygon.vertices.length]
                const edge = [String(vertex), String(nextVertex)].sort().join('/')
                const owners = edgeOwners.get(edge)
                if (owners) {
                  owners.forEach((owner) => {
                    adjacentPolygons[polygonIndex].add(owner)
                    adjacentPolygons[owner].add(polygonIndex)
                  })
                  owners.push(polygonIndex)
                } else {
                  edgeOwners.set(edge, [polygonIndex])
                }
              })
            })

            const connectedSurfaces: (typeof polygons)[] = []
            const visitedPolygons = new Set<number>()
            polygons.forEach((_, polygonIndex) => {
              if (visitedPolygons.has(polygonIndex)) return

              const pending = [polygonIndex]
              const surface: typeof polygons = []
              visitedPolygons.add(polygonIndex)
              while (pending.length > 0) {
                const current = pending.pop()!
                surface.push(polygons[current])
                adjacentPolygons[current].forEach((neighbor) => {
                  if (!visitedPolygons.has(neighbor)) {
                    visitedPolygons.add(neighbor)
                    pending.push(neighbor)
                  }
                })
              }
              connectedSurfaces.push(surface)
            })

            const solidSurfaces: CadGeom3[] = []
            const voidSurfaces: CadGeom3[] = []
            connectedSurfaces.forEach((surface) => {
              const geometry = geometries.geom3.create(surface)
              if (measurements.measureVolume(geometry) >= 0) {
                solidSurfaces.push(geometry)
              } else {
                voidSurfaces.push(geometries.geom3.create(surface.map(geometries.poly3.invert)))
              }
            })
            return { solidSurfaces, voidSurfaces }
          }),
        )
        const cutterSurfaces = decomposedParts.slice(1).flat()

        return childParts[0].map((part, partIndex) => {
          const { solidSurfaces, voidSurfaces } = decomposedParts[0][partIndex]
          const solid = solidSurfaces.length === 1 ? solidSurfaces[0] : cadUnion(...solidSurfaces)
          let subtracted: CadGeom3
          if (cutterSurfaces.every((cutter) => cutter.voidSurfaces.length === 0)) {
            subtracted = cadSubtract(
              cadGeneralize({ simplify: true }, solid),
              ...cutterSurfaces.flatMap((cutter) => cutter.solidSurfaces),
              ...voidSurfaces,
            )
          } else {
            let booleanApplied = voidSurfaces.length > 0
            subtracted =
              voidSurfaces.length === 0 ? solid : cadSubtract(cadGeneralize({ simplify: true }, solid), ...voidSurfaces)
            cutterSurfaces.forEach((cutter) => {
              if (cutter.voidSurfaces.length === 0) {
                subtracted = cadSubtract(subtracted, ...cutter.solidSurfaces)
                booleanApplied = true
                return
              }

              const cutterSolid =
                cutter.solidSurfaces.length === 1 ? cutter.solidSurfaces[0] : cadUnion(...cutter.solidSurfaces)
              const cutterVoid =
                cutter.voidSurfaces.length === 1 ? cutter.voidSurfaces[0] : cadUnion(...cutter.voidSurfaces)
              const currentFaces = geometries.geom3
                .toPolygons(subtracted)
                .map((polygon) => polygon.vertices.map(String).sort().join('/'))
                .sort()
              const cutterFaces = geometries.geom3
                .toPolygons(cutterSolid)
                .map((polygon) => polygon.vertices.map(String).sort().join('/'))
                .sort()
              if (
                currentFaces.length === cutterFaces.length &&
                currentFaces.every((face, index) => face === cutterFaces[index])
              ) {
                subtracted = cutterVoid
                return
              }

              const outside = cadSubtract(subtracted, cutterSolid)
              const inside = cadIntersect(subtracted, cutterVoid)
              const outsideIsEmpty = geometries.geom3.toPolygons(outside).length === 0
              const insideIsEmpty = geometries.geom3.toPolygons(inside).length === 0
              subtracted = outsideIsEmpty ? inside : insideIsEmpty ? outside : cadUnion(outside, inside)
              booleanApplied = true
            })
            if (!booleanApplied) {
              return {
                geometry: subtracted,
                ...(part.material === undefined ? {} : { material: part.material }),
              }
            }
          }
          const snappedPolygons = geometries.geom3
            .toPolygons(subtracted)
            .map((polygon) => {
              const snappedVertices = polygon.vertices.map(
                (vertex) =>
                  [
                    Math.round(vertex[0] / snapEpsilon) * snapEpsilon,
                    Math.round(vertex[1] / snapEpsilon) * snapEpsilon,
                    Math.round(vertex[2] / snapEpsilon) * snapEpsilon,
                  ] as [number, number, number],
              )
              const vertices = snappedVertices.filter(
                (vertex, index) => String(vertex) !== String(snappedVertices[(index + 1) % snappedVertices.length]),
              )
              return geometries.poly3.create(vertices)
            })
            .filter(
              (polygon) =>
                polygon.vertices.length >= 3 &&
                Math.abs(geometries.poly3.measureArea(polygon)) > snapEpsilon * snapEpsilon,
            )
          const generalized = transforms.scale(
            [1000, 1000, 1000],
            cadGeneralize(
              { triangulate: true },
              transforms.scale(
                [0.001, 0.001, 0.001],
                cadRetessellate(geometries.geom3.create(snappedPolygons)),
              ) as CadGeom3,
            ),
          ) as CadGeom3
          const finalEpsilon = snapEpsilon * 1e-6
          const finalPolygons = geometries.geom3
            .toPolygons(generalized)
            .map((polygon) => {
              const snappedVertices = polygon.vertices.map(
                (vertex) =>
                  [
                    Math.round(vertex[0] / finalEpsilon) * finalEpsilon,
                    Math.round(vertex[1] / finalEpsilon) * finalEpsilon,
                    Math.round(vertex[2] / finalEpsilon) * finalEpsilon,
                  ] as [number, number, number],
              )
              const vertices = snappedVertices.filter(
                (vertex, index) => String(vertex) !== String(snappedVertices[(index + 1) % snappedVertices.length]),
              )
              return geometries.poly3.create(vertices)
            })
            .filter((polygon) => geometries.poly3.measureArea(polygon) > 0)
          return {
            geometry: geometries.geom3.create(finalPolygons),
            ...(part.material === undefined ? {} : { material: part.material }),
          }
        })
      }

      const allParts = childParts.flat()
      const material = matchingMaterial(allParts, manifest.tag)
      if (manifest.tag === 'union') {
        return [
          {
            geometry: cadUnion(...allParts.map((part) => part.geometry)),
            ...(material === undefined ? {} : { material }),
          },
        ]
      }

      const childGeometries = childParts.map((parts) => {
        matchingMaterial(parts, manifest.tag)
        return parts.length === 1 ? parts[0].geometry : cadUnion(...parts.map((part) => part.geometry))
      })
      return [
        {
          geometry: cadIntersect(...childGeometries),
          ...(material === undefined ? {} : { material }),
        },
      ]
    },
  } satisfies GeometryOperationDefinition<Tag>
}

export const unionDefinition = createBooleanDefinition(unionManifest)
export const subtractDefinition = createBooleanDefinition(subtractManifest)
export const intersectDefinition = createBooleanDefinition(intersectManifest)
