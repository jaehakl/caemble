import type { CadSceneGroup, CadSceneMaterial, CadSceneSurface, CadSceneTreeNode } from '../evaluation/types'
import type { UcumUnit } from '../model/units'


export type SerializableCadMesh = Readonly<{
  kind: 'mesh'
  positions: Float64Array
  polygonOffsets: Uint32Array
}>

export type SerializableCadScenePart = Readonly<{
  id: string
  geometry: SerializableCadMesh
  materialRole: string
  material?: CadSceneMaterial
  surfaces: CadSceneSurface[]
}>

export type SerializableCadScene = Readonly<{
  sceneHash: string
  lengthUnit: UcumUnit
  parts: SerializableCadScenePart[]
  tree: CadSceneTreeNode
  geometryGroups: CadSceneGroup[]
  surfaceGroups: CadSceneGroup[]
}>

export function cadSceneHash(scene: Omit<SerializableCadScene, 'sceneHash'>) {
  const states = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5]
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      lengthUnit: scene.lengthUnit,
      tree: scene.tree,
      geometryGroups: scene.geometryGroups,
      surfaceGroups: scene.surfaceGroups,
      parts: scene.parts.map((part) => ({
        id: part.id,
        materialRole: part.materialRole,
        material: part.material,
        surfaces: part.surfaces.map((surface) =>
          surface.polygonIndices instanceof Uint32Array
            ? {
                id: surface.id,
                surfaceIndex: surface.surfaceIndex,
                label: surface.label,
                polygonIndices: { kind: 'uint32', length: surface.polygonIndices.length },
              }
            : surface,
        ),
        positionLength: part.geometry.positions.length,
        polygonOffsetLength: part.geometry.polygonOffsets.length,
      })),
    }),
  )
  const chunks = [
    metadata,
    ...scene.parts.flatMap((part) => [
      new Uint8Array(
        part.geometry.positions.buffer,
        part.geometry.positions.byteOffset,
        part.geometry.positions.byteLength,
      ),
      new Uint8Array(
        part.geometry.polygonOffsets.buffer,
        part.geometry.polygonOffsets.byteOffset,
        part.geometry.polygonOffsets.byteLength,
      ),
      ...part.surfaces.flatMap((surface) =>
        surface.polygonIndices instanceof Uint32Array
          ? [
              new Uint8Array(
                surface.polygonIndices.buffer,
                surface.polygonIndices.byteOffset,
                surface.polygonIndices.byteLength,
              ),
            ]
          : [],
      ),
    ]),
  ]
  chunks.forEach((chunk) => {
    const length = chunk.byteLength
    for (let stateIndex = 0; stateIndex < states.length; stateIndex += 1) {
      states[stateIndex] = Math.imul(states[stateIndex] ^ (length >>> 0), 0x01000193 + stateIndex * 2) >>> 0
    }
    for (let byteIndex = 0; byteIndex < chunk.length; byteIndex += 1) {
      for (let stateIndex = 0; stateIndex < states.length; stateIndex += 1) {
        states[stateIndex] = Math.imul(states[stateIndex] ^ chunk[byteIndex], 0x01000193 + stateIndex * 2) >>> 0
      }
    }
  })
  return states.map((state) => state.toString(16).padStart(8, '0')).join('')
}

export function cadSnapshotTransferables(scene: SerializableCadScene) {
  return [
    ...new Set(
      scene.parts.flatMap((part) => [
        part.geometry.positions.buffer,
        part.geometry.polygonOffsets.buffer,
        ...part.surfaces.flatMap((surface) =>
          surface.polygonIndices instanceof Uint32Array ? [surface.polygonIndices.buffer] : [],
        ),
      ]),
    ),
  ]
}
