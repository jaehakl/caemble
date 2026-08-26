import { CadModelError } from './errors'
import type { Vec3 } from './types'

export type CanonicalGeometryTransformAttributes = Readonly<{
  position?: Vec3
  rotation?: Vec3
  scale?: Vec3
}>
export type GeometryTransformAttributes = CanonicalGeometryTransformAttributes

export type GeometryIdentityAttributes = Readonly<{ id?: string }>
export type IntrinsicGeometryAttributes = GeometryIdentityAttributes & GeometryTransformAttributes

export type GeometryAttributes<P extends object = object> = Readonly<
  P & {
    id: string
    materials?: Readonly<Record<string, import('./material').Material | undefined>>
    children?: unknown
  }
> &
  GeometryTransformAttributes

export type Geometry<P extends object = object> = (props: GeometryAttributes<P>) => unknown
export type GeometryInvocationAttributes<P extends object = object> = Readonly<
  Partial<P> & {
    id?: string
    materials?: Readonly<Record<string, import('./material').Material | undefined>>
    children?: unknown
  }
> &
  GeometryTransformAttributes
export type GeometryGroupMap = Readonly<Record<string, readonly string[]>>
export type GeometrySurfaceRef = `${string}/surface/${number}`
export type SurfaceGroupMap = Readonly<Record<string, readonly GeometrySurfaceRef[]>>

export function normalizeGeometryGroup(
  rawGroup: unknown,
  propertyName: 'geometryGroup',
  objectName: string,
): GeometryGroupMap
export function normalizeGeometryGroup(
  rawGroup: unknown,
  propertyName: 'surfaceGroup',
  objectName: string,
): SurfaceGroupMap
export function normalizeGeometryGroup(
  rawGroup: unknown,
  propertyName: 'geometryGroup' | 'surfaceGroup',
  objectName: string,
) {
  if (rawGroup === undefined) return Object.freeze({}) as GeometryGroupMap
  if (typeof rawGroup !== 'object' || rawGroup === null || Array.isArray(rawGroup)) {
    throw new CadModelError(`${objectName} ${propertyName} must be an object.`)
  }
  const names = new Set<string>()
  const entries = Object.entries(rawGroup).map(([rawName, rawMembers]) => {
    const name = rawName.trim()
    if (!name) throw new CadModelError(`${objectName} ${propertyName} group names must not be empty.`)
    if (names.has(name)) {
      throw new CadModelError(`${objectName} ${propertyName} group name ${JSON.stringify(name)} is duplicated after trimming.`)
    }
    names.add(name)
    if (!Array.isArray(rawMembers)) {
      throw new CadModelError(`${objectName} ${propertyName}.${name} must be an array of global IDs.`)
    }
    const members: string[] = []
    const seen = new Set<string>()
    rawMembers.forEach((rawMember, index) => {
      if (typeof rawMember !== 'string' || !rawMember.trim()) {
        throw new CadModelError(`${objectName} ${propertyName}.${name}[${index}] must be a non-empty string global ID.`)
      }
      const member = rawMember.trim()
      if (propertyName === 'surfaceGroup') {
        const match = /^.+\/surface\/(0|[1-9]\d*)$/u.exec(member)
        if (!match || !Number.isSafeInteger(Number(match[1]))) {
          throw new CadModelError(
            `${objectName} ${propertyName}.${name}[${index}] must use <source-node-id>/surface/<non-negative-index>.`,
          )
        }
      }
      if (!seen.has(member)) {
        seen.add(member)
        members.push(member)
      }
    })
    return [name, Object.freeze(members)] as const
  })
  return Object.freeze(Object.fromEntries(entries)) as GeometryGroupMap | SurfaceGroupMap
}
