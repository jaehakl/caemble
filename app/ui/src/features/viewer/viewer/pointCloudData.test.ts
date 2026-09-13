import { expect, it } from 'vitest'
import { calculationExampleInput } from '@/authoring/examples'
import { createPointCloudData } from './pointCloudData'
import { scalarPlotData } from './boxGridViewData'
import { viewerScaleBar } from './scaleBar'
import { buildPlotHistogram } from './ScalarPlot'

it('transforms a spatial point by Box pose and unit, but normalizes mixed coordinate plots', () => {
  const plot = scalarPlotData({
    axes: ['x', 'y', 'z'].map((name) => ({ name, ticks: [0.5], unit: 'm' })),
    data: [[[2]]],
  })
  const leaf = {
    ...calculationExampleInput.signal,
    boxGrid: {
      ...calculationExampleInput.signal.boxGrid,
      origin: [1, 2, 3] as const,
      rotation: [
        [0, -1, 0],
        [1, 0, 0],
        [0, 0, 1],
      ] as const,
    },
  }
  const data = createPointCloudData(plot, { identity: 'test', leaf, displayUnit: 'mm' })
  expect([...data.geometries[0].positions]).toEqual([500, 2500, 3500])
  const mixed = createPointCloudData(
    { ...plot, axes: plot.axes.map((axis, i) => (i === 2 ? { ...axis, name: 'time' } : axis)) },
    { identity: 'test' },
  )
  expect([...mixed.geometries[0].positions]).toEqual([0.5, 0.5, 0.5])
})
it('puts a projected plane at the requested local coordinate and keeps cancellation visible', () => {
  const leaf = calculationExampleInput.signal
  const plane = scalarPlotData({ axes: leaf.axes.slice(0, 2) as { name: string; ticks: number[] }[], data: [[1]] })
  const data = createPointCloudData(plane, { identity: 'test', leaf, plane: { axis: 2, coordinate: 0.25 } })
  expect(data.geometries[0].primitive).toBe('triangles')
  expect([...data.geometries[0].positions].filter((_, i) => i % 3 === 2)).toEqual([0.25, 0.25, 0.25, 0.25, 0.25, 0.25])
  const vector = createPointCloudData(plane, { identity: 'test', leaf, vectors: [[0], [0], [0]] })
  expect(vector.geometries[0].positions.length).toBeGreaterThan(0)
})
it('uses nice scale lengths and responds to zoom and viewport resize', () => {
  const first = viewerScaleBar(10, Math.PI / 2, 600)!
  expect(first.length).toBe(2)
  expect(first.width).toBeCloseTo(60)
  expect(viewerScaleBar(5, Math.PI / 2, 600)!.length).toBe(1)
  expect(viewerScaleBar(10, Math.PI / 2, 1200)!.length).toBe(1)
  expect(viewerScaleBar(0, 0, 0)).toBeNull()
})
it('counts every histogram sample including the maximum and handles constant data', () => {
  expect(buildPlotHistogram([0, 1, 2, 3], 2).map((bin) => bin.count)).toEqual([2, 2])
  expect(buildPlotHistogram([7, 7, 7])).toEqual([{ min: 7, max: 7, count: 3 }])
})

it('hides exactly zero scalar samples and scales point area by absolute value', () => {
  const plot = scalarPlotData({
    axes: [
      { name: 'x', ticks: [0, 1, 2, 3, 4] },
      { name: 'y', ticks: [0] },
      { name: 'z', ticks: [0] },
    ],
    data: [[[0]], [[-0]], [[1]], [[-4]], [[4]]],
  })
  const result = createPointCloudData(plot, { identity: 'sizes', range: [-100, 100] })
  expect(result.displayedCount).toBe(3)
  expect(result.hiddenZeroCount).toBe(2)
  expect([...result.geometries[0].pointSizes!]).toEqual([5, 10, 10])
  expect(result.geometries[0].positions.length).toBe(9)
  expect(plot.values).toEqual([0, -0, 1, -4, 4])
  const frame = createPointCloudData({ ...plot, values: [0, 0, 1, -1, 1] }, { identity: 'sizes' })
  expect([...frame.geometries[0].pointSizes!]).toEqual([5, 5, 5])
})

it('hides zero arrows while keeping positive values with cancelled directions as proportional points', () => {
  const plot = scalarPlotData({ axes: [{ name: 'x', ticks: [0, 1, 2] }], data: [0, 1, 4] })
  const result = createPointCloudData(plot, {
    identity: 'arrows',
    vectors: [
      [1, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
  })
  expect(result.displayedCount).toBe(2)
  expect(result.geometries).toHaveLength(1)
  expect(result.geometries[0].primitive).toBe('points')
  expect([...result.geometries[0].pointSizes!]).toEqual([5, 10])
})

it('keeps bounds for all-zero plots and keeps zero cells in heatmap planes', () => {
  const leaf = calculationExampleInput.signal
  const plot = scalarPlotData({ axes: leaf.axes.slice(0, 2) as { name: string; ticks: number[] }[], data: [[0]] })
  const zero = createPointCloudData(plot, { identity: 'zero', leaf })
  const nonzero = createPointCloudData({ ...plot, values: [1], range: [1, 1] }, { identity: 'zero', leaf })
  expect(zero.geometries).toEqual([])
  expect(zero.bounds).toEqual(nonzero.bounds)
  expect(zero.displayedCount).toBe(0)
  expect(createPointCloudData(plot, { identity: 'zero', vectors: [[0], [0], [0]] }).geometries).toEqual([])
  const plane = createPointCloudData(plot, { identity: 'zero', leaf, plane: { axis: 2, coordinate: 0.25 } })
  expect(plane.displayedCount).toBe(1)
  expect(plane.hiddenZeroCount).toBe(0)
  expect(plane.geometries[0].primitive).toBe('triangles')
})

it('filters zeros before sampling and uses the full-data maximum across buffer chunks', () => {
  const values: number[] = Array.from({ length: 200_002 }, (_, i) => (i % 2 ? 1 : 0))
  values[3] = 4 // Excluded by stride, but still sets the size normalization.
  const plot = scalarPlotData({ axes: [{ name: 'x', ticks: values.map((_, i) => i) }], data: values })
  const result = createPointCloudData(plot, { identity: 'large' })
  expect(result.hiddenZeroCount).toBe(100_001)
  expect(result.displayedCount).toBe(50_001)
  expect(result.geometries.flatMap((geometry) => [...geometry.pointSizes!]).every((size) => size === 5)).toBe(true)
  const dense = createPointCloudData(
    { ...plot, values: values.slice(0, 80_000).map(() => 1), shape: [80_000] },
    { identity: 'chunks' },
  )
  expect(dense.geometries).toHaveLength(2)
  for (const geometry of dense.geometries) expect(geometry.pointSizes!.length).toBe(geometry.positions.length / 3)
})
