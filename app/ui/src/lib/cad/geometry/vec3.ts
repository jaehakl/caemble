import { CadModelError } from '../model/core'
import type { Vec3 } from '../model/types'

export type MutableVec3 = [number, number, number]

export function parseVec3(value: unknown, path: string): MutableVec3 {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))
  ) {
    throw new CadModelError(`${path} must be an array of exactly three finite numbers.`)
  }

  return [value[0], value[1], value[2]]
}

export function subtract(left: Vec3, right: Vec3): MutableVec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

export function dot(left: Vec3, right: Vec3) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

export function cross(left: Vec3, right: Vec3): MutableVec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ]
}

export function vectorLength(value: Vec3) {
  return Math.hypot(...value)
}

export function normalizeVector(value: Vec3, path: string): MutableVec3 {
  const length = vectorLength(value)
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    throw new CadModelError(`${path} must not be a zero-length vector.`)
  }

  return [value[0] / length, value[1] / length, value[2] / length]
}

export function interpolate(left: Vec3, right: Vec3, amount: number): MutableVec3 {
  return [
    left[0] + (right[0] - left[0]) * amount,
    left[1] + (right[1] - left[1]) * amount,
    left[2] + (right[2] - left[2]) * amount,
  ]
}

export function rotateAroundAxis(vector: Vec3, axis: Vec3, angle: number): MutableVec3 {
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  const axisProjection = dot(axis, vector) * (1 - cosine)
  const axisCross = cross(axis, vector)

  return [
    vector[0] * cosine + axisCross[0] * sine + axis[0] * axisProjection,
    vector[1] * cosine + axisCross[1] * sine + axis[1] * axisProjection,
    vector[2] * cosine + axisCross[2] * sine + axis[2] * axisProjection,
  ]
}
