import { describe, expect, it } from 'vitest'
import { parseCalculationDataListResponse, parseCalculationListResponse } from './calculationValidators'

function calculationItem(outputLayout: unknown) {
  return {
    id: 1,
    experiment_id: 2,
    name: 'Stress',
    source_code: 'return 0',
    output_layout: outputLayout,
    contract_status: 'ready',
    experiment_record_ids: [],
  }
}

function calculationDataItem(data: unknown) {
  return { id: 3, calculation_id: 1, measurement_id: 4, data }
}

describe('Calculation wire contracts', () => {
  it('normalizes nullable axis units in Calculation layouts and data outputs', () => {
    const layout = parseCalculationListResponse({
      total: 1,
      items: [
        calculationItem({
          dtype: 'float64',
          shape: [2],
          axes: [{ name: 'time', ticks: [0, 1], unit: null }],
        }),
      ],
    }).items[0]?.output_layout
    const output = parseCalculationDataListResponse({
      total: 1,
      items: [
        calculationDataItem({
          dtype: 'float64',
          shape: [2],
          axes: [{ name: 'time', ticks: [0, 1], unit: null }],
          data: [10, 20],
        }),
      ],
    }).items[0]?.data

    expect(layout?.axes[0]?.unit).toBeUndefined()
    expect(output?.axes[0]?.unit).toBeUndefined()
  })

  it('accepts the scalar and tensor data representations that match their shapes', () => {
    expect(() =>
      parseCalculationDataListResponse({
        total: 2,
        items: [
          calculationDataItem({ dtype: 'float64', shape: [], axes: [], data: 1 }),
          calculationDataItem({
            dtype: 'float32',
            shape: [2],
            axes: [{ name: 'sample', ticks: [0, 1] }],
            data: [1, 2],
          }),
        ],
      }),
    ).not.toThrow()
  })

  it.each([
    [
      'rank above two',
      {
        dtype: 'float64',
        shape: [1, 1, 1],
        axes: [
          { name: 'x', ticks: [0] },
          { name: 'y', ticks: [0] },
          { name: 'z', ticks: [0] },
        ],
        data: [1],
      },
    ],
    ['axis count', { dtype: 'float64', shape: [1], axes: [], data: [1] }],
    ['axis tick count', { dtype: 'float64', shape: [2], axes: [{ name: 'x', ticks: [0] }], data: [1, 2] }],
    ['scalar data representation', { dtype: 'float64', shape: [], axes: [], data: [1] }],
    ['tensor data representation', { dtype: 'float64', shape: [1], axes: [{ name: 'x', ticks: [0] }], data: 1 }],
    ['tensor data length', { dtype: 'float64', shape: [2], axes: [{ name: 'x', ticks: [0, 1] }], data: [1] }],
    ['integer dtype range', { dtype: 'uint8', shape: [1], axes: [{ name: 'x', ticks: [0] }], data: [256] }],
  ])('rejects output with inconsistent %s', (_label, data) => {
    expect(() => parseCalculationDataListResponse({ total: 1, items: [calculationDataItem(data)] })).toThrow()
  })

  it('validates layout shape and axes even when no output data is present', () => {
    expect(() =>
      parseCalculationListResponse({
        total: 1,
        items: [
          calculationItem({
            dtype: 'float64',
            shape: [2],
            axes: [{ name: 'x', ticks: [0] }],
          }),
        ],
      }),
    ).toThrow()
  })
})
