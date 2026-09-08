import { describe, expect, it } from 'vitest'
import type { CalculationDataOutput } from '@/api'
import {
  comparePredictionOutput,
  inverseValidationAggregateError,
  inverseValidationAggregateErrorFromScales,
} from './metrics'

const reference: CalculationDataOutput = {
  dtype: 'float64',
  shape: [2],
  axes: [{ name: 'time', unit: 's', ticks: [0, 1] }],
  data: [10, 20],
}
const actual: CalculationDataOutput = {
  dtype: 'float32',
  shape: [2],
  axes: [{ name: 'position', unit: 'm', ticks: [100, 200] }],
  data: [12, 24],
}

describe('shape-based Prediction metrics', () => {
  it('compares by index and applies the same rule to both inverse aggregate paths', () => {
    expect(comparePredictionOutput(reference, actual)).toMatchObject({
      compatible: true,
      mae: 3,
      rmse: Math.sqrt(10),
      maxAbsoluteError: 4,
    })
    const pairs = [{ calculationId: 1, reference, actual }]
    const layout = { key: 'calculation:1', dtype: 'float64' as const, shape: [2], axes: reference.axes }
    expect(inverseValidationAggregateErrorFromScales(pairs, { 1: 1 }, [layout], new Float64Array([1, 2]))).toBeCloseTo(
      2,
    )
    expect(
      inverseValidationAggregateError(
        pairs,
        { 1: 1 },
        [
          { measurementId: 1, inputs: [{ layout, values: [0, 0] }], outputs: [] },
          { measurementId: 2, inputs: [{ layout, values: [2, 4] }], outputs: [] },
        ],
        [1, 2],
      ),
    ).toBeCloseTo(2)
  })

  it('rejects different shapes with the same number of elements', () => {
    const first: CalculationDataOutput = {
      dtype: 'float64',
      shape: [2, 3],
      axes: [
        { name: 'row', ticks: [0, 1] },
        { name: 'column', ticks: [0, 1, 2] },
      ],
      data: [1, 2, 3, 4, 5, 6],
    }
    const second: CalculationDataOutput = {
      ...first,
      shape: [3, 2],
      axes: [
        { name: 'row', ticks: [0, 1, 2] },
        { name: 'column', ticks: [0, 1] },
      ],
    }
    expect(comparePredictionOutput(first, second)).toMatchObject({
      compatible: false,
      mae: null,
      message: 'shape가 다릅니다. 기준 [2,3], 실제 [3,2]',
    })
    expect(
      comparePredictionOutput(
        { ...reference, shape: [], axes: [], data: 1 },
        { ...reference, shape: [1], axes: [{ name: 'index', ticks: [0] }], data: [1] },
      ).compatible,
    ).toBe(false)
  })

  it('still rejects invalid tensors even when shapes match', () => {
    for (const invalid of [
      { ...actual, data: [1, Number.NaN] },
      { ...actual, data: [1] },
      { ...actual, axes: [{ name: 'index', ticks: [0] }] },
    ])
      expect(comparePredictionOutput(reference, invalid).compatible).toBe(false)
  })
})
