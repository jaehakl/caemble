import { assertBoxGridData } from '@/contracts/boxGrid'
import type { CalculationAxis, CalculationInputLeaf } from './types'

export const projectionAxes = ['x', 'y', 'z', 'time', 'frequency'] as const
export type ProjectionAxis = (typeof projectionAxes)[number]
export type ProjectionReduction = {
  method: 'sum' | 'mean' | 'min' | 'max' | 'median' | 'std' | 'index'
  index?: number
}
export type BoxGridProjectionOptions = Readonly<{
  axes: readonly ProjectionAxis[]
  representation?: 'amplitude' | 'phase'
  component?: number | 'magnitude'
  reduce?: Partial<Record<ProjectionAxis, ProjectionReduction>>
  frame?: { phase?: number; axis?: 'time' | 'frequency'; index?: number }
}>
export type ProjectionData = number | readonly ProjectionData[]
export type BoxGridProjection = Readonly<{ dtype: 'float64'; data: ProjectionData; axes: readonly CalculationAxis[] }>

/** Channel/component projection precedes reductions, in canonical x/y/z/time/frequency order. */
export function projectBoxGrid(leaf: CalculationInputLeaf, options: BoxGridProjectionOptions): BoxGridProjection {
  assertBoxGridData(leaf.boxGrid, leaf.shape)
  const kept = options.axes.map((axis) => projectionAxes.indexOf(axis))
  if (kept.some((axis) => axis < 0) || new Set(kept).size !== kept.length)
    throw new Error('표시 축은 중복 없이 x/y/z/time/frequency에서 선택하세요.')
  const representation = options.representation ?? 'amplitude'
  const component = options.component ?? (leaf.shape[6] === 1 ? 0 : 'magnitude')
  if (!['amplitude', 'phase'].includes(representation)) throw new Error('지원하지 않는 채널입니다.')
  if (component !== 'magnitude' && (!Number.isSafeInteger(component) || component < 0 || component >= leaf.shape[6]))
    throw new Error('성분 index가 범위를 벗어났습니다.')
  if (representation === 'phase' && (leaf.shape[5] !== 2 || component === 'magnitude'))
    throw new Error('Phase는 진폭·위상 입력의 성분 하나를 선택해야 합니다.')
  const frame = options.frame
  if (frame?.phase !== undefined && (!Number.isFinite(frame.phase) || leaf.shape[5] !== 2))
    throw new Error('진동 재생에는 유한한 위상과 진폭·위상 채널이 필요합니다.')
  if (frame?.axis !== undefined && !['time', 'frequency'].includes(frame.axis))
    throw new Error('순회 축은 time 또는 frequency여야 합니다.')
  const lengths = leaf.shape.slice(0, 5)
  const indices = [0, 0, 0, 0, 0]
  const selected = new Map<number, number>()
  for (let axis = 0; axis < 5; axis++) {
    const reduction = options.reduce?.[projectionAxes[axis]]
    if (reduction && !['sum', 'mean', 'min', 'max', 'median', 'std', 'index'].includes(reduction.method))
      throw new Error('지원하지 않는 집계 방식입니다.')
    const index =
      frame?.axis === projectionAxes[axis]
        ? frame.index
        : !kept.includes(axis) && reduction?.method === 'index'
          ? reduction.index
          : undefined
    if (
      (frame?.axis === projectionAxes[axis] || (!kept.includes(axis) && reduction?.method === 'index')) &&
      (index === undefined || !Number.isSafeInteger(index) || index < 0 || index >= lengths[axis])
    )
      throw new Error(`${projectionAxes[axis]} index가 범위를 벗어났습니다.`)
    if (index !== undefined) {
      selected.set(axis, index)
      lengths[axis] = 1
    }
    const ticks = leaf.axes[axis]?.ticks
    if (
      !ticks ||
      ticks.length !== leaf.shape[axis] ||
      ticks.some((tick) => typeof tick !== 'number' || !Number.isFinite(tick))
    )
      throw new Error('Box Grid 축에는 유한한 숫자 좌표가 필요합니다.')
  }
  if (leaf.data.length !== leaf.shape.reduce((a, b) => a * b, 1))
    throw new Error('Box Grid 데이터 크기가 shape와 다릅니다.')
  let values = new Float64Array(lengths.reduce((a, b) => a * b, 1))
  for (let flat = 0; flat < values.length; flat++) {
    let position = flat
    for (let axis = 4; axis >= 0; axis--) {
      indices[axis] = selected.get(axis) ?? position % lengths[axis]
      position = Math.floor(position / lengths[axis])
    }
    const offset =
      indices.reduce((total, index, axis) => total * leaf.shape[axis] + index, 0) * leaf.shape[5] * leaf.shape[6]
    let squared = 0
    for (let c = 0; c < leaf.shape[6]; c++) {
      if (component !== 'magnitude' && c !== component) continue
      const amplitude = leaf.data[offset + c]
      const phase = leaf.shape[5] === 2 ? leaf.data[offset + leaf.shape[6] + c] : 0
      const value =
        frame?.phase !== undefined
          ? amplitude * Math.cos(phase + (leaf.axes[4].ticks[indices[4]] === 0 ? 0 : frame.phase))
          : representation === 'phase'
            ? phase
            : amplitude
      if (!Number.isFinite(value)) throw new Error('Box Grid에 유한하지 않은 값이 있습니다.')
      if (component === 'magnitude') squared += value * value
      else values[flat] = value
    }
    if (component === 'magnitude') values[flat] = Math.sqrt(squared)
  }
  for (let axis = 0; axis < 5; axis++) {
    if (kept.includes(axis)) continue
    const method = selected.has(axis) ? 'index' : (options.reduce?.[projectionAxes[axis]]?.method ?? 'mean')
    const length = lengths[axis]
    const stride = lengths.slice(axis + 1).reduce((a, b) => a * b, 1)
    const next = new Float64Array(values.length / length)
    for (let flat = 0; flat < next.length; flat++) {
      const base = Math.floor(flat / stride) * length * stride + (flat % stride)
      let mean = 0,
        m2 = 0,
        total = 0,
        minimum = Infinity,
        maximum = -Infinity
      const sorted: number[] = []
      for (let i = 0; i < length; i++) {
        const value = values[base + i * stride]
        total += value
        minimum = Math.min(minimum, value)
        maximum = Math.max(maximum, value)
        const delta = value - mean
        mean += delta / (i + 1)
        m2 += delta * (value - mean)
        if (method === 'median') sorted.push(value)
      }
      if (method === 'median') sorted.sort((a, b) => a - b)
      next[flat] =
        method === 'sum'
          ? total
          : method === 'min'
            ? minimum
            : method === 'max'
              ? maximum
              : method === 'std'
                ? Math.sqrt(Math.max(0, m2 / length))
                : method === 'median'
                  ? (sorted[Math.floor((length - 1) / 2)] + sorted[Math.floor(length / 2)]) / 2
                  : mean
    }
    values = next
    lengths[axis] = 1
  }
  const strides = lengths.map((_, axis) => lengths.slice(axis + 1).reduce((a, b) => a * b, 1))
  const build = (depth: number, offset: number): ProjectionData => {
    if (depth === kept.length) {
      if (!Number.isFinite(values[offset])) throw new Error('집계 결과가 유한한 숫자 범위를 벗어났습니다.')
      return values[offset]
    }
    const axis = kept[depth]
    return Array.from({ length: lengths[axis] }, (_, i) => build(depth + 1, offset + i * strides[axis]))
  }
  return {
    dtype: 'float64',
    data: build(0, 0),
    axes: kept.map((axis) => ({
      ...leaf.axes[axis],
      ticks: (selected.has(axis)
        ? [leaf.axes[axis].ticks[selected.get(axis)!]]
        : leaf.axes[axis].ticks) as readonly number[],
    })),
  }
}

export const boxGrid = Object.freeze({ project: projectBoxGrid })

export function projectionCode(
  recordReference: string,
  options: BoxGridProjectionOptions,
  vectorComponents?: readonly number[],
) {
  return vectorComponents
    ? [...vectorComponents, 'magnitude' as const]
        .map(
          (component, index) =>
            `boxGrid.project(${recordReference}, ${JSON.stringify({ ...options, component })}) // ${index < 3 ? ['X', 'Y', 'Z'][index] : '벡터 크기'}`,
        )
        .join('\n')
    : `boxGrid.project(${recordReference}, ${JSON.stringify(options)})`
}
