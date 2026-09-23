import {
  boxGridTensorComponents,
  projectBoxGrid,
  projectionAxes,
  type ProjectionAxis,
  type BoxGridProjectionOptions,
  type TensorDirection,
} from '@/lib/calculation/boxGridProject'
import type { CalculationAxis, CalculationInputLeaf } from '@/lib/calculation/types'

export type PlotKind = 'histogram' | 'line' | 'heatmap' | 'cloud'
export type BoxGridAnimation = 'off' | 'oscillation' | ProjectionAxis | 'component'
export type BoxGridComponentChoice =
  | number
  | 'magnitude'
  | 'magnitudeSquared'
  | 'arrows'
  | Readonly<{ tensor: readonly [TensorDirection | 'arrows', TensorDirection | 'arrows'] }>

export type ScalarPlotData = {
  axes: readonly CalculationAxis[]
  shape: number[]
  values: number[]
  range: [number, number]
}
export function scalarPlotData(output: { axes: readonly CalculationAxis[]; data: unknown }): ScalarPlotData {
  const values = (Array.isArray(output.data) ? output.data.flat(Infinity) : [output.data]) as number[]
  let min = Infinity,
    max = -Infinity
  for (const value of values) {
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  return {
    axes: output.axes,
    shape: output.axes.map((axis) => axis.ticks.length),
    values,
    range: values.length ? [min, max] : [0, 0],
  }
}
export function boxGridVectorComponents(leaf: CalculationInputLeaf) {
  if (leaf.tensorOrder !== 1 || leaf.boxGrid.components.length !== 3) return undefined
  const labels = leaf.boxGrid.components.map((name) => name.toLowerCase())
  const indices = ['x', 'y', 'z'].map((axis) =>
    labels.findIndex((label) => label === axis || new RegExp(`^[a-z]+[_ .]?${axis}$`).test(label)),
  )
  return indices.every((index) => index >= 0) && new Set(indices).size === 3 ? indices : undefined
}

export function boxGridArrowComponents(
  leaf: CalculationInputLeaf,
  component: BoxGridComponentChoice,
): number[] | undefined {
  const vector = boxGridVectorComponents(leaf)
  if (vector && (component === 'arrows' || component === 'magnitude')) return vector
  if (typeof component !== 'object') return undefined
  const tensor = boxGridTensorComponents(leaf)
  const arrowRow = component.tensor.indexOf('arrows')
  if (!tensor || arrowRow < 0) return undefined
  const fixed = ['x', 'y', 'z'].indexOf(component.tensor[1 - arrowRow])
  if (fixed < 0) return undefined
  return [0, 1, 2].map((axis) => (arrowRow === 0 ? tensor[axis][fixed] : tensor[fixed][axis]))
}

/** Display conversion only: permute values with ticks, preserving raw RecordedData. */
export function opticalPlotData(plot: ScalarPlotData, wavelength: boolean, surface: boolean): ScalarPlotData {
  const frequencyAxis = plot.axes.findIndex((axis) => axis.name === 'frequency')
  let values = plot.values
  const axes = plot.axes.map((axis, index) => {
    if (surface && (axis.name === 'x' || axis.name === 'y')) return { ...axis, name: axis.name === 'x' ? 'u' : 'v' }
    if (!wavelength || index !== frequencyAxis) return axis
    const ticks = axis.ticks.map((frequency) => 299792458e9 / frequency)
    const order = ticks.map((_, index) => index).sort((a, b) => ticks[a] - ticks[b])
    const stride = plot.shape.slice(index + 1).reduce((a, b) => a * b, 1)
    values = plot.values.map((_, offset) => {
      const sample = Math.floor(offset / stride) % order.length
      return plot.values[offset + (order[sample] - sample) * stride]
    })
    return { ...axis, name: '입력 파장', ticks: order.map((index) => ticks[index]), unit: 'nm' }
  })
  return { ...plot, axes, values }
}
export type BoxGridViewRequest = {
  leaf: CalculationInputLeaf
  options: BoxGridProjectionOptions
  arrows: boolean
  vectorComponents?: readonly number[]
  animationRange: boolean
  sweepAxis?: ProjectionAxis | 'component'
  histogramDistribution?: boolean
}
export function calculateBoxGridView({
  leaf,
  options,
  arrows,
  vectorComponents,
  animationRange,
  sweepAxis,
  histogramDistribution,
}: BoxGridViewRequest) {
  const scalar = scalarPlotData(projectBoxGrid(leaf, options))
  // The zero-axis marker is reduced, but its reference distribution always uses every original sample.
  const distribution = histogramDistribution
    ? scalarPlotData(
        projectBoxGrid(leaf, {
          ...options,
          axes: projectionAxes,
          reduce: {},
          frame: options.frame?.timeSeconds === undefined ? undefined : { timeSeconds: options.frame.timeSeconds },
        }),
      )
    : undefined
  const components = vectorComponents ?? (arrows ? boxGridVectorComponents(leaf) : undefined)
  const vectors = components?.map((component) => scalarPlotData(projectBoxGrid(leaf, { ...options, component })).values)
  if (animationRange && sweepAxis) {
    const axis = sweepAxis === 'component' ? 6 : projectionAxes.indexOf(sweepAxis)
    for (let index = 0; index < leaf.shape[axis]; index++) {
      const next =
        sweepAxis === 'component'
          ? { ...options, component: index }
          : {
              ...options,
              reduce: { ...options.reduce, [sweepAxis]: { method: 'index' as const, index } },
            }
      const frame = scalarPlotData(projectBoxGrid(leaf, next))
      scalar.range[0] = Math.min(scalar.range[0], frame.range[0])
      scalar.range[1] = Math.max(scalar.range[1], frame.range[1])
      if (distribution && sweepAxis === 'component') {
        const raw = scalarPlotData(
          projectBoxGrid(leaf, { ...next, axes: projectionAxes, reduce: {}, frame: undefined }),
        )
        distribution.range[0] = Math.min(distribution.range[0], raw.range[0])
        distribution.range[1] = Math.max(distribution.range[1], raw.range[1])
      }
    }
  } else if (animationRange && options.frame?.axis) {
    const axis = options.frame.axis === 'time' ? 3 : 4
    for (let index = 0; index < leaf.shape[axis]; index++) {
      const frame = scalarPlotData(projectBoxGrid(leaf, { ...options, frame: { ...options.frame, index } }))
      scalar.range[0] = Math.min(scalar.range[0], frame.range[0])
      scalar.range[1] = Math.max(scalar.range[1], frame.range[1])
    }
  } else if (animationRange && (options.frame?.phase !== undefined || options.frame?.timeSeconds !== undefined)) {
    // An amplitude envelope is conservative for every phase, including mixed reductions.
    const amplitude = scalarPlotData(
      projectBoxGrid(leaf, { ...options, representation: 'amplitude', frame: undefined }),
    )
    let bound = Math.max(Math.abs(amplitude.range[0]), Math.abs(amplitude.range[1]))
    // min/max/median/std may have extrema away from the static amplitude aggregate.
    let peak = 0
    const componentCount = leaf.shape[6]
    for (let i = 0; i < leaf.data.length; i += componentCount * leaf.shape[5]) {
      let square = 0
      for (let c = 0; c < componentCount; c++) square += leaf.data[i + c] ** 2
      peak = Math.max(peak, Math.sqrt(square))
    }
    const nonlinear =
      options.component === 'magnitude' ||
      options.component === 'magnitudeSquared' ||
      typeof options.component === 'object'
    if (distribution)
      distribution.range = nonlinear ? [0, options.component === 'magnitudeSquared' ? peak ** 2 : peak] : [-peak, peak]
    for (const [axis, reduction] of Object.entries(options.reduce ?? {})) {
      if (!options.axes.includes(axis as (typeof options.axes)[number]) && reduction.method === 'sum')
        peak *= leaf.shape[['x', 'y', 'z', 'time', 'frequency'].indexOf(axis)]
    }
    bound = Math.max(bound, peak)
    scalar.range = nonlinear ? [0, options.component === 'magnitudeSquared' ? bound ** 2 : bound] : [-bound, bound]
  }
  return { scalar, vectors, distribution }
}
