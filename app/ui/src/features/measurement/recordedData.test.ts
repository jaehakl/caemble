import { describe, expect, it } from 'vitest'
import { parseMeasurementRecordedDataResponse } from '@/contracts/api/measurementValidators'
import { recordedDataTreeSnapshot } from './recordedData'

function recordedDataLeaf(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    experiment_record_id: 11,
    quantity_kind: null,
    tensor_order: 0,
    dtype: 'float64',
    data_schema: null,
    data: { shape: [], storage: { kind: 'inline', value: 1 } },
    ...overrides,
  }
}

describe('Measurement recorded-data wire contract', () => {
  it('accepts the backend null data schema and preserves it in the snapshot row', () => {
    const response = parseMeasurementRecordedDataResponse({
      recorded_data: { stress: recordedDataLeaf() },
    })

    const snapshot = recordedDataTreeSnapshot(response.recorded_data, 7)

    expect(snapshot.rows[0]).toMatchObject({
      measurement_id: 7,
      experiment_record_id: 11,
      name: 'stress',
      data_schema: null,
    })
    expect(snapshot.rules[0]?.result.dtype).toBe('float64')
  })

  it('treats dtype as a valid group path segment instead of a leaf discriminant', () => {
    const response = parseMeasurementRecordedDataResponse({
      recorded_data: { group: { dtype: recordedDataLeaf({ experiment_record_id: 12 }) } },
    })

    const snapshot = recordedDataTreeSnapshot(response.recorded_data, 8)

    expect(snapshot.rows).toHaveLength(1)
    expect(snapshot.rows[0]).toMatchObject({
      measurement_id: 8,
      experiment_record_id: 12,
      name: 'group.dtype',
      dtype: 'float64',
    })
  })

  it('rejects malformed leaf-shaped data instead of accepting it as a group', () => {
    const { data: _data, ...missingData } = recordedDataLeaf()

    expect(() => parseMeasurementRecordedDataResponse({ recorded_data: { stress: missingData } })).toThrow()
    expect(() => parseMeasurementRecordedDataResponse({ recorded_data: { group: { dtype: 'float64' } } })).toThrow()
  })
})
