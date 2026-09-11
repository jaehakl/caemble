import { convertUcumValue, type UcumUnit } from '@/lib/cad/model'
import type { RecordedMeshField, MeshFieldView } from './meshFields'

/** Returns displacement in the target mesh's node order, only for the same recorded domain. */
export function matchMeshDisplacement(field: RecordedMeshField, candidate: RecordedMeshField) {
  if (
    candidate.valueKind !== 'displacement' ||
    candidate.times ||
    candidate.location !== 'node' ||
    candidate.componentCount !== 3 ||
    !field.task ||
    field.task !== candidate.task ||
    field.identity !== candidate.identity ||
    !field.coordinateSpace ||
    field.coordinateSpace !== candidate.coordinateSpace ||
    !field.nodeIds ||
    !candidate.nodeIds ||
    field.nodeIds.length !== candidate.nodeIds.length ||
    field.cells.length !== candidate.cells.length
  )
    return undefined
  try {
    const scale = convertUcumValue(1, candidate.lengthUnit, field.lengthUnit, 'Displacement mesh coordinates')
    convertUcumValue(1, candidate.valueUnit, field.lengthUnit, 'Displacement units')
    const lookup = new Map(Array.from(candidate.nodeIds, (id, index) => [id, index]))
    const order = Array.from(field.nodeIds, (id) => lookup.get(id) ?? -1)
    if (order.includes(-1)) return undefined
    if (!field.cells.every((node, index) => field.nodeIds![node] === candidate.nodeIds![candidate.cells[index]]))
      return undefined
    if (
      !field.points.every((value, index) => {
        const other = candidate.points[order[Math.floor(index / 3)] * 3 + (index % 3)] * scale
        return Math.abs(value - other) <= Math.max(Math.abs(value), Math.abs(other), Number.MIN_VALUE) * 1e-10
      })
    )
      return undefined
    return {
      ...candidate,
      points: field.points,
      cells: field.cells,
      lengthUnit: field.lengthUnit,
      nodeIds: field.nodeIds,
      values: Float64Array.from(
        { length: field.points.length },
        (_, index) => candidate.values[order[Math.floor(index / 3)] * 3 + (index % 3)],
      ),
    }
  } catch {
    return undefined
  }
}

/** One scale for the whole history; display magnification never changes stored values. */
export function automaticDeformationScale(field: RecordedMeshField) {
  const lower = [Infinity, Infinity, Infinity],
    upper = [-Infinity, -Infinity, -Infinity]
  field.points.forEach((value, index) => {
    lower[index % 3] = Math.min(lower[index % 3], value)
    upper[index % 3] = Math.max(upper[index % 3], value)
  })
  const values = field.historyValues ?? field.values
  let maximum = 0
  for (let index = 0; index < values.length; index += 3)
    maximum = Math.max(maximum, Math.hypot(values[index], values[index + 1], values[index + 2]))
  const physicalMaximum = maximum * convertUcumValue(1, field.valueUnit, field.lengthUnit, 'Deformation scale')
  return physicalMaximum > 0
    ? (Math.hypot(...upper.map((value, index) => value - lower[index])) * 0.1) / physicalMaximum
    : 1
}

export function meshFrameAtTime(times: Float64Array, time: number) {
  let low = 0,
    high = times.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (times[middle] <= time) low = middle + 1
    else high = middle
  }
  return Math.max(0, low - 1)
}

export function meshHistoryRange(field: RecordedMeshField, component: MeshFieldView['component']) {
  const values = field.historyValues ?? field.values
  let minimum = Infinity,
    maximum = -Infinity
  for (let index = 0; index < values.length; index += 3) {
    const value =
      typeof component === 'number'
        ? values[index + component]
        : Math.hypot(values[index], values[index + 1], values[index + 2])
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
  }
  return [minimum, maximum] as const
}

export function meshHistoryBounds(field: RecordedMeshField, scale: number, displayUnit: UcumUnit) {
  const coordinateScale = convertUcumValue(1, field.lengthUnit, displayUnit, 'Animation coordinates')
  const displacementScale = convertUcumValue(1, field.valueUnit, displayUnit, 'Animation displacement') * scale
  const values = field.historyValues ?? field.values
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < values.length; index++) {
    const original = field.points[index % field.points.length] * coordinateScale
    const value = original + values[index] * displacementScale
    min[index % 3] = Math.min(min[index % 3], value, original)
    max[index % 3] = Math.max(max[index % 3], value, original)
  }
  return { min, max }
}
