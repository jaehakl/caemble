import { CadModelError } from './errors'
import { createDataTensorAccessor } from './dataTensor'
import type { DataSchema, RecordedData, RecordedDataRule, RecordedDataTensor } from './descriptor'

const memberNames = ['vertices', 'path-offsets', 'segment-power', 'path-wavelength', 'segment-event'] as const
const rayPathPrefix = '@caemble/ray-paths@1/'
const rayPathNamePattern =
  /^@caemble\/ray-paths@1\/([a-z][a-z0-9-]{0,31})\/(vertices|path-offsets|segment-power|path-wavelength|segment-event)$/u

// Stable uint8 wire enum: the array index is the stored segment-event code.
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
] as const)
export type RayPathEventName = (typeof RAY_PATH_EVENT_NAMES)[number]

type RayPathMemberName = (typeof memberNames)[number]
type RayPathSchema = DataSchema & Readonly<{ tensorOrder?: number }>

export type RayPathBundle = Readonly<{
  id: string
  pathCount: number
  segmentCount: number
  vertices: Float32Array
  pathOffsets: Uint32Array
  segmentPower: Float32Array
  pathWavelength: Float32Array
  segmentEvent: Uint8Array
}>

export function isRayPathRecordedDataName(name: string): boolean {
  return rayPathNamePattern.test(name)
}

function assertSchema(name: RayPathMemberName, schema: RayPathSchema): void {
  const expected = {
    vertices: { dtype: 'float32', quantityKind: 'Length', unit: 'm', axes: 2 },
    'path-offsets': { dtype: 'uint32', axes: 1 },
    'segment-power': { dtype: 'float32', quantityKind: 'optics.RadiantFlux', unit: 'W', axes: 1 },
    'path-wavelength': { dtype: 'float32', quantityKind: 'Wavelength', unit: 'm', axes: 1 },
    'segment-event': { dtype: 'uint8', axes: 1 },
  }[name]
  if (
    schema.dtype !== expected.dtype ||
    (schema.tensorOrder !== undefined && schema.tensorOrder !== 0) ||
    schema.quantityKind !== expected.quantityKind ||
    schema.unit !== expected.unit ||
    schema.axes?.length !== expected.axes
  ) {
    throw new CadModelError(`Ray-path ${name} DataSchema does not match @caemble/ray-paths@1.`)
  }
  if (schema.axes?.[0]?.length !== undefined || schema.axes?.[0]?.ticks !== undefined) {
    throw new CadModelError(`Ray-path ${name} first axis must be dynamic.`)
  }
  if (
    name === 'vertices' &&
    (schema.axes?.[1]?.length !== 3 ||
      (schema.axes[1].ticks !== undefined && JSON.stringify(schema.axes[1].ticks) !== '["x","y","z"]'))
  ) {
    throw new CadModelError('Ray-path vertices coordinate axis must have length 3 and x/y/z ticks when specified.')
  }
}

function typedFloat32(bytes: Uint8Array): Float32Array {
  const aligned = bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0 ? bytes : bytes.slice()
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / Float32Array.BYTES_PER_ELEMENT)
}

function typedUint32(bytes: Uint8Array): Uint32Array {
  const aligned = bytes.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0 ? bytes : bytes.slice()
  return new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / Uint32Array.BYTES_PER_ELEMENT)
}

function parseBundle(
  id: string,
  members: ReadonlyMap<RayPathMemberName, Readonly<{ schema: RayPathSchema; value: RecordedDataTensor }>>,
): RayPathBundle {
  const accessors = new Map(
    memberNames.map((name) => {
      const member = members.get(name)
      if (!member) throw new CadModelError(`Ray-path bundle ${id} is missing ${name}.`)
      assertSchema(name, member.schema)
      const storageSchema = {
        dtype: member.schema.dtype,
        axes: member.schema.axes,
      } as DataSchema
      return [name, createDataTensorAccessor(storageSchema, member.value, `${rayPathPrefix}${id}/${name}`)] as const
    }),
  )
  const verticesAccessor = accessors.get('vertices')!
  const offsetsAccessor = accessors.get('path-offsets')!
  const powerAccessor = accessors.get('segment-power')!
  const wavelengthAccessor = accessors.get('path-wavelength')!
  const eventAccessor = accessors.get('segment-event')!
  if (
    verticesAccessor.shape.length !== 2 ||
    verticesAccessor.shape[1] !== 3 ||
    offsetsAccessor.shape.length !== 1 ||
    powerAccessor.shape.length !== 1 ||
    wavelengthAccessor.shape.length !== 1 ||
    eventAccessor.shape.length !== 1
  ) {
    throw new CadModelError(`Ray-path bundle ${id} member shapes are invalid.`)
  }

  const vertices = typedFloat32(verticesAccessor.rawBytes())
  const pathOffsets = typedUint32(offsetsAccessor.rawBytes())
  const segmentPower = typedFloat32(powerAccessor.rawBytes())
  const pathWavelength = typedFloat32(wavelengthAccessor.rawBytes())
  const segmentEvent = new Uint8Array(eventAccessor.rawBytes())
  const vertexCount = verticesAccessor.shape[0]
  const pathCount = pathOffsets.length - 1
  if (pathCount < 0 || pathCount > 65_536) {
    throw new CadModelError(`Ray-path bundle ${id} exceeds 65,536 paths.`)
  }
  if (pathOffsets[0] !== 0 || pathOffsets[pathOffsets.length - 1] !== vertexCount) {
    throw new CadModelError(`Ray-path bundle ${id} offsets must start at 0 and end at the vertex count.`)
  }
  for (let path = 0; path < pathCount; path += 1) {
    const segmentCount = pathOffsets[path + 1] - pathOffsets[path]
    if (segmentCount < 2 || segmentCount > 33) {
      throw new CadModelError(`Ray-path bundle ${id} paths must contain 1 to 32 segments.`)
    }
  }
  const segmentCount = vertexCount - pathCount
  if (
    segmentPower.length !== segmentCount ||
    segmentEvent.length !== segmentCount ||
    pathWavelength.length !== pathCount
  ) {
    throw new CadModelError(`Ray-path bundle ${id} companion tensor lengths are inconsistent.`)
  }
  for (const power of segmentPower) {
    if (!Number.isFinite(power) || power < 0)
      throw new CadModelError(`Ray-path bundle ${id} power must be non-negative.`)
  }
  for (const wavelength of pathWavelength) {
    if (!Number.isFinite(wavelength) || wavelength <= 0) {
      throw new CadModelError(`Ray-path bundle ${id} wavelength must be positive.`)
    }
  }
  for (const event of segmentEvent) {
    if (event >= RAY_PATH_EVENT_NAMES.length)
      throw new CadModelError(`Ray-path bundle ${id} contains an unknown event.`)
  }
  return Object.freeze({
    id,
    pathCount,
    segmentCount,
    vertices,
    pathOffsets,
    segmentPower,
    pathWavelength,
    segmentEvent,
  })
}

export function parseRayPathBundles(
  rules: readonly RecordedDataRule[],
  recordedData: RecordedData | null | undefined,
): readonly RayPathBundle[] {
  const schemas = new Map<string, RayPathSchema>()
  rules.forEach((rule) => {
    if (!rule.label.startsWith('@caemble/ray-paths@')) return
    if (!isRayPathRecordedDataName(rule.label)) {
      throw new CadModelError(`Unsupported ray-path RecordedData name: ${rule.label}.`)
    }
    if (schemas.has(rule.label)) throw new CadModelError(`Duplicate ray-path RecordedData rule: ${rule.label}.`)
    schemas.set(rule.label, rule.result)
  })
  const declaredByBundle = new Map<string, Set<RayPathMemberName>>()
  schemas.forEach((_schema, name) => {
    const match = rayPathNamePattern.exec(name)!
    const declared = declaredByBundle.get(match[1]) ?? new Set<RayPathMemberName>()
    declared.add(match[2] as RayPathMemberName)
    declaredByBundle.set(match[1], declared)
  })
  declaredByBundle.forEach((members, id) => {
    if (members.size !== memberNames.length)
      throw new CadModelError(`Ray-path bundle ${id} must declare all five members.`)
  })
  if (!recordedData) return Object.freeze([])

  const valuesByBundle = new Map<
    string,
    Map<RayPathMemberName, Readonly<{ schema: RayPathSchema; value: RecordedDataTensor }>>
  >()
  Object.entries(recordedData).forEach(([name, value]) => {
    if (!name.startsWith('@caemble/ray-paths@')) return
    const match = rayPathNamePattern.exec(name)
    if (!match) throw new CadModelError(`Unsupported ray-path RecordedData name: ${name}.`)
    const schema = schemas.get(name)
    if (!schema) throw new CadModelError(`Ray-path RecordedData ${name} has no declared schema.`)
    const values = valuesByBundle.get(match[1]) ?? new Map()
    values.set(match[2] as RayPathMemberName, { schema, value })
    valuesByBundle.set(match[1], values)
  })
  return Object.freeze(
    [...valuesByBundle.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, members]) => parseBundle(id, members)),
  )
}
