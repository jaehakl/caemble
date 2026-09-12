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
    request: vi.fn(async (_method, url, _body, options) =>
      url.endsWith('/visualizations')
        ? { visualizations: {} }
        : options.validate({
            recorded_data: { good: value, broken: 42 },
            result_contracts: { good: contract, broken: contract },
          }),
    ),
  } as unknown as CaembleClient
  const result = await readMeasurementResults(client, 5)
  expect(Object.keys(result.recorded_data)).toEqual(['good'])
  expect(Object.keys(result.result_errors!)).toEqual(['broken'])
  expect(result.result_contracts?.good.catalogRevision).toBe('historical')
  expect(client.request).toHaveBeenCalledTimes(2)
  expect(result.visualizations).toEqual({})
})

it('loads automatic visualizations in a separate channel without creating numerical Records', async () => {
  const entry = {
    contract: {
      artifactType: 'fixture/rays@1',
      visualization: { kind: 'polyline', vertices: 'vertices', offsets: 'offsets' },
    },
    schema: {
      vertices: { dtype: 'float64', axes: [{ name: 'vertex' }, { name: 'component', length: 3 }] },
      offsets: { dtype: 'int32', axes: [{ name: 'path' }] },
    },
    data: {
      vertices: { shape: [1, 3], storage: { kind: 'inline', value: [[0, 0, 0]] } },
      offsets: { shape: [2], storage: { kind: 'inline', value: [0, 1] } },
    },
    provenance: {
      task: 'optics',
      solver: { name: 'fixture', version: '1' },
      stateRevision: 1,
      invocation: 1,
      catalogRevision: 'frozen',
    },
  }
  const client = {
    request: vi.fn(async (_method, url, _body, options) =>
      url.endsWith('/visualizations')
        ? options.validate({
            visualizations: {
              optics: { rays: entry, broken: { ...entry, provenance: { ...entry.provenance, invocation: -1 } } },
            },
          })
        : options.validate({ recorded_data: {}, result_contracts: {} }),
    ),
  } as unknown as CaembleClient
  const result = await readMeasurementResults(client, 3)
  expect(result.recorded_data).toEqual({})
  expect(result.result_contracts).toEqual({})
  expect(result.visualizations?.optics.rays).toEqual(entry)
  expect(Object.keys(result.result_errors!)).toEqual(['@visualizations.optics.broken'])
})
