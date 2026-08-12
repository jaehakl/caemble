import { CadModelError } from './errors'
import type { Rotation, Vec3 } from './types'

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
export type GeometryGroupMap = Readonly<Record<string, readonly string[]>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeGeometryGroup(
  rawGroup: unknown,
  propertyName: 'geometryGroup' | 'surfaceGroup',
  objectName: string,
) {
  if (rawGroup === undefined) return Object.freeze({}) as GeometryGroupMap
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
  return Object.freeze(Object.fromEntries(entries)) as GeometryGroupMap
}
