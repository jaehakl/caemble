import type { CalculationInputLeaf } from '@/lib/calculation/types'
import { convertUcumValue, type UcumUnit } from '@/lib/cad/model'
import type { ScalarPlotData } from './boxGridViewData'
import type { HeatmapRenderData } from './structuredField'
import type { MeshRenderGeometry } from './meshFields'

export function plotColor(value: number, range: readonly number[]): [number, number, number, number] {
  const t = range[1] === range[0] ? 0.5 : Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0])))
  return [Math.max(0, 2 * t - 1), 1 - Math.abs(2 * t - 1), Math.max(0, 1 - 2 * t), 1]
}

/** Positions use Box local coordinates; vector components are in the recorded global XYZ basis. */
export function createPointCloudData(
  plot: ScalarPlotData,
  options: {
    identity: string
    leaf?: CalculationInputLeaf
    displayUnit?: UcumUnit
    vectors?: number[][]
    plane?: { axis: number; coordinate: number }
    range?: readonly number[]
  },
): HeatmapRenderData & { displayedCount: number; hiddenZeroCount: number } {
  const spatialIndices = plot.axes.map((axis) => ['x', 'y', 'z'].indexOf(axis.name))
  const spatial = options.leaf && spatialIndices.every((axis) => axis >= 0)
  const factor = spatial
    ? convertUcumValue(1, options.leaf!.boxGrid.lengthUnit, options.displayUnit ?? options.leaf!.boxGrid.lengthUnit)
    : 1
  const range = options.range ?? plot.range
  const limit = options.vectors ? 10_000 : 100_000
  const hiddenZeroCount = options.plane ? 0 : plot.values.reduce((count, value) => count + Number(value === 0), 0)
  const stride = Math.max(1, Math.ceil((plot.values.length - hiddenZeroCount) / limit))
  // scalar.range is the full-data range, fixed across animation frames. Color overrides do not affect size.
  const maximumAbsoluteValue = Math.max(Math.abs(plot.range[0]), Math.abs(plot.range[1]))
  let eligibleIndex = 0,
    displayedCount = 0
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  const geometries: MeshRenderGeometry[] = []
  const zeroPositions: number[] = [],
    zeroColors: number[] = [],
    zeroSizes: number[] = []
  let positions: number[] = [],
    colors: number[] = [],
    indices: number[] = [],
    pointSizes: number[] = []
  const primitive = options.plane ? 'triangles' : options.vectors ? 'lines' : 'points'
  const flush = () => {
    if (indices.length)
      geometries.push({
        positions: new Float32Array(positions),
        colors: new Float32Array(colors),
        indices: new Uint16Array(indices),
        primitive,
        ...(primitive === 'points' ? { pointSizes: new Float32Array(pointSizes) } : {}),
      })
    positions = []
    colors = []
    indices = []
    pointSizes = []
  }
  const vertex = (point: number[], color: number[]) => {
    indices.push(positions.length / 3)
    positions.push(...point)
    colors.push(...color)
    point.forEach((value, axis) => {
      bounds.min[axis] = Math.min(bounds.min[axis], value)
      bounds.max[axis] = Math.max(bounds.max[axis], value)
    })
  }
  const world = (local: number[]) =>
    spatial
      ? options.leaf!.boxGrid.rotation.map(
          (row, axis) =>
            factor * (options.leaf!.boxGrid.origin[axis] + row.reduce((sum, value, c) => sum + value * local[c], 0)),
        )
      : local
  const spatialSize = spatial ? Math.hypot(...options.leaf!.boxGrid.size) * factor : 1
  const arrowScale = (spatialSize * 0.08) / (Math.max(Math.abs(range[0]), Math.abs(range[1])) || 1)
  for (let flat = 0; flat < plot.values.length; flat++) {
    const value = plot.values[flat]
    if (!options.plane && value === 0) continue
    if (eligibleIndex++ % stride !== 0) continue
    displayedCount++
    const pointSize = maximumAbsoluteValue > 0 ? 10 * Math.sqrt(Math.min(1, Math.abs(value) / maximumAbsoluteValue)) : 0
    let remainder = flat
    const index = plot.shape.map(() => 0)
    for (let axis = plot.shape.length - 1; axis >= 0; axis--) {
      index[axis] = remainder % plot.shape[axis]
      remainder = Math.floor(remainder / plot.shape[axis])
    }
    const point = [0, 0, 0]
    plot.axes.forEach((axis, a) => {
      const tick = axis.ticks[index[a]]
      const first = axis.ticks[0],
        last = axis.ticks[axis.ticks.length - 1]
      point[spatial ? spatialIndices[a] : a] = spatial ? tick : last === first ? 0.5 : (tick - first) / (last - first)
    })
    if (options.plane) point[options.plane.axis] = options.plane.coordinate
    const color = plotColor(plot.values[flat], range)
    if (options.plane && spatial) {
      const corners = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, -1],
        [1, 1],
        [-1, 1],
      ]
      for (const corner of corners) {
        const local = [...point]
        spatialIndices.forEach((axis, a) => {
          const ticks = plot.axes[a].ticks,
            i = index[a]
          local[axis] =
            corner[a] < 0
              ? i === 0
                ? 0
                : (ticks[i - 1] + ticks[i]) / 2
              : i === ticks.length - 1
                ? options.leaf!.boxGrid.size[axis]
                : (ticks[i + 1] + ticks[i]) / 2
        })
        vertex(world(local), color)
      }
    } else if (options.vectors) {
      const origin = world(point),
        direction = options.vectors.map((values) => values[flat])
      const magnitude = Math.hypot(...direction)
      const length = Math.abs(plot.values[flat]) * arrowScale
      if (magnitude < 1e-12 || length === 0) {
        zeroPositions.push(...origin)
        zeroColors.push(...color)
        zeroSizes.push(pointSize)
      } else {
        const unit = direction.map((value) => value / magnitude)
        const end = origin.map((value, axis) => value + unit[axis] * length)
        const perpendicular = Math.abs(unit[2]) < 0.9 ? [-unit[1], unit[0], 0] : [0, -unit[2], unit[1]]
        const norm = Math.hypot(...perpendicular)
        vertex(origin, color)
        vertex(end, color)
        for (const sign of [-1, 1]) {
          vertex(end, color)
          vertex(
            end.map(
              (value, axis) =>
                value - unit[axis] * length * 0.25 + ((sign * perpendicular[axis]) / norm) * length * 0.12,
            ),
            color,
          )
        }
      }
    } else {
      vertex(world(point), color)
      pointSizes.push(pointSize)
    }
    if (positions.length / 3 > 60_000) flush()
  }
  flush()
  if (zeroPositions.length)
    geometries.push({
      primitive: 'points',
      positions: new Float32Array(zeroPositions),
      colors: new Float32Array(zeroColors),
      pointSizes: new Float32Array(zeroSizes),
      indices: Uint16Array.from({ length: zeroPositions.length / 3 }, (_, i) => i),
    })
  // Stable bounds independent of values and animation phase.
  if (spatial) {
    const corners = Array.from({ length: 8 }, (_, i) =>
      world(options.leaf!.boxGrid.size.map((size, axis) => (i & (1 << axis) ? size : 0))),
    )
    for (let axis = 0; axis < 3; axis++) {
      bounds.min[axis] = Math.min(...corners.map((p) => p[axis])) - spatialSize * 0.12
      bounds.max[axis] = Math.max(...corners.map((p) => p[axis])) + spatialSize * 0.12
    }
  } else {
    bounds.min = [0, 0, 0]
    bounds.max = [1, 1, 1]
  }
  return { identity: options.identity, geometries, bounds, displayedCount, hiddenZeroCount }
}
