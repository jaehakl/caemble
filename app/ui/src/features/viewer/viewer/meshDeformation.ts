import { convertUcumValue, type UcumUnit } from '@/lib/cad/model'
import type { RecordedMeshField, MeshFieldView } from './meshFields'

/** Returns displacement in the target mesh's node order, only for the same recorded domain. */
export function matchMeshDisplacement(field: RecordedMeshField, candidate: RecordedMeshField) {
  if (
    candidate.valueKind !== 'displacement' ||
    candidate.times ||
    Boolean(field.spectrum) !== Boolean(candidate.spectrum) ||
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
    field.cells.length !== candidate.cells.length ||
    (field.cellType ?? 'tet4') !== (candidate.cellType ?? 'tet4')
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
    const reorder = (values: Float64Array) =>
      Float64Array.from(
        { length: values.length },
        (_, index) =>
          values[
            Math.floor(index / field.points.length) * field.points.length +
              order[Math.floor(index / 3) % order.length] * 3 +
              (index % 3)
          ],
      )
    return {
      ...candidate,
      points: field.points,
      cells: field.cells,
      lengthUnit: field.lengthUnit,
      nodeIds: field.nodeIds,
      values: reorder(candidate.values),
      spectrum: candidate.spectrum
        ? { ...candidate.spectrum, imaginaryValues: reorder(candidate.spectrum.imaginaryValues) }
        : undefined,
    }
  } catch {
    return undefined
  }
}

/** One scale for the whole history; display magnification never changes stored values. */
export function automaticDeformationScale(field: RecordedMeshField, frequencyHz?: number) {
  const lower = [Infinity, Infinity, Infinity],
    upper = [-Infinity, -Infinity, -Infinity]
  field.points.forEach((value, index) => {
    lower[index % 3] = Math.min(lower[index % 3], value)
    upper[index % 3] = Math.max(upper[index % 3], value)
  })
  const values = field.historyValues ?? field.values
  let maximum = 0
  if (field.spectrum) {
    const offset = frequencyOffset(field, frequencyHz)
    for (let index = offset; index < offset + field.points.length; index += 3) {
      let realSquared = 0,
        imaginarySquared = 0,
        product = 0
      for (let component = 0; component < 3; component++) {
        const real = values[index + component],
          imaginary = field.spectrum.imaginaryValues[index + component]
        realSquared += real * real
        imaginarySquared += imaginary * imaginary
        product += real * imaginary
      }
      maximum = Math.max(
        maximum,
        Math.sqrt((realSquared + imaginarySquared + Math.hypot(realSquared - imaginarySquared, 2 * product)) / 2),
      )
    }
  } else {
    for (let index = 0; index < values.length; index += 3)
      maximum = Math.max(maximum, Math.hypot(values[index], values[index + 1], values[index + 2]))
  }
  const physicalMaximum = maximum * convertUcumValue(1, field.valueUnit, field.lengthUnit, 'Deformation scale')
  return physicalMaximum > 0
    ? (Math.hypot(...upper.map((value, index) => value - lower[index])) * 0.1) / physicalMaximum
    : 1
}

function frequencyOffset(field: RecordedMeshField, frequencyHz: number | undefined) {
  const index = frequencyHz === undefined ? -1 : (field.spectrum?.frequencies.indexOf(frequencyHz) ?? -1)
  if (index < 0)
    throw new Error(`선택한 주파수 ${frequencyHz ?? ''} Hz가 이 결과에 없습니다. 보간 없이 계산된 주파수를 선택하세요.`)
  return index * (field.values.length / field.spectrum!.frequencies.length)
}

/** The source remains a complete phasor sweep; rendering receives one explicitly selected real state. */
export function meshHarmonicAtPhase(
  field: RecordedMeshField,
  frequencyHz: number,
  phaseDegrees: number,
): RecordedMeshField {
  if (!field.spectrum) return field
  const offset = frequencyOffset(field, frequencyHz)
  if (!Number.isFinite(phaseDegrees) || phaseDegrees < 0 || phaseDegrees > 360)
    throw new Error('표시 위상은 0°부터 360°까지여야 합니다.')
  const phase = (phaseDegrees * Math.PI) / 180
  const count = field.values.length / field.spectrum.frequencies.length
  return {
    ...field,
    spectrum: undefined,
    values: Float64Array.from(
      { length: count },
      (_, index) =>
        field.values[offset + index] * Math.cos(phase) -
        field.spectrum!.imaginaryValues[offset + index] * Math.sin(phase),
    ),
  }
}

/** A frequency's full phase envelope keeps scale and camera fixed while phase changes. */
export function meshHarmonicBounds(
  field: RecordedMeshField,
  frequencyHz: number,
  scale: number,
  displayUnit: UcumUnit,
) {
  const offset = frequencyOffset(field, frequencyHz)
  const lengthScale = convertUcumValue(1, field.lengthUnit, displayUnit, 'Harmonic coordinates')
  const deformationScale =
    field.valueKind === 'displacement'
      ? scale * convertUcumValue(1, field.valueUnit, displayUnit, 'Harmonic displacement')
      : 0
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < field.points.length; index++) {
    const original = field.points[index] * lengthScale
    const amplitude = deformationScale
      ? Math.hypot(field.values[offset + index], field.spectrum!.imaginaryValues[offset + index]) * deformationScale
      : 0
    min[index % 3] = Math.min(min[index % 3], original - amplitude)
    max[index % 3] = Math.max(max[index % 3], original + amplitude)
  }
  return { min, max }
}

export function meshHarmonicRange(
  field: RecordedMeshField,
  frequencyHz: number,
  component: MeshFieldView['component'],
) {
  const offset = frequencyOffset(field, frequencyHz)
  const count = field.values.length / field.spectrum!.frequencies.length
  const signed = typeof component === 'number' || field.componentCount === 1
  const squaredValue = (values: number[]) => {
    if (component === 'vonMises') {
      const [xx, yy, zz, xy, yz, xz] = (values.length === 6 ? [0, 1, 2, 3, 4, 5] : [0, 4, 8, 1, 5, 2]).map(
        (index) => values[index],
      )
      return ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) / 2 + 3 * (xy ** 2 + yz ** 2 + xz ** 2)
    }
    return values.reduce((sum, value, index) => sum + value ** 2 * (values.length === 6 && index >= 3 ? 2 : 1), 0)
  }
  let maximum = 0
  for (let index = offset; index < offset + count; index += field.componentCount) {
    if (signed) {
      const position = index + (typeof component === 'number' ? component : 0)
      maximum = Math.max(maximum, Math.hypot(field.values[position], field.spectrum!.imaginaryValues[position]))
    } else {
      const real = Array.from(field.values.subarray(index, index + field.componentCount))
      const imaginary = Array.from(field.spectrum!.imaginaryValues.subarray(index, index + field.componentCount))
      const a = squaredValue(real),
        b = squaredValue(imaginary)
      const cross = (squaredValue(real.map((value, i) => value + imaginary[i])) - a - b) / 2
      maximum = Math.max(maximum, Math.sqrt((a + b + Math.hypot(a - b, 2 * cross)) / 2))
    }
  }
  return [signed ? -maximum : 0, maximum] as const
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
