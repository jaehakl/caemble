import { CadModelError } from './errors'
import type { Rotation, Tensor, Vars, Vec3 } from './types'
import { assertUcumUnitComparable, normalizeUcumUnit, type UcumUnit } from './units'
import {
  createRandom,
  normalizeVars,
  normalizeVarsSchema,
  randomTensor,
  type NormalizedVarsSchema,
  type VarsSchemaEntry,
} from './vars'

export type GeometryAttributes<P extends object = object> = Readonly<
  P & {
    id: string
    materials?: readonly import('./material').Material[]
    pos?: Vec3
    rotate?: Rotation
    scale?: Vec3
    children?: unknown
  }
>
export type Geometry<P extends object = object> = (props: GeometryAttributes<P>) => unknown
export type StructureGroupMap = Readonly<Record<string, readonly string[]>>
export type StructureOptions = {
  geometry: () => unknown
  lengthUnit: UcumUnit
  varsSchema: Record<string, VarsSchemaEntry>
  geometryGroup?: StructureGroupMap
  surfaceGroup?: StructureGroupMap
}

const normalizedVarsSchemas = new WeakMap<object, NormalizedVarsSchema>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStructureGroup(
  rawGroup: unknown,
  propertyName: 'geometryGroup' | 'surfaceGroup',
  objectName: string,
) {
  if (rawGroup === undefined) return Object.freeze({}) as StructureGroupMap
  if (!isRecord(rawGroup)) throw new CadModelError(`${objectName} ${propertyName} must be an object.`)
  const names = new Set<string>()
  const entries = Object.entries(rawGroup).map(([rawName, rawMembers]) => {
    const name = rawName.trim()
    if (!name) throw new CadModelError(`${objectName} ${propertyName} group names must not be empty.`)
    if (names.has(name)) {
      throw new CadModelError(`${objectName} ${propertyName} group name "${name}" is duplicated after trimming.`)
    }
    names.add(name)
    if (!Array.isArray(rawMembers)) {
      throw new CadModelError(`${objectName} ${propertyName}.${name} must be an array of global IDs.`)
    }
    const memberIds: string[] = []
    const seenMemberIds = new Set<string>()
    rawMembers.forEach((rawMember, index) => {
      if (typeof rawMember !== 'string' || !rawMember.trim()) {
        throw new CadModelError(`${objectName} ${propertyName}.${name}[${index}] must be a non-empty string global ID.`)
      }
      const memberId = rawMember.trim()
      if (seenMemberIds.has(memberId)) return
      seenMemberIds.add(memberId)
      memberIds.push(memberId)
    })
    return [name, Object.freeze(memberIds)] as const
  })
  return Object.freeze(Object.fromEntries(entries)) as StructureGroupMap
}

export class Structure {
  readonly geometry: () => unknown
  readonly lengthUnit: UcumUnit
  readonly varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  readonly geometryGroup: StructureGroupMap
  readonly surfaceGroup: StructureGroupMap

  constructor(options: StructureOptions) {
    const objectName = new.target.name || 'Structure'
    if (!isRecord(options) || typeof options.geometry !== 'function') {
      throw new CadModelError(`${objectName} geometry must be a function.`)
    }
    const lengthUnit = normalizeUcumUnit(options.lengthUnit, `${objectName} lengthUnit`)
    assertUcumUnitComparable(lengthUnit, 'm', `${objectName} lengthUnit`)
    const varsSchema = normalizeVarsSchema(options.varsSchema, objectName)
    this.geometry = options.geometry
    this.lengthUnit = lengthUnit
    this.varsSchema = varsSchema.schema
    normalizedVarsSchemas.set(this, varsSchema.normalized)
    this.geometryGroup = normalizeStructureGroup(options.geometryGroup, 'geometryGroup', objectName)
    this.surfaceGroup = normalizeStructureGroup(options.surfaceGroup, 'surfaceGroup', objectName)
    if (new.target === Structure) Object.freeze(this)
  }

  randomVars(seed?: number, objectName = this.constructor.name || 'Structure') {
    const random = createRandom(seed)
    const generated: Vars = {}
    const schema = normalizedVarsSchemas.get(this)!
    Object.entries(schema).forEach(([key, entry]) => {
      generated[key] = randomTensor(entry.shape, entry.min, entry.max, random)
    })
    return normalizeVars(schema, generated, objectName)
  }

  resolveVars(partialVars: Partial<Vars> = {}, seed?: number, objectName = this.constructor.name || 'Structure') {
    if (!isRecord(partialVars)) throw new CadModelError(`${objectName} vars must be an object.`)
    const extraKey = Object.keys(partialVars).find((key) => !(key in this.varsSchema))
    if (extraKey) throw new CadModelError(`Unknown ${objectName} var: ${extraKey}.`)
    const generated = { ...this.randomVars(seed, objectName) }
    Object.entries(partialVars).forEach(([key, value]) => {
      if (value !== undefined) generated[key] = value as Tensor
    })
    return normalizeVars(normalizedVarsSchemas.get(this)!, generated, objectName)
  }
}
