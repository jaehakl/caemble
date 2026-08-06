import { geometries, measurements } from '@jscad/modeling'
import type { Vec3 } from '../model/types'

type Bounds = readonly [Vec3, Vec3]

type PreparedTriangle = Readonly<{
  anchor: Vec3
  bounds: Bounds
  center: Vec3
  edge1: Vec3
  edge2: Vec3
  normal: Vec3
  normalLengthSquared: number
  maximumEdgeLength: number
}>

type TriangleTree = Readonly<{
  bounds: Bounds
  children?: readonly [TriangleTree, TriangleTree]
  triangles?: readonly PreparedTriangle[]
}>

export type SolidPointTester = Readonly<{
  bounds: Bounds
  contains: (point: Vec3) => boolean
  epsilon: number
}>

const rayDirection = normalize([1, Math.SQRT1_2, Math.PI / 7])

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

function dot(left: Vec3, right: Vec3) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ]
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(...vector)
  return [vector[0] / length, vector[1] / length, vector[2] / length]
}

function distance(left: Vec3, right: Vec3) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2])
}

function prepareTriangle(anchor: Vec3, second: Vec3, third: Vec3): PreparedTriangle | null {
  const edge1 = subtract(second, anchor)
  const edge2 = subtract(third, anchor)
  const normal = cross(edge1, edge2)
  const normalLengthSquared = dot(normal, normal)
  if (normalLengthSquared === 0) return null

  return {
    anchor,
    bounds: [
      [
        Math.min(anchor[0], second[0], third[0]),
        Math.min(anchor[1], second[1], third[1]),
        Math.min(anchor[2], second[2], third[2]),
      ],
      [
        Math.max(anchor[0], second[0], third[0]),
        Math.max(anchor[1], second[1], third[1]),
        Math.max(anchor[2], second[2], third[2]),
      ],
    ],
    center: [
      (anchor[0] + second[0] + third[0]) / 3,
      (anchor[1] + second[1] + third[1]) / 3,
      (anchor[2] + second[2] + third[2]) / 3,
    ],
    edge1,
    edge2,
    normal,
    normalLengthSquared,
    maximumEdgeLength: Math.max(distance(anchor, second), distance(second, third), distance(third, anchor)),
  }
}

function triangleBounds(triangles: readonly PreparedTriangle[]): Bounds {
  const minimum: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ]
  const maximum: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]
  for (const triangle of triangles) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], triangle.bounds[0][axis])
      maximum[axis] = Math.max(maximum[axis], triangle.bounds[1][axis])
    }
  }
  return [minimum, maximum]
}

function buildTriangleTree(triangles: readonly PreparedTriangle[]): TriangleTree {
  const bounds = triangleBounds(triangles)
  if (triangles.length <= 12) return { bounds, triangles }

  const dimensions = bounds[0].map((minimum, axis) => bounds[1][axis] - minimum)
  const splitAxis = dimensions.indexOf(Math.max(...dimensions))
  const ordered = [...triangles].sort((left, right) => left.center[splitAxis] - right.center[splitAxis])
  const middle = Math.floor(ordered.length / 2)
  return {
    bounds,
    children: [buildTriangleTree(ordered.slice(0, middle)), buildTriangleTree(ordered.slice(middle))],
  }
}

function pointIsWithinBounds(point: Vec3, bounds: Bounds, epsilon: number) {
  return point.every(
    (coordinate, axis) => coordinate >= bounds[0][axis] - epsilon && coordinate <= bounds[1][axis] + epsilon,
  )
}

function pointIsOnTriangle(point: Vec3, triangle: PreparedTriangle, epsilon: number) {
  const offset = subtract(point, triangle.anchor)
  const planeDistance = dot(offset, triangle.normal)
  if (planeDistance * planeDistance > epsilon * epsilon * triangle.normalLengthSquared) return false

  const edge1LengthSquared = dot(triangle.edge1, triangle.edge1)
  const edge2LengthSquared = dot(triangle.edge2, triangle.edge2)
  const edgeDot = dot(triangle.edge1, triangle.edge2)
  const offsetEdge1Dot = dot(offset, triangle.edge1)
  const offsetEdge2Dot = dot(offset, triangle.edge2)
  const denominator = edge1LengthSquared * edge2LengthSquared - edgeDot * edgeDot
  if (denominator === 0) return false

  const firstWeight = (edge2LengthSquared * offsetEdge1Dot - edgeDot * offsetEdge2Dot) / denominator
  const secondWeight = (edge1LengthSquared * offsetEdge2Dot - edgeDot * offsetEdge1Dot) / denominator
  const weightTolerance = epsilon / triangle.maximumEdgeLength
  return (
    firstWeight >= -weightTolerance &&
    secondWeight >= -weightTolerance &&
    firstWeight + secondWeight <= 1 + weightTolerance
  )
}

function rayIntersectionDistance(point: Vec3, triangle: PreparedTriangle) {
  const perpendicular = cross(rayDirection, triangle.edge2)
  const determinant = dot(triangle.edge1, perpendicular)
  const determinantTolerance = triangle.maximumEdgeLength * triangle.maximumEdgeLength * 1e-12
  if (Math.abs(determinant) <= determinantTolerance) return null

  const inverseDeterminant = 1 / determinant
  const offset = subtract(point, triangle.anchor)
  const firstWeight = dot(offset, perpendicular) * inverseDeterminant
  if (firstWeight < -1e-10 || firstWeight > 1 + 1e-10) return null

  const perpendicularOffset = cross(offset, triangle.edge1)
  const secondWeight = dot(rayDirection, perpendicularOffset) * inverseDeterminant
  if (secondWeight < -1e-10 || firstWeight + secondWeight > 1 + 1e-10) return null

  return dot(triangle.edge2, perpendicularOffset) * inverseDeterminant
}

function rayIntersectsBounds(point: Vec3, bounds: Bounds, epsilon: number) {
  let minimumDistance = 0
  let maximumDistance = Number.POSITIVE_INFINITY
  for (let axis = 0; axis < 3; axis += 1) {
    let near = (bounds[0][axis] - epsilon - point[axis]) / rayDirection[axis]
    let far = (bounds[1][axis] + epsilon - point[axis]) / rayDirection[axis]
    if (near > far) [near, far] = [far, near]
    minimumDistance = Math.max(minimumDistance, near)
    maximumDistance = Math.min(maximumDistance, far)
    if (maximumDistance < minimumDistance) return false
  }
  return maximumDistance >= 0
}

function pointIsInsideSolid(point: Vec3, triangleTree: TriangleTree, bounds: Bounds, epsilon: number) {
  if (!pointIsWithinBounds(point, bounds, epsilon)) return false

  const intersections: number[] = []
  const pending = [triangleTree]
  while (pending.length > 0) {
    const node = pending.pop()!
    if (!rayIntersectsBounds(point, node.bounds, epsilon)) continue
    if (node.children) {
      pending.push(...node.children)
      continue
    }

    for (const triangle of node.triangles ?? []) {
      if (pointIsOnTriangle(point, triangle, epsilon)) return true
      const intersection = rayIntersectionDistance(point, triangle)
      if (intersection !== null && intersection > epsilon) intersections.push(intersection)
    }
  }
  if (intersections.length === 0) return false

  intersections.sort((left, right) => left - right)
  let distinctIntersections = 1
  for (let index = 1; index < intersections.length; index += 1) {
    if (Math.abs(intersections[index] - intersections[index - 1]) > epsilon * 2) {
      distinctIntersections += 1
    }
  }
  return distinctIntersections % 2 === 1
}

export function createSolidPointTester(geometry: unknown): SolidPointTester | null {
  if (!geometries.geom3.isA(geometry)) return null

  const triangles: PreparedTriangle[] = []
  for (const polygon of geometries.geom3.toPolygons(geometry)) {
    if (polygon.vertices.length < 3) continue
    const anchor = polygon.vertices[0] as Vec3
    for (let index = 1; index < polygon.vertices.length - 1; index += 1) {
      const triangle = prepareTriangle(anchor, polygon.vertices[index] as Vec3, polygon.vertices[index + 1] as Vec3)
      if (triangle) triangles.push(triangle)
    }
  }
  if (triangles.length === 0) return null

  const bounds = measurements.measureBoundingBox(geometry) as Bounds
  const epsilon = Math.max(measurements.measureEpsilon(geometry), Number.EPSILON)
  const triangleTree = buildTriangleTree(triangles)
  return Object.freeze({
    bounds,
    contains: (point: Vec3) => pointIsInsideSolid(point, triangleTree, bounds, epsilon),
    epsilon,
  })
}
