import { describe, expect, it } from 'vitest'
import { calculateBoxGridView, opticalPlotData, type ScalarPlotData } from './boxGridViewData'
import { calculationExampleInput } from '@/authoring/examples'
import type { CalculationInputLeaf } from '@/lib/calculation/types'

describe('optical power display', () => {
  it('permutes a frequency axis together with every spatial row', () => {
    const plot: ScalarPlotData = {
      axes: [
        { name: 'x', ticks: [1, 3], unit: 'mm' },
        { name: 'frequency', ticks: [299792458e9 / 600, 299792458e9 / 500], unit: 'Hz' },
      ],
      shape: [2, 2],
      values: [1, 2, 3, 4],
      range: [1, 4],
    }
    const displayed = opticalPlotData(plot, true, true)
    expect(displayed.axes[0].name).toBe('u')
    expect(displayed.axes[1]).toEqual({ name: '입력 파장', ticks: [500, 600], unit: 'nm' })
    expect(displayed.values).toEqual([2, 1, 4, 3])
    expect(plot.values).toEqual([1, 2, 3, 4])
    expect(opticalPlotData(plot, false, false)).toEqual(plot)
  })
  it('permutes an outer frequency axis with its complete profile', () => {
    const plot: ScalarPlotData = {
      axes: [
        { name: 'frequency', ticks: [299792458e9 / 650, 299792458e9 / 450], unit: 'Hz' },
        { name: 'y', ticks: [1, 2, 3], unit: 'mm' },
      ],
      shape: [2, 3],
      values: [1, 2, 3, 4, 5, 6],
      range: [1, 6],
    }
    expect(opticalPlotData(plot, true, true).values).toEqual([4, 5, 6, 1, 2, 3])
  })
})

const sweepLeaf: CalculationInputLeaf = {
  ...calculationExampleInput.signal,
  shape: [2, 1, 1, 1, 1, 1, 2],
  data: [1, 4, 2, 8],
  tensorOrder: 0,
  axes: ['x', 'y', 'z', 'time', 'frequency', 'amplitudePhase', 'component'].map((name, axis) => ({
    name,
    ticks: axis === 0 || axis === 6 ? [0, 1] : [0],
  })),
  boxGrid: {
    ...calculationExampleInput.signal.boxGrid,
    gridShape: [2, 1, 1],
    channels: ['value'],
    channelUnits: ['m'],
    components: ['a', 'b'],
  },
}

it('keeps the full original distribution separate from the indexed and reduced zero-axis marker', () => {
  const indexed = calculateBoxGridView({
    leaf: sweepLeaf,
    options: { axes: [], component: 0, reduce: { x: { method: 'index', index: 1 } } },
    arrows: false,
    animationRange: false,
    histogramDistribution: true,
  })
  expect(indexed.scalar.values).toEqual([2])
  expect(indexed.distribution?.values).toEqual([1, 2])
  const summed = calculateBoxGridView({
    leaf: sweepLeaf,
    options: { axes: [], component: 0, reduce: { x: { method: 'sum' } } },
    arrows: false,
    animationRange: false,
    histogramDistribution: true,
  })
  expect(summed.scalar.values).toEqual([3])
  expect(summed.distribution?.range).toEqual([1, 2])
})

it('computes stable spatial and component sweep ranges without extending Calculation frame syntax', () => {
  const spatial = calculateBoxGridView({
    leaf: sweepLeaf,
    options: { axes: [], component: 0, reduce: { x: { method: 'index', index: 0 } } },
    arrows: false,
    animationRange: true,
    sweepAxis: 'x',
  })
  expect(spatial.scalar.values).toEqual([1])
  expect(spatial.scalar.range).toEqual([1, 2])
  const component = calculateBoxGridView({
    leaf: sweepLeaf,
    options: { axes: ['x'], component: 0 },
    arrows: false,
    animationRange: true,
    sweepAxis: 'component',
  })
  expect(component.scalar.values).toEqual([1, 2])
  expect(component.scalar.range).toEqual([1, 8])
})
