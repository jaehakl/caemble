import { maths, transforms } from '@jscad/modeling'
import { CadModelError } from '../model/core'
import type { Rotation, Vec3 } from '../model/types'
import type { EvaluatedPart, NormalizedTransforms } from './types'

const { scale, transform, translate } = transforms
const cadCreateMatrix = maths.mat4.create as () => unknown
const cadFromRotation = maths.mat4.fromRotation as (
  matrix: unknown,
  angle: number,
  axis: [number, number, number],
) => unknown
const cadScale = scale as (factors: [number, number, number], geometry: unknown) => unknown
const cadTransform = transform as (matrix: unknown, geometry: unknown) => unknown
const cadTranslate = translate as (offset: [number, number, number], geometry: unknown) => unknown

export const origin = Object.freeze([0, 0, 0] as [number, number, number])
export const unitScale = Object.freeze([1, 1, 1] as [number, number, number])

export function normalizeVec3(value: unknown, path: string): Vec3 {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))
  ) {
    throw new CadModelError(`${path} must be an array of exactly three finite numbers.`)
  }

  return Object.freeze([value[0], value[1], value[2]] as [number, number, number])
}

export function normalizeDirection(value: unknown, path: string) {
  const direction = normalizeVec3(value, path)
  const length = Math.hypot(...direction)

  if (length === 0) throw new CadModelError(`${path} must not be the zero vector.`)
  return Object.freeze(direction.map((coordinate) => coordinate / length) as [number, number, number])
}

export function normalizeRotation(value: unknown, owner: string): Rotation | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError(`${owner} rotate must be an object with axis and angle.`)
  }

  const input = value as Record<string, unknown>
  const axis = normalizeDirection(input.axis, `${owner} rotate.axis`)
  if (typeof input.angle !== 'number' || !Number.isFinite(input.angle)) {
    throw new CadModelError(`${owner} rotate.angle must be a finite number in radians.`)
  }

  return Object.freeze({ axis, angle: input.angle })
}

export function normalizeTransforms(props: Record<string, unknown>, owner: string): NormalizedTransforms {
  return {
    pos: props.pos === undefined ? origin : normalizeVec3(props.pos, `${owner} pos`),
    rotate: normalizeRotation(props.rotate, owner),
    scale: props.scale === undefined ? unitScale : normalizeVec3(props.scale, `${owner} scale`),
  }
}

export function applyTransforms(parts: EvaluatedPart[], values: NormalizedTransforms) {
  const shouldScale = values.scale.some((factor) => factor !== 1)
  const rotationMatrix =
    values.rotate && values.rotate.angle !== 0
      ? cadFromRotation(cadCreateMatrix(), values.rotate.angle, [...values.rotate.axis])
      : undefined
  const shouldTranslate = values.pos.some((coordinate) => coordinate !== 0)

  if (!shouldScale && rotationMatrix === undefined && !shouldTranslate) return parts

  return parts.map((part) => {
    let geometry = part.geometry
    if (shouldScale) geometry = cadScale([...values.scale], geometry)
    if (rotationMatrix !== undefined) geometry = cadTransform(rotationMatrix, geometry)
    if (shouldTranslate) geometry = cadTranslate([...values.pos], geometry)
    return { ...part, geometry }
  })
}
