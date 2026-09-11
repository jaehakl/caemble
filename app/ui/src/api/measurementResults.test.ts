import { expect, it, vi } from 'vitest'
import type { CaembleClient } from './http'
import { readMeasurementResults } from './measurementResults'

it('keeps valid results and frozen metadata when one result cannot be read', async () => {
  const contract = {
    task: 't',
    output: 'o',
    solver: { name: 'fixture', version: '1' },
    artifactType: 'fixture',
    catalogRevision: 'historical',
    visualization: { kind: 'tensor' },
    schema: { dtype: 'float64', tensorOrder: 0 },
  }
  const value = {
    experiment_record_id: 1,
    quantity_kind: null,
    tensor_order: 0,
    dtype: 'float64',
    data_schema: { dtype: 'float64' },
    data: { dtype: 'float64', shape: [], storage: { kind: 'inline', value: 3 } },
  }
  const client = {
    request: vi.fn(async (_method, _url, _body, options) =>
      options.validate({
        recorded_data: { good: value, broken: 42 },
        result_contracts: { good: contract, broken: contract },
      }),
    ),
  } as unknown as CaembleClient
  const result = await readMeasurementResults(client, 5)
  expect(Object.keys(result.recorded_data)).toEqual(['good'])
  expect(Object.keys(result.result_errors!)).toEqual(['broken'])
  expect(result.result_contracts?.good.catalogRevision).toBe('historical')
  expect(client.request).toHaveBeenCalledTimes(1)
})
