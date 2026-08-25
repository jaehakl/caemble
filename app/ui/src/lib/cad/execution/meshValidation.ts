import type { CadSceneGroup, CadSceneMaterial, CadSceneSurface, CadSceneTreeNode } from '../evaluation/types'
import { CadModelError } from '../model/errors'
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
                name: surface.name,
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

export function assertSerializableCadScene(value: unknown): asserts value is SerializableCadScene {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Snapshot scene must be an object.')
  }
  const scene = value as Partial<SerializableCadScene>
  const allowedSceneKeys = ['sceneHash', 'lengthUnit', 'parts', 'tree', 'geometryGroups', 'surfaceGroups']
  if (Object.keys(scene).some((key) => !allowedSceneKeys.includes(key))) {
    throw new CadModelError('Snapshot scene contains an unknown property.')
  }
  if (typeof scene.sceneHash !== 'string' || !/^[0-9a-f]{64}$/.test(scene.sceneHash)) {
    throw new CadModelError('Snapshot scene hash is invalid.')
  }
  if (typeof scene.lengthUnit !== 'string' || !Array.isArray(scene.parts)) {
    throw new CadModelError('Snapshot scene metadata is invalid.')
  }
  if (!Array.isArray(scene.geometryGroups) || !Array.isArray(scene.surfaceGroups)) {
    throw new CadModelError('Snapshot scene groups are invalid.')
  }
  if (typeof scene.tree !== 'object' || scene.tree === null || Array.isArray(scene.tree)) {
    throw new CadModelError('Snapshot scene tree is invalid.')
  }
  scene.parts.forEach((part, partIndex) => {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) {
      throw new CadModelError(`Snapshot scene part ${partIndex} is invalid.`)
    }
    const allowedPartKeys = ['id', 'geometry', 'materialRole', 'material', 'surfaces']
    if (Object.keys(part).some((key) => !allowedPartKeys.includes(key))) {
      throw new CadModelError(`Snapshot scene part ${partIndex} contains an unknown property.`)
    }
    if (
      typeof part.id !== 'string' ||
      typeof part.materialRole !== 'string' ||
      !part.materialRole.trim() ||
      part.materialRole !== part.materialRole.trim() ||
      !Array.isArray(part.surfaces)
    ) {
      throw new CadModelError(`Snapshot scene part ${partIndex} metadata is invalid.`)
    }
    const mesh = part.geometry
    if (
      typeof mesh !== 'object' ||
      mesh === null ||
      Array.isArray(mesh) ||
      mesh.kind !== 'mesh' ||
      !(mesh.positions instanceof Float64Array) ||
      !(mesh.polygonOffsets instanceof Uint32Array) ||
      Object.keys(mesh).some((key) => !['kind', 'positions', 'polygonOffsets'].includes(key))
    ) {
      throw new CadModelError(`Snapshot scene part ${part.id} mesh is invalid.`)
    }
    if (mesh.positions.length % 3 !== 0 || mesh.polygonOffsets.length < 2) {
      throw new CadModelError(`Snapshot scene part ${part.id} mesh shape is invalid.`)
    }
    if (mesh.positions.some((coordinate) => !Number.isFinite(coordinate))) {
      throw new CadModelError(`Snapshot scene part ${part.id} mesh contains a non-finite coordinate.`)
    }
    const vertexCount = mesh.positions.length / 3
    if (mesh.polygonOffsets[0] !== 0 || mesh.polygonOffsets[mesh.polygonOffsets.length - 1] !== vertexCount) {
      throw new CadModelError(`Snapshot scene part ${part.id} polygon offsets are invalid.`)
    }
    for (let offsetIndex = 1; offsetIndex < mesh.polygonOffsets.length; offsetIndex += 1) {
      if (mesh.polygonOffsets[offsetIndex] - mesh.polygonOffsets[offsetIndex - 1] < 3) {
        throw new CadModelError(`Snapshot scene part ${part.id} contains an invalid polygon.`)
      }
    }
    part.surfaces.forEach((surface) => {
      if (
        typeof surface !== 'object' ||
        surface === null ||
        Array.isArray(surface) ||
        typeof surface.id !== 'string' ||
        typeof surface.name !== 'string' ||
        (!Array.isArray(surface.polygonIndices) && !(surface.polygonIndices instanceof Uint32Array)) ||
        Object.keys(surface).some((key) => !['id', 'name', 'polygonIndices'].includes(key)) ||
        surface.polygonIndices.some(
          (index) => !Number.isSafeInteger(index) || index < 0 || index >= mesh.polygonOffsets.length - 1,
        )
      ) {
        throw new CadModelError(`Snapshot scene part ${part.id} contains an invalid surface.`)
      }
    })
  })
  if (cadSceneHash(scene as SerializableCadScene) !== scene.sceneHash) {
    throw new CadModelError('Snapshot scene content does not match its hash.')
  }
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
