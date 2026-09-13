import { PCA } from 'ml-pca'
import { flattenVarsTensor, varsTensorFromFlat } from '@/lib/cad/model/tensor'
import type { Vars } from '@/lib/cad/model/types'
import type { VarsSchema } from '@/lib/cad/model/vars'

export type VarsPoint = Readonly<{ id: string; vars: Readonly<Vars> }>
export type SpaceLayout = Readonly<{ key: string; shape: readonly number[]; min: number; max: number; size: number }>
export type MeasurementProjection = Readonly<{
  layouts: readonly SpaceLayout[]
  active: readonly number[]
  mean: readonly number[]
  axes: readonly (readonly number[])[]
  variance: readonly number[]
  points: readonly Readonly<{ id: string; values: readonly number[]; xy: readonly number[] }>[]
}>

const cellLimit = 8_000_000

export function spaceLayouts(schema: VarsSchema): SpaceLayout[] {
  let total = 0
  return Object.keys(schema)
    .sort()
    .map((key) => {
      const entry = schema[key]
      if (
        !Number.isFinite(entry.min) ||
        !Number.isFinite(entry.max) ||
        entry.min > entry.max ||
        entry.shape.some((n) => !Number.isSafeInteger(n) || n < 0)
      )
        throw new Error(`${key}: 올바르지 않은 Vars schema입니다.`)
      const size = entry.shape.reduce((n, length) => n * length, 1)
      total += size
      if (!Number.isSafeInteger(total) || total > cellLimit) throw new Error('Vars가 수치 값 메모리 한도를 초과합니다.')
      return { key, ...entry, size }
    })
}

export function spaceValues(layouts: readonly SpaceLayout[], vars: Readonly<Vars>): number[] {
  return layouts.flatMap((layout) =>
    flattenVarsTensor(vars[layout.key], layout.shape, layout.key).map((value) => {
      if (!Number.isFinite(value) || value < layout.min || value > layout.max)
        throw new Error(`${layout.key}: Vars가 schema 범위를 벗어났습니다.`)
      return layout.max === layout.min ? 0 : (value - layout.min) / (layout.max - layout.min)
    }),
  )
}

export function spaceVars(layouts: readonly SpaceLayout[], values: readonly number[]): Vars {
  let offset = 0
  return Object.fromEntries(
    layouts.map((layout) => {
      const flat = values
        .slice(offset, offset + layout.size)
        .map((value) => layout.min + Math.max(0, Math.min(1, value)) * (layout.max - layout.min))
      offset += layout.size
      return [layout.key, varsTensorFromFlat(flat, layout.shape)]
    }),
  )
}

export function projectSpace(projection: MeasurementProjection, values: readonly number[]): number[] {
  return [0, 1].map(
    (axis) =>
      projection.axes[axis]?.reduce(
        (sum, weight, index) => sum + weight * (values[projection.active[index]] - projection.mean[index]),
        0,
      ) ?? 0,
  )
}

export function fitMeasurementProjection(schema: VarsSchema, points: readonly VarsPoint[]): MeasurementProjection {
  const layouts = spaceLayouts(schema)
  const size = layouts.reduce((n, layout) => n + layout.size, 0)
  if (size * points.length > cellLimit) throw new Error('PCA 데이터가 수치 값 메모리 한도를 초과합니다.')
  const values = points.map((point) => spaceValues(layouts, point.vars))
  const active: number[] = []
  let offset = 0
  for (const layout of layouts) {
    for (let index = 0; index < layout.size; index++) {
      if (layout.min !== layout.max) active.push(offset + index)
    }
    offset += layout.size
  }
  const mean = active.map((index) => values.reduce((sum, row) => sum + row[index] / Math.max(1, values.length), 0))
  const axes: number[][] = []
  const variance: number[] = []
  const hasVariance = values.some((row) => active.some((index, column) => Math.abs(row[index] - mean[column]) > 1e-12))
  if (values.length > 1 && active.length && hasVariance) {
    // SVD also supports more Vars components than observations, without a d×d covariance matrix.
    const pca = new PCA(
      values.map((row) => active.map((index) => row[index])),
      { center: true, scale: false, method: 'SVD' },
    )
    const eigenvalues = pca.getEigenvalues()
    const eigenvectors = pca.getEigenvectors()
    const explained = pca.getExplainedVariance()
    for (let axis = 0; axis < Math.min(2, eigenvalues.length); axis++) {
      if (eigenvalues[axis] <= eigenvalues[0] * 1e-12) break
      const vector = eigenvectors.getColumn(axis)
      const largest = vector.reduce(
        (best, value, index) => (Math.abs(value) > Math.abs(vector[best]) ? index : best),
        0,
      )
      axes.push(vector.map((value) => (vector[largest] < 0 ? -value : value)))
      variance.push(explained[axis])
    }
  }
  const projection: MeasurementProjection = { layouts, active, mean, axes, variance, points: [] }
  return {
    ...projection,
    points: points.map((point, index) => ({
      id: point.id,
      values: values[index],
      xy: projectSpace(projection, values[index]),
    })),
  }
}

export function varsAtProjection(projection: MeasurementProjection, target: readonly number[]): Vars {
  if (!projection.axes.length || !projection.points.length) throw new Error('PCA 방향을 계산할 데이터가 없습니다.')
  const nearest = projection.points
    .map((point) => ({
      point,
      distance: Math.hypot(...projection.axes.map((_, axis) => point.xy[axis] - target[axis])),
    }))
    .sort((a, b) => a.distance - b.distance || a.point.id.localeCompare(b.point.id, 'en'))
    .slice(0, 7)
  const exact = nearest.filter((entry) => entry.distance === 0)
  const neighbors = exact.length ? exact : nearest
  const ratios = neighbors.map((entry) => (exact.length ? 1 : nearest[0].distance / entry.distance))
  const sum = ratios.reduce((total, value) => total + value, 0)
  const base = projection.points[0].values.map((_, index) =>
    neighbors.reduce((total, entry, n) => total + (entry.point.values[index] * ratios[n]) / sum, 0),
  )
  const origin = projectSpace(projection, base)
  projection.axes.forEach((axis, index) =>
    axis.forEach((weight, component) => {
      base[projection.active[component]] += (target[index] - origin[index]) * weight
    }),
  )
  return spaceVars(projection.layouts, base)
}

export function sampleMeasurementVars(
  schema: VarsSchema,
  existing: readonly Readonly<Vars>[],
  count: number,
  algorithm: 'random' | 'empty-lhs',
  random: () => number = Math.random,
): Vars[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('N은 양의 정수여야 합니다.')
  const layouts = spaceLayouts(schema)
  const size = layouts.reduce((n, entry) => n + entry.size, 0)
  if ((existing.length + count) * size > cellLimit || count > 100_000)
    throw new Error('후보 생성이 수치 값 메모리 한도를 초과합니다.')
  const occupied = existing.map((vars) => spaceValues(layouts, vars))
  const active = layouts.flatMap((layout) => Array.from({ length: layout.size }, () => layout.min !== layout.max))
  if (!active.some(Boolean)) throw new Error('범위가 고정되지 않은 Vars 성분이 필요합니다.')
  const keys = new Set(occupied.map((row) => JSON.stringify(row)))
  let divisions = count
  let emptyByAxis: number[][] = []
  if (algorithm === 'empty-lhs') {
    while (true) {
      if (!Number.isSafeInteger(divisions) || divisions * size > cellLimit)
        throw new Error('빈 구간을 확보할 수 없습니다. N 또는 데이터 크기를 줄이세요.')
      emptyByAxis = active.map((enabled, axis) => {
        if (!enabled) return []
        const used = new Set(occupied.map((row) => Math.min(divisions - 1, Math.floor(row[axis] * divisions))))
        return Array.from({ length: divisions }, (_, index) => index).filter((index) => !used.has(index))
      })
      if (emptyByAxis.every((empty, axis) => !active[axis] || empty.length >= count)) break
      divisions *= 2
    }
  }
  const columns = active.map((enabled, axis) => {
    if (!enabled) return Array<number>(count).fill(0)
    if (algorithm === 'random') return Array.from({ length: count }, () => random())
    const empty = emptyByAxis[axis]
    const values = Array.from({ length: count }, (_, index) => {
      const start = Math.floor((index * empty.length) / count)
      const end = Math.floor(((index + 1) * empty.length) / count)
      const interval = empty[start + Math.floor(random() * (end - start))]
      return (interval + random()) / divisions
    })
    for (let index = values.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1))
      ;[values[index], values[other]] = [values[other], values[index]]
    }
    return values
  })
  return Array.from({ length: count }, (_, index) => {
    let row = columns.map((column) => column[index])
    for (let retry = 0; retry < 100; retry++) {
      const vars = spaceVars(layouts, row)
      const canonical = spaceValues(layouts, vars)
      const key = JSON.stringify(canonical)
      const inEmpty =
        algorithm !== 'empty-lhs' ||
        canonical.every(
          (value, axis) =>
            !active[axis] || emptyByAxis[axis].includes(Math.min(divisions - 1, Math.floor(value * divisions))),
        )
      if (!keys.has(key) && inEmpty) {
        keys.add(key)
        return vars
      }
      if (algorithm === 'empty-lhs')
        throw new Error('수치 정밀도 때문에 빈 구간에서 서로 다른 후보를 만들 수 없습니다.')
      row = active.map((enabled) => (enabled ? random() : 0))
    }
    throw new Error('중복되지 않는 후보를 만들 수 없습니다.')
  })
}
