import type { Vec3 } from '../model/types'
import { interpolate, subtract, vectorLength, type MutableVec3 } from './vec3'

export function cumulativeLengths(points: readonly Vec3[], _path: string) {
  const cumulative = [0]

  for (let index = 1; index < points.length; index += 1) {
    const segmentLength = vectorLength(subtract(points[index], points[index - 1]))
    cumulative.push(cumulative[index - 1] + segmentLength)
  }

  return cumulative
}

export function resamplePolyline(points: readonly Vec3[], segments: number, path: string): MutableVec3[] {
  const cumulative = cumulativeLengths(points, path)
  const totalLength = cumulative[cumulative.length - 1]
  const sampled: MutableVec3[] = []
  let sourceIndex = 1

  for (let index = 0; index <= segments; index += 1) {
    const targetLength = (totalLength * index) / segments
    while (sourceIndex < cumulative.length - 1 && cumulative[sourceIndex] < targetLength) sourceIndex += 1

    const startLength = cumulative[sourceIndex - 1]
    const endLength = cumulative[sourceIndex]
    sampled.push(
      interpolate(
        points[sourceIndex - 1],
        points[sourceIndex],
        (targetLength - startLength) / (endLength - startLength),
      ),
    )
  }

  sampled[0] = [...points[0]] as MutableVec3
  sampled[sampled.length - 1] = [...points[points.length - 1]] as MutableVec3
  return sampled
}
