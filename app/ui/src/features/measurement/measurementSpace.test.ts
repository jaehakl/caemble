import { describe, expect, it } from 'vitest'
import {
  fitMeasurementProjection,
  projectSpace,
  sampleMeasurementVars,
  spaceValues,
  varsAtProjection,
} from './measurementSpace'

describe('Measurement PCA and clicked Vars', () => {
  const schema = {
    a: { shape: [], min: 0, max: 10 },
    b: { shape: [], min: 100, max: 200 },
    fixed: { shape: [], min: 3, max: 3 },
  }
  const points = [
    { id: 'a', vars: { a: 0, b: 100, fixed: 3 } },
    { id: 'b', vars: { a: 10, b: 100, fixed: 3 } },
    { id: 'c', vars: { a: 0, b: 200, fixed: 3 } },
    { id: 'd', vars: { a: 10, b: 200, fixed: 3 } },
  ]
  it('normalizes schema ranges, excludes fixed components and never adds boundary points', () => {
    const projection = fitMeasurementProjection(schema, points.slice(0, 3))
    expect(projection.points).toHaveLength(3)
    expect(projection.active).toHaveLength(2)
    expect(projection.points[1].values).toEqual([1, 0, 0])
    expect(projection.axes).toHaveLength(2)
  })
  it('reconstructs a click and repeated clamped clicks are identical', () => {
    const projection = fitMeasurementProjection(schema, points)
    const vars = varsAtProjection(projection, [0.1, 0.2])
    const xy = projectSpace(projection, spaceValues(projection.layouts, vars))
    expect(xy[0]).toBeCloseTo(0.1)
    expect(xy[1]).toBeCloseTo(0.2)
    expect(varsAtProjection(projection, [20, 20])).toEqual(varsAtProjection(projection, [20, 20]))
    expect(vars.fixed).toBe(3)
  })
  it('uses at most seven neighbors and inverse distance weights for residual components', () => {
    const projection = {
      layouts: [{ key: 'v', shape: [3], min: 0, max: 1, size: 3 }],
      active: [0, 1, 2],
      mean: [0, 0, 0],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      variance: [0.5, 0.5],
      points: Array.from({ length: 8 }, (_, i) => ({
        id: String(i),
        values: [(i + 1) / 10, 0, i / 10],
        xy: [(i + 1) / 10, 0],
      })),
    }
    const result = varsAtProjection(projection, [0, 0]).v as number[]
    const weights = Array.from({ length: 7 }, (_, i) => 1 / (i + 1))
    expect(result[2]).toBeCloseTo(
      weights.reduce((sum, weight, i) => sum + (weight * i) / 10, 0) / weights.reduce((a, b) => a + b, 0),
    )
  })
  it('averages only exact neighbors with stable tie-breaking', () => {
    const projection = {
      layouts: [{ key: 'v', shape: [2], min: 0, max: 1, size: 2 }],
      active: [0, 1],
      mean: [0, 0],
      axes: [[1, 0]],
      variance: [1],
      points: [
        { id: 'b', values: [0.5, 0.8], xy: [0.5, 0] },
        { id: 'a', values: [0.5, 0.2], xy: [0.5, 0] },
        { id: 'c', values: [0.8, 1], xy: [0.8, 0] },
      ],
    }
    expect(varsAtProjection(projection, [0.5, 0]).v).toEqual([0.5, 0.5])
  })
  it('handles zero and one effective dimensions', () => {
    expect(fitMeasurementProjection(schema, []).axes).toHaveLength(0)
    expect(fitMeasurementProjection(schema, [points[0], points[0]]).axes).toHaveLength(0)
    const projection = fitMeasurementProjection(schema, [points[0], points[1]])
    expect(projection.axes).toHaveLength(1)
    expect(varsAtProjection(projection, [0, 999]).fixed).toBe(3)
  })
})

describe('empty interval LHS', () => {
  const schema = { v: { shape: [2], min: 0, max: 1 }, fixed: { shape: [], min: 2, max: 2 } }
  it('refines intervals, avoids existing values in every component and fills distinct strata', () => {
    const existing = [
      { v: [0.1, 1], fixed: 2 },
      { v: [0.6, 0.4], fixed: 2 },
    ]
    const rows = sampleMeasurementVars(schema, existing, 2, 'empty-lhs', () => 0.5)
    const values = rows.map((row) => row.v as number[])
    expect(values.map((v) => Math.floor(v[0] * 4)).sort()).toEqual([1, 3])
    expect(values.map((v) => Math.min(3, Math.floor(v[1] * 4))).sort()).toEqual([0, 2])
    expect(rows.every((row) => row.fixed === 2)).toBe(true)
  })
  it('never generates duplicates or silently returns a partial result', () => {
    expect(() => sampleMeasurementVars(schema, [], 2, 'random', () => 0.5)).toThrow('중복')
    expect(() => sampleMeasurementVars(schema, [], 0, 'empty-lhs')).toThrow()
    expect(() => sampleMeasurementVars({ f: { min: 1, max: 1, shape: [] } }, [], 1, 'random')).toThrow('고정')
  })
})
