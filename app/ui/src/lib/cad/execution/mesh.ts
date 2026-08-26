import { geometries } from '@jscad/modeling'
import type { CadScene } from '../evaluation/types'
import {
  cadSceneHash,
  type SerializableCadMesh,
  type SerializableCadScene,
} from './meshSerialization'

export { cadSceneHash, cadSnapshotTransferables } from './meshSerialization'
export type { SerializableCadMesh, SerializableCadScene, SerializableCadScenePart } from './meshSerialization'

const runtimeMeshCache = new WeakMap<SerializableCadMesh, unknown>()
const runtimeSceneCache = new Map<string, CadScene>()

export function serializeCadScene(scene: CadScene): SerializableCadScene {
  const parts = scene.parts.map((part) => {
    const polygons = geometries.geom3.toPolygons(part.geometry as Parameters<typeof geometries.geom3.toPolygons>[0])
    const vertexCount = polygons.reduce((count, polygon) => count + polygon.vertices.length, 0)
    const positions = new Float64Array(vertexCount * 3)
    const polygonOffsets = new Uint32Array(polygons.length + 1)
    let vertexOffset = 0
    polygons.forEach((polygon, polygonIndex) => {
      polygonOffsets[polygonIndex] = vertexOffset
      polygon.vertices.forEach((vertex) => {
        positions[vertexOffset * 3] = vertex[0]
        positions[vertexOffset * 3 + 1] = vertex[1]
        positions[vertexOffset * 3 + 2] = vertex[2]
        vertexOffset += 1
      })
    })
    polygonOffsets[polygons.length] = vertexOffset
    return {
      id: part.id,
      geometry: { kind: 'mesh' as const, positions, polygonOffsets },
      materialRole: part.materialRole,
      ...(part.material ? { material: part.material } : {}),
      surfaces: part.surfaces,
    }
  })
  const serializable = {
    lengthUnit: scene.lengthUnit,
    parts,
    tree: scene.tree,
    geometryGroups: scene.geometryGroups,
    surfaceGroups: scene.surfaceGroups,
  }
  return Object.freeze({ ...serializable, sceneHash: cadSceneHash(serializable) })
}

export function deserializeCadScene(scene: SerializableCadScene): CadScene {
  const cached = runtimeSceneCache.get(scene.sceneHash)
  if (cached) return cached
  const parts = scene.parts.map((part) => {
    let geometry = runtimeMeshCache.get(part.geometry)
    if (!geometry) {
      const polygons = []
      for (let polygonIndex = 0; polygonIndex < part.geometry.polygonOffsets.length - 1; polygonIndex += 1) {
        const vertices: [number, number, number][] = []
        const start = part.geometry.polygonOffsets[polygonIndex]
        const end = part.geometry.polygonOffsets[polygonIndex + 1]
        for (let vertexIndex = start; vertexIndex < end; vertexIndex += 1) {
          vertices.push([
            part.geometry.positions[vertexIndex * 3],
            part.geometry.positions[vertexIndex * 3 + 1],
            part.geometry.positions[vertexIndex * 3 + 2],
          ])
        }
        polygons.push(geometries.poly3.create(vertices))
      }
      geometry = geometries.geom3.create(polygons)
      runtimeMeshCache.set(part.geometry, geometry)
    }
    return {
      id: part.id,
      geometry,
      materialRole: part.materialRole,
      ...(part.material ? { material: part.material } : {}),
      surfaces: part.surfaces,
    }
  })
  const runtimeScene: CadScene = {
    lengthUnit: scene.lengthUnit,
    parts,
    tree: scene.tree,
    geometryGroups: scene.geometryGroups,
    surfaceGroups: scene.surfaceGroups,
  }
  runtimeSceneCache.set(scene.sceneHash, runtimeScene)
  if (runtimeSceneCache.size > 32) runtimeSceneCache.delete(runtimeSceneCache.keys().next().value!)
  return runtimeScene
}
