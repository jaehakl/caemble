import { describe, expect, it } from 'vitest'
import { predictionTensorSampleSchema } from './protocolValidation'
import { predictionTensorValueCount } from './tensor'

describe('remote Prediction tensor boundary', () => {
  const layout = { key: 'temperature', dtype: 'float64' as const, shape: [2], axes: [{ name: 'x', ticks: [0, 1] }] }

  it('rejects malformed shapes, axes, non-finite data and truncated values', () => {
    for (const sample of [
      { layout, values: [1] },
      { layout, values: [1, Infinity] },
      { layout: { ...layout, axes: [] }, values: [1, 2] },
      { layout: { ...layout, shape: [-2] }, values: [1, 2] },
      { layout: { ...layout, shape: [Number.MAX_SAFE_INTEGER, 2], axes: undefined }, values: [] },
    ])
      expect(predictionTensorSampleSchema.safeParse(sample).success).toBe(false)
    expect(predictionTensorSampleSchema.parse({ layout, values: [1, 2] }).values).toEqual([1, 2])
  })

  it('counts Cartesian complex values and modal frequency payloads without numerical inference', () => {
    expect(predictionTensorValueCount({ ...layout, dtype: 'complex64' })).toBe(4)
    expect(
      predictionTensorValueCount({ ...layout, axes: undefined, shape: [1, 1, 1, 1, 2, 1, 1], frequencyOutput: true }),
    ).toBe(4)
    expect(() =>
      predictionTensorValueCount({ ...layout, shape: [Number.MAX_SAFE_INTEGER], dtype: 'complex64' }),
    ).toThrow()
  })
})
