import { describe, expect, it } from 'vitest'
import { sampleMeasurementVars } from './measurementSpace'

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
