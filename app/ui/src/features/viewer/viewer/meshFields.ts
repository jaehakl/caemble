import type { RecordedResultContracts } from '@/contracts/results'
import { convertUcumValue, type RecordedData, type RecordedDataRule, type UcumUnit } from '@/lib/cad/model'
import { createDataTensorAccessor, type DataTensorAccessor } from '@/lib/cad/model/dataTensor'

export type RecordedMeshField = Readonly<{
  label: string
  identity: string
  task?: string
  coordinateSpace?: string
  nodeIds?: Int32Array
  times?: Float64Array
  timeUnit?: UcumUnit
  historyValues?: Float64Array
  lengthUnit: UcumUnit
  valueUnit: UcumUnit
  quantity: string
  valueKind?: 'displacement' | 'stress'
  location: 'node' | 'cell'
  points: Float64Array
  cells: Uint32Array
  values: Float64Array
  componentCount: number
  components: readonly string[]
  boundaryFaces: Uint32Array
  boundaryCells: Uint32Array
  cellRegions: Uint32Array
  regionIds: readonly string[]
  supportNodes: Uint32Array
  loadPoints: Float64Array
  loadVectors: Float64Array
}>

export type MeshRenderGeometry = Readonly<{
  positions: Float32Array
  colors: Float32Array
  indices: Uint16Array
  primitive: 'triangles' | 'lines'
}>

export type MeshFieldView = Readonly<{
  component: number | 'magnitude' | 'vonMises' | 'material'
  wireframe: boolean
  overlays: boolean
  clipAxis: -1 | 0 | 1 | 2
  clipFraction: number
  deformationScale: number
  compareOriginal?: boolean
}>

const tetFaces = [
  [0, 2, 1],
  [0, 1, 3],
  [0, 3, 2],
  [1, 2, 3],
] as const
const tetEdges = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
] as const
export const meshMaterialColors = ['#60a5fa', '#fbbf24', '#a78bfa', '#34d399', '#fb7185', '#22d3ee'] as const

/** Restores domain-preserving records using the same inline/attachment accessor as tensor plots. */
export function parseRecordedMeshFields(
  rules: readonly RecordedDataRule[],
  data?: RecordedData | null,
  contracts: RecordedResultContracts = {},
) {
  const fields: RecordedMeshField[] = []
  const errors: { label: string; message: string }[] = []
  const labels = Object.keys(contracts).filter((label) => contracts[label].visualization.kind === 'mesh-field')
  const byLabel = new Map(rules.map((rule) => [rule.label, rule]))
  if (!data) return { fields, errors, labels }
  for (const label of labels) {
    try {
      const read = (member: string): DataTensorAccessor | undefined => {
        const path = `${label}.${member}`
        const rule = byLabel.get(path)
        const value = data[path]
        return rule && value
          ? createDataTensorAccessor(rule.result, value as Parameters<typeof createDataTensorAccessor>[1], path)
          : undefined
      }
      const semantic = contracts[label].visualization
      const readField = (member: string) => read(semantic.fieldPath ? `${semantic.fieldPath}.${member}` : member)
      if (readField('domain.kind')?.at(0) !== 'unstructured-mesh') continue
      const points = readField('domain.points')
      const cells = readField('domain.cells.tet4')
      const values = readField('values')
      const location = readField('location')?.at(0)
      if (!points || !cells || !values) throw new Error('The recorded field requires points, tet4 cells and values.')
      if (points.shape.length !== 2 || points.shape[1] !== 3 || cells.shape.length !== 2 || cells.shape[1] !== 4) {
        throw new Error('Mesh coordinates must be N×3 and tet4 connectivity M×4.')
      }
      if (!points.shape[0] || !cells.shape[0]) throw new Error('A recorded volume mesh must contain nodes and cells.')
      if (location !== 'node' && location !== 'cell') throw new Error(`Unsupported field location: ${String(location)}`)
      const count = location === 'node' ? points.shape[0] : cells.shape[0]
      if (values.shape[0] !== count) throw new Error('Field values do not match the recorded mesh location.')
      const componentCount = values.shape.slice(1).reduce((product, dimension) => product * dimension, 1)
      if (![1, 3, 6, 9].includes(componentCount))
        throw new Error('Mesh fields support scalar, vector and stress tensor values.')
      const pointValues = Float64Array.from({ length: points.size }, (_, index) => Number(points.at(index)))
      const valueValues = Float64Array.from({ length: values.size }, (_, index) => Number(values.at(index)))
      if (!pointValues.every(Number.isFinite) || !valueValues.every(Number.isFinite))
        throw new Error('Mesh field contains non-finite coordinates or values.')
      const connectivity = Uint32Array.from({ length: cells.size }, (_, index) => {
        const node = Number(cells.at(index))
        if (!Number.isSafeInteger(node) || node < 0 || node >= points.shape[0])
          throw new Error('Mesh connectivity references an absent node.')
        return node
      })
      const faces = new Map<string, { nodes: number[]; cell: number; count: number }>()
      for (let cell = 0; cell < cells.shape[0]; cell += 1) {
        for (const face of tetFaces) {
          const nodes = face.map((vertex) => connectivity[cell * 4 + vertex])
          const key = [...nodes].sort((a, b) => a - b).join(',')
          const existing = faces.get(key)
          if (existing) existing.count += 1
          else faces.set(key, { nodes, cell, count: 1 })
        }
      }
      const declaredBoundary = readField('domain.metadata.boundaryFaces')
      if (declaredBoundary && (declaredBoundary.shape.length !== 2 || declaredBoundary.shape[1] !== 3))
        throw new Error('Recorded boundary faces must have shape B×3.')
      const boundary = declaredBoundary
        ? Array.from({ length: declaredBoundary.shape[0] }, (_, index) => {
            const nodes = [0, 1, 2].map((axis) => Number(declaredBoundary.get([index, axis])))
            const face = faces.get([...nodes].sort((a, b) => a - b).join(','))
            if (!face) throw new Error('Recorded boundary face is not part of the volume mesh.')
            return { nodes, cell: face.cell }
          })
        : [...faces.values()].filter((face) => face.count === 1)
      const regionIds = readField('domain.metadata.regionIds')
      const regions = readField('domain.metadata.cellRegions')
      const supports = readField('domain.metadata.supportNodes')
      const loadPoints = readField('domain.metadata.loadPoints')
      const loadVectors = readField('domain.metadata.loadVectors')
      const components = readField('components')
      if (regions && (regions.shape.length !== 1 || regions.size !== cells.shape[0]))
        throw new Error('Material region codes must match the volume cells.')
      for (let index = 0; index < (regions?.size ?? 0); index += 1) {
        const region = Number(regions!.at(index))
        if (!Number.isSafeInteger(region) || region < 0 || region >= (regionIds?.size ?? 1))
          throw new Error('Material region code references an absent region.')
      }
      for (let index = 0; index < (supports?.size ?? 0); index += 1) {
        const node = Number(supports!.at(index))
        if (!Number.isSafeInteger(node) || node < 0 || node >= points.shape[0])
          throw new Error('Recorded support references an absent node.')
      }
      if (Boolean(loadPoints) !== Boolean(loadVectors) || loadPoints?.size !== loadVectors?.size)
        throw new Error('Recorded load points and vectors must have matching shapes.')
      for (const loads of [loadPoints, loadVectors]) {
        if (!loads) continue
        if (loads.shape.length !== 2 || loads.shape[1] !== 3)
          throw new Error('Recorded load points and vectors must have shape L×3.')
        for (let index = 0; index < loads.size; index += 1)
          if (!Number.isFinite(Number(loads.at(index)))) throw new Error('Recorded loads contain non-finite values.')
      }
      if (components && components.size !== componentCount)
        throw new Error('Recorded component labels do not match the field values.')
      if (semantic.valueKind === 'displacement') {
        if (location !== 'node' || componentCount !== 3)
          throw new Error('Deformation requires three displacement components at every node.')
        convertUcumValue(
          1,
          String(readField('valueUnit')?.at(0)) as UcumUnit,
          String(readField('domain.lengthUnit')?.at(0)) as UcumUnit,
          'Recorded displacement',
        )
      }
      const nodeIdsTensor = semantic.nodeIdsPath ? read(semantic.nodeIdsPath) : undefined
      if (
        nodeIdsTensor &&
        (nodeIdsTensor.shape.length !== 1 ||
          Array.from({ length: nodeIdsTensor.size }, (_, index) => Number(nodeIdsTensor.at(index))).some(
            (value) => !Number.isInteger(value) || value < -2147483648 || value > 2147483647,
          ))
      )
        throw new Error('Recorded node IDs must be int32 identifiers.')
      const nodeIds = nodeIdsTensor
        ? Int32Array.from({ length: nodeIdsTensor.size }, (_, index) => Number(nodeIdsTensor.at(index)))
        : undefined
      if (
        semantic.nodeIdsPath &&
        (!nodeIds || nodeIds.length !== points.shape[0] || new Set(nodeIds).size !== nodeIds.length)
      )
        throw new Error('Recorded node IDs must uniquely identify every mesh point.')
      let times: Float64Array | undefined
      let historyValues: Float64Array | undefined
      let timeUnit: UcumUnit | undefined
      if (semantic.time) {
        const timeline = read(semantic.time.path)
        const history = read(semantic.valuePath ?? 'values')
        const { axis: timeAxis, nodeAxis, componentAxis } = semantic.time
        if (
          !timeline ||
          !history ||
          timeline.shape.length !== 1 ||
          !timeline.size ||
          history.shape.length !== 3 ||
          new Set([timeAxis, nodeAxis, componentAxis]).size !== 3 ||
          history.shape[timeAxis] !== timeline.size ||
          history.shape[nodeAxis] !== count ||
          history.shape[componentAxis] !== 3 ||
          !nodeIds ||
          location !== 'node' ||
          semantic.valueKind !== 'displacement'
        )
          throw new Error('Animation requires a complete time × mesh node × displacement component history.')
        timeUnit = byLabel.get(`${label}.${semantic.time.path}`)?.result.unit as UcumUnit
        convertUcumValue(1, timeUnit, 's', 'Animation time')
        times = Float64Array.from({ length: timeline.size }, (_, index) => Number(timeline.at(index)))
        if (!times.every((value, index) => Number.isFinite(value) && (index === 0 || value > times![index - 1])))
          throw new Error('Animation times must be finite and strictly increasing.')
        const recordedNodes = history.tensor.axes?.[nodeAxis]?.ticks
        if (
          recordedNodes &&
          (recordedNodes.length !== nodeIds.length || recordedNodes.some((id, index) => Number(id) !== nodeIds[index]))
        )
          throw new Error('Animation node coordinates do not match the reference mesh IDs.')
        const historyUnit = byLabel.get(`${label}.${semantic.valuePath ?? 'values'}`)?.result.unit as UcumUnit
        const historyScale = convertUcumValue(
          1,
          historyUnit,
          String(readField('valueUnit')?.at(0)) as UcumUnit,
          'Animation values',
        )
        historyValues = Float64Array.from({ length: history.size }, (_, index) => {
          const indices = [0, 0, 0]
          indices[timeAxis] = Math.floor(index / (count * 3))
          indices[nodeAxis] = Math.floor(index / 3) % count
          indices[componentAxis] = index % 3
          return Number(history.get(indices)) * historyScale
        })
        if (!historyValues.every(Number.isFinite)) throw new Error('Animation contains non-finite displacements.')
      }
      fields.push(
        Object.freeze({
          label,
          task: contracts[label].task,
          coordinateSpace: semantic.coordinateSpace,
          nodeIds,
          times,
          timeUnit,
          historyValues,
          identity: String(readField('domain.identity')?.at(0) ?? label),
          lengthUnit: String(readField('domain.lengthUnit')?.at(0) ?? 'm') as UcumUnit,
          valueUnit: String(
            readField('valueUnit')?.at(0) ?? byLabel.get(`${label}.values`)?.result.unit ?? '1',
          ) as UcumUnit,
          quantity: String(readField('quantity')?.at(0) ?? ''),
          valueKind: contracts[label].visualization.valueKind,
          location,
          points: pointValues,
          cells: connectivity,
          values: valueValues,
          componentCount,
          components:
            contracts[label].visualization.components ??
            (components
              ? Array.from({ length: components.size }, (_, index) => String(components.at(index)))
              : Array.from({ length: componentCount }, (_, index) => String(index))),
          boundaryFaces: Uint32Array.from(boundary.flatMap((face) => face.nodes)),
          boundaryCells: Uint32Array.from(boundary.map((face) => face.cell)),
          cellRegions: Uint32Array.from({ length: cells.shape[0] }, (_, index) => Number(regions?.at(index) ?? 0)),
          regionIds: regionIds
            ? Array.from({ length: regionIds.size }, (_, index) => String(regionIds.at(index)))
            : ['Body'],
          supportNodes: Uint32Array.from({ length: supports?.size ?? 0 }, (_, index) => Number(supports!.at(index))),
          loadPoints: Float64Array.from({ length: loadPoints?.size ?? 0 }, (_, index) => Number(loadPoints!.at(index))),
          loadVectors: Float64Array.from({ length: loadVectors?.size ?? 0 }, (_, index) =>
            Number(loadVectors!.at(index)),
          ),
        }),
      )
    } catch (error) {
      errors.push({ label, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { fields, errors, labels }
}

type MeshVertex = { point: number[]; value: number }

/** Builds cut surfaces directly from recorded tetrahedra; chunks never require 32-bit WebGL indices. */
export function createMeshFieldRenderData(
  field: RecordedMeshField,
  view: MeshFieldView,
  displayUnit = field.lengthUnit,
  displacement: RecordedMeshField | undefined = field.valueKind === 'displacement' ? field : undefined,
  range?: readonly [number, number],
  topology?: readonly MeshRenderGeometry[],
) {
  const lengthScale = convertUcumValue(1, field.lengthUnit, displayUnit, 'Mesh display length')
  const displacementScale =
    displacement?.componentCount === 3 && displacement.location === 'node' && displacement.valueKind === 'displacement'
      ? convertUcumValue(1, displacement.valueUnit, displayUnit, 'Mesh displacement') * view.deformationScale
      : 0
  const points = Float64Array.from(
    field.points,
    (coordinate, index) =>
      coordinate * lengthScale + (displacementScale ? displacement!.values[index] * displacementScale : 0),
  )
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  for (let index = 0; index < points.length; index += 1) {
    bounds.min[index % 3] = Math.min(bounds.min[index % 3], points[index])
    bounds.max[index % 3] = Math.max(bounds.max[index % 3], points[index])
  }
  const scalars = Float64Array.from({ length: field.values.length / field.componentCount }, (_, row) => {
    const start = row * field.componentCount
    if (typeof view.component === 'number') return field.values[start + view.component]
    if (view.component === 'vonMises' && (field.componentCount === 6 || field.componentCount === 9)) {
      const [xx, yy, zz, xy, yz, xz] = (field.componentCount === 6 ? [0, 1, 2, 3, 4, 5] : [0, 4, 8, 1, 5, 2]).map(
        (index) => field.values[start + index],
      )
      return Math.sqrt(((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) / 2 + 3 * (xy ** 2 + yz ** 2 + xz ** 2))
    }
    let squared = 0
    for (let component = 0; component < field.componentCount; component += 1)
      squared += field.values[start + component] ** 2 * (field.componentCount === 6 && component >= 3 ? 2 : 1)
    return field.componentCount === 1 ? field.values[start] : Math.sqrt(squared)
  })
  let minimum = Infinity
  let maximum = -Infinity
  scalars.forEach((value) => {
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
  })
  if (range) [minimum, maximum] = range
  const axis = view.clipAxis
  const cut = axis < 0 ? Infinity : bounds.min[axis] + (bounds.max[axis] - bounds.min[axis]) * view.clipFraction
  const geometries: MeshRenderGeometry[] = []
  const buffers = {
    triangles: { positions: [] as number[], colors: [] as number[], indices: [] as number[] },
    lines: { positions: [] as number[], colors: [] as number[], indices: [] as number[] },
  }
  const flush = (primitive: 'triangles' | 'lines') => {
    const buffer = buffers[primitive]
    if (!buffer.indices.length) return
    geometries.push({
      primitive,
      positions: Float32Array.from(buffer.positions),
      colors: Float32Array.from(buffer.colors),
      indices:
        topology?.[geometries.length]?.indices.length === buffer.indices.length
          ? topology[geometries.length].indices
          : Uint16Array.from(buffer.indices),
    })
    buffer.positions = []
    buffer.colors = []
    buffer.indices = []
  }
  const emit = (
    primitive: 'triangles' | 'lines',
    vertices: readonly MeshVertex[],
    region: number,
    fixedColor?: readonly number[],
  ) => {
    const buffer = buffers[primitive]
    if (buffer.positions.length / 3 + vertices.length > 65_535) flush(primitive)
    for (const vertex of vertices) {
      const t = maximum === minimum ? 0.5 : (vertex.value - minimum) / (maximum - minimum)
      const material = meshMaterialColors[region % meshMaterialColors.length]
      const color =
        fixedColor ??
        (view.component === 'material'
          ? [1, 3, 5].map((offset) => parseInt(material.slice(offset, offset + 2), 16) / 255)
          : [Math.min(1, Math.max(0, 3 * t - 1)), Math.min(1, 3 * t, 3 * (1 - t)), Math.min(1, Math.max(0, 2 - 3 * t))])
      buffer.indices.push(buffer.positions.length / 3)
      buffer.positions.push(...vertex.point)
      buffer.colors.push(...color, 1)
    }
  }
  const vertex = (node: number, cell: number): MeshVertex => ({
    point: [points[node * 3], points[node * 3 + 1], points[node * 3 + 2]],
    value: scalars[field.location === 'node' ? node : cell],
  })
  const interpolate = (a: MeshVertex, b: MeshVertex): MeshVertex => {
    const t = (cut - a.point[axis]) / (b.point[axis] - a.point[axis])
    return {
      point: a.point.map((coordinate, index) => coordinate + t * (b.point[index] - coordinate)),
      value: a.value + t * (b.value - a.value),
    }
  }
  const emitPolygon = (polygon: readonly MeshVertex[], cell: number) => {
    const region = field.cellRegions[cell]
    for (let index = 1; index < polygon.length - 1; index += 1)
      emit('triangles', [polygon[0], polygon[index], polygon[index + 1]], region)
    if (view.wireframe)
      for (let index = 0; index < polygon.length; index += 1)
        emit('lines', [polygon[index], polygon[(index + 1) % polygon.length]], region, [0.13, 0.17, 0.23])
  }
  for (let face = 0; face < field.boundaryCells.length; face += 1) {
    const cell = field.boundaryCells[face]
    const triangle = [0, 1, 2].map((index) => vertex(field.boundaryFaces[face * 3 + index], cell))
    if (axis < 0) {
      emitPolygon(triangle, cell)
      continue
    }
    const polygon: MeshVertex[] = []
    for (let index = 0; index < triangle.length; index += 1) {
      const a = triangle[index]
      const b = triangle[(index + 1) % triangle.length]
      if (a.point[axis] <= cut) polygon.push(a)
      if ((a.point[axis] < cut && b.point[axis] > cut) || (a.point[axis] > cut && b.point[axis] < cut))
        polygon.push(interpolate(a, b))
    }
    if (polygon.length >= 3) emitPolygon(polygon, cell)
  }
  if (axis >= 0) {
    for (let cell = 0; cell < field.cells.length / 4; cell += 1) {
      const vertices = [0, 1, 2, 3].map((index) => vertex(field.cells[cell * 4 + index], cell))
      if (!vertices.some((item) => item.point[axis] < cut) || !vertices.some((item) => item.point[axis] > cut)) continue
      const intersections: MeshVertex[] = vertices.filter((item) => item.point[axis] === cut)
      for (const [left, right] of tetEdges) {
        const a = vertices[left],
          b = vertices[right]
        if ((a.point[axis] < cut && b.point[axis] > cut) || (a.point[axis] > cut && b.point[axis] < cut))
          intersections.push(interpolate(a, b))
      }
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3
      const center = [u, v].map(
        (coordinate) => intersections.reduce((sum, item) => sum + item.point[coordinate], 0) / intersections.length,
      )
      intersections.sort(
        (a, b) =>
          Math.atan2(a.point[v] - center[1], a.point[u] - center[0]) -
          Math.atan2(b.point[v] - center[1], b.point[u] - center[0]),
      )
      emitPolygon(intersections, cell)
    }
  }
  if (view.compareOriginal && displacementScale) {
    for (let face = 0; face < field.boundaryCells.length; face++) {
      const triangle = [0, 1, 2].map((index) => {
        const node = field.boundaryFaces[face * 3 + index]
        return { point: [0, 1, 2].map((axis) => field.points[node * 3 + axis] * lengthScale), value: 0 }
      })
      for (let edge = 0; edge < 3; edge++)
        emit('lines', [triangle[edge], triangle[(edge + 1) % 3]], 0, [0.55, 0.55, 0.55])
    }
  }
  if (view.overlays) {
    const size = Math.hypot(...bounds.max.map((maximum, index) => maximum - bounds.min[index])) * 0.012
    for (const node of field.supportNodes) {
      const center = vertex(node, 0)
      if (axis >= 0 && center.point[axis] > cut) continue
      for (let coordinate = 0; coordinate < 3; coordinate += 1) {
        const a = { ...center, point: [...center.point] },
          b = { ...center, point: [...center.point] }
        a.point[coordinate] -= size
        b.point[coordinate] += size
        emit('lines', [a, b], 0, [0.05, 0.65, 0.35])
      }
    }
    for (let index = 0; index < field.loadPoints.length / 3; index += 1) {
      const point = [0, 1, 2].map((coordinate) => field.loadPoints[index * 3 + coordinate] * lengthScale)
      if (axis >= 0 && point[axis] > cut) continue
      const direction = [0, 1, 2].map((coordinate) => field.loadVectors[index * 3 + coordinate])
      const norm = Math.hypot(...direction)
      if (!norm) {
        // A pure couple still has an applied-load location, but no force direction.
        for (let coordinate = 0; coordinate < 3; coordinate += 1) {
          const a = { point: [...point], value: 0 }
          const b = { point: [...point], value: 0 }
          a.point[coordinate] -= size
          b.point[coordinate] += size
          emit('lines', [a, b], 0, [0.9, 0.15, 0.1])
        }
        continue
      }
      const end = point.map((coordinate, component) => coordinate + (direction[component] / norm) * size * 6)
      emit(
        'lines',
        [
          { point, value: 0 },
          { point: end, value: 0 },
        ],
        0,
        [0.9, 0.15, 0.1],
      )
      const normal =
        Math.abs(direction[2] / norm) < 0.9
          ? [-direction[1] / norm, direction[0] / norm, 0]
          : [0, -direction[2] / norm, direction[1] / norm]
      for (const side of [-1, 1]) {
        const wing = end.map(
          (coordinate, component) =>
            coordinate - (direction[component] / norm) * size * 1.7 + normal[component] * size * side,
        )
        emit(
          'lines',
          [
            { point: end, value: 0 },
            { point: wing, value: 0 },
          ],
          0,
          [0.9, 0.15, 0.1],
        )
      }
    }
  }
  flush('triangles')
  flush('lines')
  return { geometries, bounds, minimum, maximum, cut }
}
