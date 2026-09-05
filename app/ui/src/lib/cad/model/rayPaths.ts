import { createDataTensorAccessor } from './dataTensor'
import type { DataSchema, RecordedData, RecordedDataTensor } from './descriptor'
import type { RecordedDataSchemaTree, ResolvedDataSchema, ResolvedDataSchemaGroup } from '../simulation/types'

export const RAY_PATH_EVENT_NAMES = Object.freeze([
  'reflection',
  'refraction',
  'scattering',
  'surface-scatter',
  'bulk-scatter',
  'detector',
  'absorption',
  'escape',
  'power-cutoff',
  'max-bounces',
  'roulette',
  'diffraction',
] as const)
export type RayPathEventName = (typeof RAY_PATH_EVENT_NAMES)[number]
export type RayPathBundle = Readonly<{
  id: 'rayPaths'
  pathCount: number
  segmentCount: number
  vertices: Float32Array
  pathOffsets: Uint32Array
  segmentPower: Float32Array
  pathWavelength: Float32Array
  segmentEvent: Uint8Array
}>

export function isRayPathRecordedDataName(name: string): boolean {
  return name === 'rayPaths' || name.startsWith('rayPaths.')
}

function float32(bytes: Uint8Array) {
  const aligned = bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0 ? bytes : bytes.slice()
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / Float32Array.BYTES_PER_ELEMENT)
}

function uint32(bytes: Uint8Array) {
  const aligned = bytes.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0 ? bytes : bytes.slice()
  return new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / Uint32Array.BYTES_PER_ELEMENT)
}

export function parseRayPathBundles(
  schemas: RecordedDataSchemaTree,
  recordedData: RecordedData | null | undefined,
): readonly RayPathBundle[] {
  const schema = schemas.rayPaths as ResolvedDataSchemaGroup | undefined
  const value = recordedData?.rayPaths as Readonly<Record<string, RecordedDataTensor>> | undefined
  if (!schema || !value) return Object.freeze([])
  const accessor = (name: string) =>
    createDataTensorAccessor(schema[name] as ResolvedDataSchema as DataSchema, value[name], `rayPaths.${name}`)
  const vertices = float32(accessor('vertices').rawBytes())
  const pathOffsets = uint32(accessor('pathOffsets').rawBytes())
  const segmentPower = float32(accessor('segmentPower').rawBytes())
  const pathWavelength = float32(accessor('pathWavelength').rawBytes())
  const segmentEvent = new Uint8Array(accessor('segmentEvent').rawBytes())
  const pathCount = pathOffsets.length - 1
  return Object.freeze([
    Object.freeze({
      id: 'rayPaths' as const,
      pathCount,
      segmentCount: vertices.length / 3 - pathCount,
      vertices,
      pathOffsets,
      segmentPower,
      pathWavelength,
      segmentEvent,
    }),
  ])
}
