import { describe, expect, it } from 'vitest'
import { opticalPlotData, type ScalarPlotData } from './boxGridViewData'

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
