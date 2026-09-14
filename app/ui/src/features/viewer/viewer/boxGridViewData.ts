import { projectBoxGrid, type BoxGridProjectionOptions } from '@/lib/calculation/boxGridProject'
import type { CalculationAxis, CalculationInputLeaf } from '@/lib/calculation/types'

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
export type BoxGridViewRequest = {
  leaf: CalculationInputLeaf
  options: BoxGridProjectionOptions
  arrows: boolean
  animationRange: boolean
}
export function calculateBoxGridView({ leaf, options, arrows, animationRange }: BoxGridViewRequest) {
  const scalar = scalarPlotData(projectBoxGrid(leaf, options))
  const components = arrows ? boxGridVectorComponents(leaf) : undefined
  const vectors = components?.map((component) => scalarPlotData(projectBoxGrid(leaf, { ...options, component })).values)
  if (animationRange && options.frame?.axis) {
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
    for (const [axis, reduction] of Object.entries(options.reduce ?? {})) {
      if (!options.axes.includes(axis as (typeof options.axes)[number]) && reduction.method === 'sum')
        peak *= leaf.shape[['x', 'y', 'z', 'time', 'frequency'].indexOf(axis)]
    }
    bound = Math.max(bound, peak)
    scalar.range = [options.component === 'magnitude' ? 0 : -bound, bound]
  }
  return { scalar, vectors }
}
