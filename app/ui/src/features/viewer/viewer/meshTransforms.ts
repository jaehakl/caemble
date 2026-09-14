import type { RecordedResultContracts } from '@/contracts/results'
import { convertUcumValue, type RecordedData, type RecordedDataRule, type UcumUnit } from '@/lib/cad/model'
import { createDataTensorAccessor, isDataTensor } from '@/lib/cad/model/dataTensor'
import { meshMaterialColors, type MeshRenderData, type MeshRenderGeometry } from './meshFields'

export type RecordedMeshTransform = Readonly<{
  label: string
  identity: string
  bodyIds: readonly string[]
  lengthUnit: UcumUnit
  times: Float64Array
  vertices: Float64Array
  triangles: Uint32Array
  vertexOffsets: Uint32Array
  triangleOffsets: Uint32Array
  localCenters: Float64Array
  positions: Float64Array
  orientations: Float64Array
}>

/** Decode the Catalog's paths; body IDs are coordinates, never inferred array indices. */
export function parseRecordedMeshTransforms(
  rules: readonly RecordedDataRule[],
  data?: RecordedData | null,
  contracts: RecordedResultContracts = {},
) {
  const motions: RecordedMeshTransform[] = []
  const errors: { label: string; message: string }[] = []
  const labels = Object.keys(contracts).filter((label) => contracts[label].visualization.kind === 'mesh-transform')
  const byLabel = new Map(rules.map((rule) => [rule.label, rule]))
  if (!data) return { motions, errors, labels }
  for (const label of labels) {
    try {
      const semantic = contracts[label].visualization.meshTransform
      if (!semantic || semantic.quaternionOrder !== 'wxyz')
        throw new Error('Mesh transforms require explicit mesh paths and wxyz quaternion semantics.')
      const read = (member: string) => {
        const path = `${label}.${member}`
        const rule = byLabel.get(path)
        const value = data[path]
        if (!rule || !isDataTensor(value)) throw new Error(`Mesh transform is missing ${member}.`)
        return {
          schema: rule.result,
          accessor: createDataTensorAccessor(rule.result, value, path),
        }
      }
      const numbers = (member: string, shape: readonly number[], unit?: UcumUnit) => {
        const { schema, accessor } = read(member)
        if (
          accessor.shape.length !== shape.length ||
          shape.some((size, axis) => size >= 0 && size !== accessor.shape[axis])
        )
          throw new Error(`Mesh transform ${member} has an inconsistent shape.`)
        const scale = unit ? convertUcumValue(1, schema.unit as UcumUnit, unit, member) : 1
        return Float64Array.from({ length: accessor.size }, (_, index) => {
          const value = accessor.at(index)
          if (typeof value !== 'number' || !Number.isFinite(value * scale))
            throw new Error(`Mesh transform ${member} must contain finite real values.`)
          return value * scale
        })
      }
      const ids = read(semantic.bodyIds).accessor
      if (ids.shape.length !== 1 || !ids.size) throw new Error('Mesh transforms require body IDs.')
      const bodyIds = Array.from({ length: ids.size }, (_, index) => {
        const id = ids.at(index)
        if (typeof id !== 'string' || !id) throw new Error('Body IDs must be nonempty strings.')
        return id
      })
      if (new Set(bodyIds).size !== bodyIds.length) throw new Error('Body IDs must be unique.')
      const lengthUnit = read(semantic.vertices).schema.unit as UcumUnit
      convertUcumValue(1, lengthUnit, 'm', 'Mesh transform coordinates')
      const vertices = numbers(semantic.vertices, [-1, 3], lengthUnit)
      const times = numbers(semantic.times, [-1], 's')
      if (!times.length || times.some((time, index) => index > 0 && time <= times[index - 1]))
        throw new Error('Mesh transform times must be nonempty and strictly increasing.')
      const localCenters = numbers(semantic.localCenters, [ids.size, 3], lengthUnit)
      const positions = numbers(semantic.positions, [times.length, ids.size, 3], lengthUnit)
      const orientations = numbers(semantic.orientations, [times.length, ids.size, 4], '1')
      for (const [member, bodyAxis] of [
        [semantic.localCenters, 0],
        [semantic.positions, 1],
        [semantic.orientations, 1],
      ] as const) {
        const { schema, accessor } = read(member)
        const ticks = accessor.tensor.axes?.[bodyAxis]?.ticks
        if (!ticks || ticks.length !== ids.size || ticks.some((id, index) => id !== bodyIds[index]))
          throw new Error(`Mesh transform ${member} body coordinates differ from body IDs.`)
        if (bodyAxis === 1) {
          const ticks = accessor.tensor.axes?.[0]?.ticks
          const scale = convertUcumValue(1, schema.axes?.[0].unit as UcumUnit, 's', 'Pose time')
          if (
            !ticks ||
            ticks.length !== times.length ||
            ticks.some((time, index) => Number(time) * scale !== times[index])
          )
            throw new Error(`Mesh transform ${member} time coordinates differ from its timeline.`)
        }
      }
      for (let index = 0; index < orientations.length; index += 4) {
        const norm = Math.hypot(...orientations.subarray(index, index + 4))
        if (Math.abs(norm - 1) > 1e-6) throw new Error('Mesh transform orientations must be unit quaternions.')
        for (let axis = 0; axis < 4; axis++) orientations[index + axis] /= norm
      }
      const connectivity = numbers(semantic.triangles, [-1, 3])
      const vertexOffsets = numbers(semantic.vertexOffsets, [ids.size + 1])
      const triangleOffsets = numbers(semantic.triangleOffsets, [ids.size + 1])
      for (const [offsets, count] of [
        [vertexOffsets, vertices.length / 3],
        [triangleOffsets, connectivity.length / 3],
      ] as const) {
        if (
          offsets[0] !== 0 ||
          offsets[ids.size] !== count ||
          offsets.some((value, index) => !Number.isSafeInteger(value) || (index > 0 && value <= offsets[index - 1]))
        )
          throw new Error('Mesh offsets must identify a nonempty mesh for every body.')
      }
      for (let body = 0; body < ids.size; body++) {
        for (let index = triangleOffsets[body] * 3; index < triangleOffsets[body + 1] * 3; index++) {
          const node = connectivity[index]
          if (!Number.isSafeInteger(node) || node < vertexOffsets[body] || node >= vertexOffsets[body + 1])
            throw new Error(`Body ${bodyIds[body]} triangles reference an absent or different body's vertex.`)
        }
      }
      motions.push({
        label,
        identity: `${label}:${JSON.stringify([bodyIds, Array.from(vertexOffsets), Array.from(triangleOffsets)])}`,
        bodyIds,
        lengthUnit,
        times,
        vertices,
        triangles: Uint32Array.from(connectivity),
        vertexOffsets: Uint32Array.from(vertexOffsets),
        triangleOffsets: Uint32Array.from(triangleOffsets),
        localCenters,
        positions,
        orientations,
      })
    } catch (error) {
      errors.push({ label, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { motions, errors, labels }
}

/** Continuous physical time with shortest-arc SLERP, including equivalent q and -q. */
export function meshTransformAtTime(motion: RecordedMeshTransform, time: number) {
  const { times, bodyIds, positions, orientations, vertices, localCenters, vertexOffsets } = motion
  let lower = 0
  let upper = times.length - 1
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2)
    if (times[middle] <= time) lower = middle
    else upper = middle
  }
  const alpha = upper === lower ? 0 : Math.max(0, Math.min(1, (time - times[lower]) / (times[upper] - times[lower])))
  const result = new Float64Array(vertices.length)
  const centers = new Float64Array(bodyIds.length * 3)
  for (let body = 0; body < bodyIds.length; body++) {
    const start = (lower * bodyIds.length + body) * 4
    const end = (upper * bodyIds.length + body) * 4
    const q0 = orientations.subarray(start, start + 4)
    const q1 = orientations.subarray(end, end + 4)
    const dot = q0.reduce((sum, value, axis) => sum + value * q1[axis], 0)
    const sign = dot < 0 ? -1 : 1
    const angle = Math.acos(Math.min(1, Math.abs(dot)))
    const a = angle < 1e-6 ? 1 - alpha : Math.sin((1 - alpha) * angle) / Math.sin(angle)
    const b = (angle < 1e-6 ? alpha : Math.sin(alpha * angle) / Math.sin(angle)) * sign
    const q = q0.map((value, axis) => a * value + b * q1[axis])
    const norm = Math.hypot(...q)
    const [w, x, y, z] = q.map((value) => value / norm)
    const rotation = [
      1 - 2 * (y * y + z * z),
      2 * (x * y - z * w),
      2 * (x * z + y * w),
      2 * (x * y + z * w),
      1 - 2 * (x * x + z * z),
      2 * (y * z - x * w),
      2 * (x * z - y * w),
      2 * (y * z + x * w),
      1 - 2 * (x * x + y * y),
    ]
    for (let axis = 0; axis < 3; axis++) {
      const initial = positions[(lower * bodyIds.length + body) * 3 + axis]
      centers[body * 3 + axis] = initial + alpha * (positions[(upper * bodyIds.length + body) * 3 + axis] - initial)
    }
    for (let vertex = vertexOffsets[body]; vertex < vertexOffsets[body + 1]; vertex++) {
      for (let axis = 0; axis < 3; axis++) {
        let value = centers[body * 3 + axis]
        for (let coordinate = 0; coordinate < 3; coordinate++)
          value +=
            rotation[axis * 3 + coordinate] * (vertices[vertex * 3 + coordinate] - localCenters[body * 3 + coordinate])
        result[vertex * 3 + axis] = value
      }
    }
  }
  return { vertices: result, centers }
}

/** Cache connectivity and conservative bounds once, independent of animation frame. */
export function prepareMeshTransform(motion: RecordedMeshTransform, displayUnit: UcumUnit) {
  const lengthScale = convertUcumValue(1, motion.lengthUnit, displayUnit, 'Mesh transform display')
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  const chunks: { nodes: Uint32Array; colors: Float32Array; indices: Uint16Array }[] = []
  const bodyColors: string[] = []
  for (let body = 0; body < motion.bodyIds.length; body++) {
    let radius = 0
    for (let vertex = motion.vertexOffsets[body]; vertex < motion.vertexOffsets[body + 1]; vertex++)
      radius = Math.max(
        radius,
        Math.hypot(
          ...[0, 1, 2].map((axis) => motion.vertices[vertex * 3 + axis] - motion.localCenters[body * 3 + axis]),
        ),
      )
    for (let time = 0; time < motion.times.length; time++) {
      for (let axis = 0; axis < 3; axis++) {
        const center = motion.positions[(time * motion.bodyIds.length + body) * 3 + axis]
        bounds.min[axis] = Math.min(bounds.min[axis], (center - radius) * lengthScale)
        bounds.max[axis] = Math.max(bounds.max[axis], (center + radius) * lengthScale)
      }
    }
    let hash = 0
    for (const character of motion.bodyIds[body]) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0
    const color = meshMaterialColors[hash % meshMaterialColors.length]
    bodyColors.push(color)
    const rgba = [...[1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255), 1]
    for (let start = motion.triangleOffsets[body] * 3; start < motion.triangleOffsets[body + 1] * 3; start += 65_535) {
      const end = Math.min(start + 65_535, motion.triangleOffsets[body + 1] * 3)
      const nodes = motion.triangles.subarray(start, end)
      chunks.push({
        nodes,
        colors: Float32Array.from({ length: nodes.length * 4 }, (_, index) => rgba[index % 4]),
        indices: Uint16Array.from({ length: nodes.length }, (_, index) => index),
      })
    }
  }
  return { chunks, bounds, lengthScale, bodyColors }
}

export function createMeshTransformRenderData(
  motion: RecordedMeshTransform,
  time: number,
  prepared: ReturnType<typeof prepareMeshTransform>,
): MeshRenderData {
  const posed = meshTransformAtTime(motion, time).vertices
  const geometries: MeshRenderGeometry[] = prepared.chunks.map((chunk) => {
    const positions = Float32Array.from(
      { length: chunk.nodes.length * 3 },
      (_, index) => posed[chunk.nodes[Math.floor(index / 3)] * 3 + (index % 3)] * prepared.lengthScale,
    )
    const colors = chunk.colors.slice()
    // Flat face lighting reveals CSG cavities without deforming or retessellating the reference mesh.
    for (let face = 0; face < chunk.nodes.length / 3; face++) {
      const offset = face * 9
      const a = [0, 1, 2].map((axis) => positions[offset + 3 + axis] - positions[offset + axis])
      const b = [0, 1, 2].map((axis) => positions[offset + 6 + axis] - positions[offset + axis])
      const normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
      const norm = Math.hypot(...normal)
      const shade = norm
        ? 0.35 + 0.65 * Math.abs((normal[0] * 0.267 + normal[1] * 0.535 + normal[2] * 0.802) / norm)
        : 0.35
      for (let vertex = 0; vertex < 3; vertex++)
        for (let channel = 0; channel < 3; channel++) colors[(face * 3 + vertex) * 4 + channel] *= shade
    }
    return { primitive: 'triangles', positions, colors, indices: chunk.indices }
  })
  return { geometries, bounds: prepared.bounds }
}
