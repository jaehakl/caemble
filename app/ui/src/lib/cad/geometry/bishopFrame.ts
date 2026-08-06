import { CadModelError } from '../model/core'
import type { Vec3 } from '../model/types'
import { cumulativeLengths } from './polyline'
import {
  cross,
  dot,
  normalizeVector,
  parseVec3,
  rotateAroundAxis,
  subtract,
  vectorLength,
  type MutableVec3,
} from './vec3'

export type BishopFrame = {
  tangent: MutableVec3
  normal: MutableVec3
  binormal: MutableVec3
}

function initialNormal(tangent: Vec3, up: unknown): MutableVec3 {
  let candidate: MutableVec3
  if (up !== undefined) {
    candidate = parseVec3(up, '<fiber> up')
  } else {
    const axes: MutableVec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]
    candidate = axes.reduce((best, axis) => (Math.abs(dot(axis, tangent)) < Math.abs(dot(best, tangent)) ? axis : best))
  }

  const projection = dot(candidate, tangent)
  const normal: MutableVec3 = [
    candidate[0] - tangent[0] * projection,
    candidate[1] - tangent[1] * projection,
    candidate[2] - tangent[2] * projection,
  ]
  if (vectorLength(normal) <= 1e-8) {
    throw new CadModelError('<fiber> up must not be parallel to the initial path tangent.')
  }
  return normalizeVector(normal, '<fiber> initial frame normal')
}

export function createBishopFrames(points: readonly Vec3[], up: unknown, path: string): BishopFrame[] {
  cumulativeLengths(points, path)
  const tangents = points.map((_point, index) => {
    if (index === 0) return normalizeVector(subtract(points[1], points[0]), `${path} initial tangent`)
    if (index === points.length - 1)
      return normalizeVector(subtract(points[index], points[index - 1]), `${path} final tangent`)
    return normalizeVector(subtract(points[index + 1], points[index - 1]), `${path} tangent at sample ${index}`)
  })
  const firstNormal = initialNormal(tangents[0], up)
  const frames: BishopFrame[] = [
    {
      tangent: tangents[0],
      normal: firstNormal,
      binormal: normalizeVector(cross(tangents[0], firstNormal), `${path} initial binormal`),
    },
  ]

  for (let index = 1; index < points.length; index += 1) {
    const previous = frames[index - 1]
    const tangent = tangents[index]
    const rotationAxis = cross(previous.tangent, tangent)
    const sine = vectorLength(rotationAxis)
    const cosine = Math.max(-1, Math.min(1, dot(previous.tangent, tangent)))
    let transportedNormal = previous.normal

    if (sine <= 1e-10) {
      if (cosine < 0) throw new CadModelError(`${path} contains a 180-degree tangent reversal near sample ${index}.`)
    } else {
      const axis: MutableVec3 = [rotationAxis[0] / sine, rotationAxis[1] / sine, rotationAxis[2] / sine]
      transportedNormal = rotateAroundAxis(previous.normal, axis, Math.atan2(sine, cosine))
    }

    const projection = dot(transportedNormal, tangent)
    const normal = normalizeVector(
      [
        transportedNormal[0] - tangent[0] * projection,
        transportedNormal[1] - tangent[1] * projection,
        transportedNormal[2] - tangent[2] * projection,
      ],
      `${path} normal at sample ${index}`,
    )
    frames.push({
      tangent,
      normal,
      binormal: normalizeVector(cross(tangent, normal), `${path} binormal at sample ${index}`),
    })
  }

  return frames
}
