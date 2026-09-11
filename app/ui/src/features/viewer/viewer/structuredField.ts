import type { ResultVisualization } from '@/contracts/solver'
import { convertUcumValue, type DataSchema, type RecordedDataTensor, type UcumUnit } from '@/lib/cad/model'
import { createDataTensorAccessor } from '@/lib/cad/model/dataTensor'
import type { MeshRenderGeometry } from './meshFields'

export type HeatmapRenderData = Readonly<{
  identity: string
  geometries: readonly MeshRenderGeometry[]
  bounds: Readonly<{ min: readonly number[]; max: readonly number[] }>
}>

export function structuredField(
  schema: DataSchema,
  tensor: RecordedDataTensor,
  semantic: ResultVisualization,
  unit: UcumUnit,
) {
  const grid = semantic.grid
  if (!grid || !semantic.components) throw new Error('기록된 공간·성분 계약이 없습니다.')
  const accessor = createDataTensorAccessor(schema, tensor)
  const axes = [...grid.xyzAxes, grid.sampleAxis, grid.componentAxis]
  if (
    accessor.shape.length !== 5 ||
    new Set(axes).size !== 5 ||
    axes.some((axis) => axis < 0 || axis >= 5) ||
    accessor.shape.some((size) => size < 1)
  )
    throw new Error('공간 tensor의 축 계약이 일치하지 않습니다.')
  if (accessor.shape[grid.componentAxis] !== semantic.components.length)
    throw new Error('기록 성분이 계약과 일치하지 않습니다.')
  const spatial = grid.xyzAxes.map((axis) => {
    const sourceUnit = schema.axes?.[axis]?.unit
    const recorded = tensor.axes?.[axis]
    if (!sourceUnit || !recorded?.ticks || recorded.ticks.length !== accessor.shape[axis])
      throw new Error('기록된 공간 좌표가 없습니다.')
    const ticks = recorded.ticks.map((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('공간 좌표가 유효하지 않습니다.')
      return convertUcumValue(value, sourceUnit, unit)
    })
    if (ticks.some((tick, index) => index > 0 && tick <= ticks[index - 1]))
      throw new Error('공간 좌표는 오름차순이어야 합니다.')
    if (!recorded.bounds) throw new Error('기록된 검출 영역이 없습니다.')
    const bounds = recorded.bounds.map((value) => convertUcumValue(value, sourceUnit, unit))
    if (
      !bounds.every(Number.isFinite) ||
      bounds[0] > ticks[0] ||
      bounds[1] < ticks[ticks.length - 1] ||
      bounds[0] >= bounds[1]
    )
      throw new Error('검출 영역과 공간 좌표가 일치하지 않습니다.')
    const edges = [bounds[0], ...ticks.slice(1).map((tick, index) => (tick + ticks[index]) / 2), bounds[1]]
    return { axis, ticks, edges }
  })
  const samples = tensor.axes?.[grid.sampleAxis]?.ticks
  const sampleUnit = schema.axes?.[grid.sampleAxis]?.unit
  if (!samples || samples.length !== accessor.shape[grid.sampleAxis] || !sampleUnit)
    throw new Error('기록된 시간·주파수 좌표가 없습니다.')
  const sampleTicks = samples.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('시간·주파수 좌표가 유효하지 않습니다.')
    return convertUcumValue(value, sampleUnit, grid.sampleKind === 'frequency' ? 'Hz' : 's')
  })
  const bounds = {
    min: spatial.map((axis) => axis.edges[0]),
    max: spatial.map((axis) => axis.edges[axis.edges.length - 1]),
  }
  return { accessor, grid, spatial, sampleTicks, bounds, components: semantic.components }
}

export function fieldScalar(
  field: ReturnType<typeof structuredField>,
  xyz: readonly number[],
  sample: number,
  component: number,
  representation: string,
): number {
  const indices = Array(5).fill(0)
  field.grid.xyzAxes.forEach((axis, index) => {
    indices[axis] = xyz[index]
  })
  indices[field.grid.sampleAxis] = sample
  let squared = 0
  for (let c = component < 0 ? 0 : component; c < (component < 0 ? field.components.length : component + 1); c++) {
    indices[field.grid.componentAxis] = c
    const value = field.accessor.get(indices)
    if (typeof value !== 'number' && typeof value !== 'object') throw new Error('장 데이터는 수치 tensor여야 합니다.')
    const re = typeof value === 'number' ? value : value.re
    const im = typeof value === 'number' ? 0 : value.im
    if (!Number.isFinite(re) || !Number.isFinite(im)) throw new Error('장 데이터에 유효하지 않은 값이 있습니다.')
    if (component >= 0) {
      if (representation === 're') return re
      if (representation === 'im') return im
      if (representation === 'arg') return re === 0 && im === 0 ? NaN : Math.atan2(im, re)
      return Math.hypot(re, im)
    }
    squared += re * re + im * im
  }
  return Math.sqrt(squared)
}

export function fieldRange(
  field: ReturnType<typeof structuredField>,
  sample: number,
  component: number,
  representation: string,
): readonly [number, number] {
  let min = Infinity,
    max = -Infinity
  for (let z = 0; z < field.spatial[2].ticks.length; z++)
    for (let y = 0; y < field.spatial[1].ticks.length; y++)
      for (let x = 0; x < field.spatial[0].ticks.length; x++) {
        const value = fieldScalar(field, [x, y, z], sample, component, representation)
        if (Number.isFinite(value)) {
          min = Math.min(min, value)
          max = Math.max(max, value)
        }
      }
  return Number.isFinite(min) ? [min, max] : [0, 0]
}

export function fieldSlice(
  field: ReturnType<typeof structuredField>,
  identity: string,
  normal: number,
  index: number,
  sample: number,
  component: number,
  representation: string,
  range: readonly [number, number],
  opacity: number,
): HeatmapRenderData {
  const [u, v] = [0, 1, 2].filter((axis) => axis !== normal)
  const geometries: MeshRenderGeometry[] = []
  let positions: number[] = [],
    colors: number[] = [],
    indices: number[] = []
  const flush = () => {
    if (!indices.length) return
    geometries.push({
      positions: new Float32Array(positions),
      colors: new Float32Array(colors),
      indices: new Uint16Array(indices),
      primitive: 'triangles',
    })
    positions = []
    colors = []
    indices = []
  }
  for (let j = 0; j < field.spatial[v].ticks.length; j++)
    for (let i = 0; i < field.spatial[u].ticks.length; i++) {
      const xyz = [0, 0, 0]
      xyz[normal] = index
      xyz[u] = i
      xyz[v] = j
      const value = fieldScalar(field, xyz, sample, component, representation)
      if (!Number.isFinite(value)) continue // Zero-amplitude phase is undefined, not zero phase.
      if (positions.length / 3 >= 65000) flush()
      const start = positions.length / 3
      const t = range[1] === range[0] ? 0.5 : Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0])))
      for (const [du, dv] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        const point = [0, 0, 0]
        point[normal] = field.spatial[normal].ticks[index]
        point[u] = field.spatial[u].edges[i + du]
        point[v] = field.spatial[v].edges[j + dv]
        positions.push(...point)
        colors.push(t, 1 - Math.abs(2 * t - 1), 1 - t, opacity)
      }
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3)
    }
  flush()
  return { identity, geometries, bounds: field.bounds }
}

/** Cache only the displayed plane; topology and phasors stay unchanged during playback. */
export function oscillationSlice(
  field: ReturnType<typeof structuredField>,
  identity: string,
  normal: number,
  index: number,
  sample: number,
  component: number,
) {
  const scene = fieldSlice(field, identity, normal, index, sample, component, 're', [0, 0], 1)
  const [u, v] = [0, 1, 2].filter((axis) => axis !== normal)
  const phasors = new Float32Array(field.spatial[u].ticks.length * field.spatial[v].ticks.length * 2)
  let offset = 0
  for (let j = 0; j < field.spatial[v].ticks.length; j++)
    for (let i = 0; i < field.spatial[u].ticks.length; i++) {
      const xyz = [0, 0, 0]
      xyz[normal] = index
      xyz[u] = i
      xyz[v] = j
      phasors[offset++] = fieldScalar(field, xyz, sample, component, 're')
      phasors[offset++] = fieldScalar(field, xyz, sample, component, 'im')
    }
  return { scene, phasors }
}

export function oscillateSlice(
  cached: ReturnType<typeof oscillationSlice>,
  phaseDegrees: number,
  range: readonly [number, number],
  opacity: number,
): HeatmapRenderData {
  const phase = (phaseDegrees * Math.PI) / 180
  const cosine = Math.cos(phase),
    sine = Math.sin(phase)
  let offset = 0
  return {
    ...cached.scene,
    geometries: cached.scene.geometries.map((geometry) => {
      const colors = new Float32Array(geometry.colors.length)
      for (let vertex = 0; vertex < colors.length; vertex += 16) {
        const value = cached.phasors[offset++] * cosine - cached.phasors[offset++] * sine
        const t = range[1] === range[0] ? 0.5 : Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0])))
        for (let corner = 0; corner < 4; corner++)
          colors.set([t, 1 - Math.abs(2 * t - 1), 1 - t, opacity], vertex + corner * 4)
      }
      return { ...geometry, colors }
    }),
  }
}
