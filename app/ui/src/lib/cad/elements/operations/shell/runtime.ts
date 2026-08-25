import { geometries, measurements, modifiers, primitives } from '@jscad/modeling'
import { CadModelError } from '../../../model/core'
import type { GeometryOperationDefinition } from '../../../evaluation/types'
import { shellManifest } from './definition'

type CadGeom3 = ReturnType<typeof geometries.geom3.create>
type Point3 = [number, number, number]
type Triangle = Readonly<{
  indices: [number, number, number]
  normal: Point3
}>
type AdjacentFace = Readonly<{
  normal: Point3
  weight: number
}>

const cadGeneralize = modifiers.generalize as unknown as (
  options: { triangulate: boolean },
  geometry: CadGeom3,
) => CadGeom3

export function createShellGeometries(geometry: unknown, offsets: unknown): CadGeom3[] {
  if (!Array.isArray(offsets) || offsets.length === 0) {
    throw new CadModelError('<shell> offsets must be a non-empty array.')
  }

  const signedOffsets = offsets as unknown[]
  signedOffsets.forEach((offset, index) => {
    if (typeof offset !== 'number' || !Number.isFinite(offset) || offset === 0) {
      throw new CadModelError(`<shell> offset at index ${index} must be a finite non-zero number.`)
    }
    if (index > 0 && offset <= (signedOffsets[index - 1] as number)) {
      throw new CadModelError('<shell> offsets must be in strictly increasing order.')
    }
  })
  const validOffsets = signedOffsets as number[]

  if (!geometries.geom3.isA(geometry)) {
    throw new CadModelError('<shell> child Geometry must be a valid closed geom3 solid.')
  }

  let triangulated
  try {
    // Triangulation also inserts missing T-junction vertices from JSCAD boolean results.
    triangulated = cadGeneralize({ triangulate: true }, geometries.geom3.clone(geometry))
    geometries.geom3.validate(triangulated)
    const volume = measurements.measureVolume(triangulated)
    if (!Number.isFinite(volume) || volume <= 0) throw new Error('invalid solid orientation')
  } catch {
    throw new CadModelError('<shell> child Geometry must be a valid closed geom3 solid.')
  }

  const polygons = geometries.geom3.toPolygons(triangulated)
  if (polygons.length === 0) {
    throw new CadModelError('<shell> child Geometry must be a valid closed geom3 solid.')
  }

  const points: Point3[] = []
  const pointIndices = new Map<string, number>()
  const triangles: Triangle[] = polygons.map((polygon) => {
    if (polygon.vertices.length !== 3) {
      throw new CadModelError('<shell> child Geometry could not be triangulated.')
    }

    const indices = polygon.vertices.map((vertex) => {
      const key = vertex.toString()
      const existing = pointIndices.get(key)
      if (existing !== undefined) return existing

      const index = points.length
      pointIndices.set(key, index)
      points.push([vertex[0], vertex[1], vertex[2]])
      return index
    }) as [number, number, number]
    const plane = geometries.poly3.plane(polygon)
    return { indices, normal: [plane[0], plane[1], plane[2]] }
  })

  const adjacentFaces: AdjacentFace[][] = points.map(() => [])
  triangles.forEach(({ indices, normal }) => {
    indices.forEach((pointIndex, cornerIndex) => {
      const point = points[pointIndex]
      const before = points[indices[(cornerIndex + 2) % 3]]
      const after = points[indices[(cornerIndex + 1) % 3]]
      const beforeX = before[0] - point[0]
      const beforeY = before[1] - point[1]
      const beforeZ = before[2] - point[2]
      const afterX = after[0] - point[0]
      const afterY = after[1] - point[1]
      const afterZ = after[2] - point[2]
      const beforeLength = Math.hypot(beforeX, beforeY, beforeZ)
      const afterLength = Math.hypot(afterX, afterY, afterZ)
      const cosine = (beforeX * afterX + beforeY * afterY + beforeZ * afterZ) / (beforeLength * afterLength)
      const weight = Math.acos(Math.max(-1, Math.min(1, cosine)))

      if (!Number.isFinite(weight) || weight <= 0) {
        throw new CadModelError('<shell> child Geometry contains a degenerate triangle.')
      }
      adjacentFaces[pointIndex].push({ normal, weight })
    })
  })

  const unitDisplacements = points.map((_, pointIndex) => {
    let a00 = 0
    let a01 = 0
    let a02 = 0
    let a11 = 0
    let a12 = 0
    let a22 = 0
    let b0 = 0
    let b1 = 0
    let b2 = 0
    let totalWeight = 0

    adjacentFaces[pointIndex].forEach(({ normal, weight }) => {
      const [x, y, z] = normal
      a00 += weight * x * x
      a01 += weight * x * y
      a02 += weight * x * z
      a11 += weight * y * y
      a12 += weight * y * z
      a22 += weight * z * z
      b0 += weight * x
      b1 += weight * y
      b2 += weight * z
      totalWeight += weight
    })

    const averageNormalLength = Math.hypot(b0, b1, b2)
    if (!Number.isFinite(averageNormalLength) || averageNormalLength === 0 || totalWeight === 0) {
      throw new CadModelError(`<shell> could not calculate a stable offset at vertex ${pointIndex}.`)
    }

    // Solve n · displacement = 1, with a small normal-direction bias for rank-deficient flat vertices.
    const averageNormalX = b0 / averageNormalLength
    const averageNormalY = b1 / averageNormalLength
    const averageNormalZ = b2 / averageNormalLength
    const regularization = totalWeight * 1e-8
    a00 += regularization
    a11 += regularization
    a22 += regularization
    b0 += regularization * averageNormalX
    b1 += regularization * averageNormalY
    b2 += regularization * averageNormalZ

    const determinant = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02)
    if (!Number.isFinite(determinant) || determinant === 0) {
      throw new CadModelError(`<shell> could not calculate a stable offset at vertex ${pointIndex}.`)
    }

    const displacementX =
      (b0 * (a11 * a22 - a12 * a12) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a12 - a11 * b2)) / determinant
    const displacementY =
      (a00 * (b1 * a22 - a12 * b2) - b0 * (a01 * a22 - a12 * a02) + a02 * (a01 * b2 - b1 * a02)) / determinant
    const displacementZ =
      (a00 * (a11 * b2 - b1 * a12) - a01 * (a01 * b2 - b1 * a02) + b0 * (a01 * a12 - a11 * a02)) / determinant
    const displacement = [displacementX, displacementY, displacementZ] as Point3

    if (!displacement.every(Number.isFinite)) {
      throw new CadModelError(`<shell> could not calculate a stable offset at vertex ${pointIndex}.`)
    }
    return displacement
  })

  const boundaries = [...validOffsets, 0].sort((first, second) => first - second)
  const minimumArea = measurements.measureEpsilon(triangulated) ** 2
  const boundaryPoints = new Map<number, Point3[]>([[0, points]])
  validOffsets.forEach((offset) => {
    const offsetPoints = points.map(
      (point, index) =>
        [
          point[0] + offset * unitDisplacements[index][0],
          point[1] + offset * unitDisplacements[index][1],
          point[2] + offset * unitDisplacements[index][2],
        ] as Point3,
    )

    triangles.forEach(({ indices, normal }, triangleIndex) => {
      const first = offsetPoints[indices[0]]
      const second = offsetPoints[indices[1]]
      const third = offsetPoints[indices[2]]
      const firstEdgeX = second[0] - first[0]
      const firstEdgeY = second[1] - first[1]
      const firstEdgeZ = second[2] - first[2]
      const secondEdgeX = third[0] - first[0]
      const secondEdgeY = third[1] - first[1]
      const secondEdgeZ = third[2] - first[2]
      const crossX = firstEdgeY * secondEdgeZ - firstEdgeZ * secondEdgeY
      const crossY = firstEdgeZ * secondEdgeX - firstEdgeX * secondEdgeZ
      const crossZ = firstEdgeX * secondEdgeY - firstEdgeY * secondEdgeX
      const signedArea = crossX * normal[0] + crossY * normal[1] + crossZ * normal[2]

      if (!Number.isFinite(signedArea) || signedArea <= minimumArea) {
        throw new CadModelError(
          `<shell> offset ${offset} creates a degenerate or inverted surface at triangle ${triangleIndex}.`,
        )
      }
    })
    boundaryPoints.set(offset, offsetPoints)
  })

  const faces = triangles.map(({ indices }) => indices)
  return boundaries.slice(0, -1).map((innerOffset, layerIndex) => {
    const outerOffset = boundaries[layerIndex + 1]
    const innerPoints = boundaryPoints.get(innerOffset)
    const outerPoints = boundaryPoints.get(outerOffset)
    if (!innerPoints || !outerPoints) {
      throw new CadModelError(`<shell> could not create layer [${innerOffset}, ${outerOffset}].`)
    }

    const outerStart = innerPoints.length
    const shell = primitives.polyhedron({
      points: [...innerPoints, ...outerPoints],
      faces: [
        ...faces.map((face) => face.map((index) => index + outerStart)),
        ...faces.map((face) => [...face].reverse()),
      ],
    })

    try {
      geometries.geom3.validate(shell)
      const volume = measurements.measureVolume(shell)
      if (!Number.isFinite(volume) || volume <= 0) throw new Error('invalid shell volume')
    } catch {
      throw new CadModelError(`<shell> generated an invalid layer [${innerOffset}, ${outerOffset}].`)
    }
    return shell
  })
}

export const shellDefinition = {
  kind: 'operation',
  tag: shellManifest.tag,
  manifest: shellManifest,
  surfacePolicy: 'derive',
  evaluate(node, context) {
    if (node.children.length !== 1) {
      throw new CadModelError('<shell> requires exactly one direct child Geometry.')
    }
    if (
      typeof node.props.offsets !== 'object' ||
      node.props.offsets === null ||
      Array.isArray(node.props.offsets) ||
      Object.keys(node.props.offsets).length === 0
    ) {
      throw new CadModelError('<shell> offsets must be a non-empty object mapping Material roles to offsets.')
    }
    const offsets = Object.entries(node.props.offsets).map(([role, offset]) => {
      if (!role.trim()) throw new CadModelError('<shell> offset Material roles must not be blank.')
      if (role !== role.trim()) {
        throw new CadModelError(`<shell> offset Material role "${role}" must not have leading or trailing whitespace.`)
      }
      if (typeof offset !== 'number' || !Number.isFinite(offset) || offset === 0) {
        throw new CadModelError(`<shell> offset for Material role "${role}" must be a finite non-zero number.`)
      }
      return { role, offset }
    })
    offsets.sort((left, right) => left.offset - right.offset)

    const parts = context.evaluate(node.children[0], context.inheritedMaterials)
    if (parts.length !== 1) {
      throw new CadModelError('<shell> child Geometry must evaluate to exactly one solid.')
    }

    const boundaries = [...offsets.map(({ offset }) => offset), 0].sort((first, second) => first - second)
    return createShellGeometries(
      parts[0].geometry,
      offsets.map(({ offset }) => offset),
    ).map((geometry, index) => {
      const { role } = offsets[index]
      const binding = context.inheritedMaterials.get(role)
      return {
        geometry,
        canonicalNode: {
          kind: 'shell' as const,
          nodeId: `${context.nodeId}/$layer-${index + 1}`,
          innerOffset: boundaries[index],
          outerOffset: boundaries[index + 1],
          child: parts[0].canonicalNode,
        },
        materialRole: binding?.role ?? role,
        ...(binding?.material === undefined ? {} : { material: binding.material }),
      }
    })
  },
} satisfies GeometryOperationDefinition<'shell'>
