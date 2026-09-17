import { expect, it, vi } from 'vitest'
import type { CaembleClient } from './http'
import { readMeasurementResults } from './measurementResults'

it.each([false, true])('preserves saved field weightings with an invalid sibling: %s', async (includeInvalid) => {
  const fields = [
    { name: 'pressure', weighting: 'material-volume', values: [[12]] },
    { name: 'velocity', weighting: 'material-volume', values: [[1, 2, 3]] },
    { name: 'traction', weighting: 'surface-area', values: [[4, 5, 6]] },
    { name: 'stress', weighting: 'reference-volume', values: [[7, 8, 9, 0, 0, 0]] },
    { name: 'unweighted', values: [[10]] },
    ...(includeInvalid ? [{ name: 'broken', weighting: 'unknown', values: [[0]] }] : []),
  ]
  const entries = Object.fromEntries(
    fields.map(({ name, weighting, values }) => [
      name,
      {
        contract: {
          artifactType: 'fixture/field@1',
          visualization: { kind: 'mesh-field', sampling: 'cell-average', ...(weighting ? { weighting } : {}) },
        },
        schema: { values: { dtype: 'float64', axes: [{ name: 'cell' }, { name: 'component' }] } },
        data: { values: { shape: [1, values[0].length], storage: { kind: 'inline', value: values } } },
        provenance: {
          task: 'flow',
          solver: { name: 'fixture', version: '1' },
          stateRevision: 1,
          invocation: 1,
          catalogRevision: 'frozen',
        },
      },
    ]),
  )
  // Reproduce the JSON boundary used when reading an already saved Measurement.
  const saved = JSON.parse(JSON.stringify({ visualizations: { flow: entries } }))
  const client = {
    request: vi.fn(async (_method, url, _body, options) =>
      options.validate(url.endsWith('/visualizations') ? saved : { recorded_data: {}, result_contracts: {} }),
    ),
  } as unknown as CaembleClient

  const result = await readMeasurementResults(client, 3)

  expect(result.visualizations?.flow).toEqual(
    Object.fromEntries(Object.entries(entries).filter(([name]) => name !== 'broken')),
  )
  expect(Object.keys(result.result_errors!)).toEqual(includeInvalid ? ['@visualizations.flow.broken'] : [])
  if (includeInvalid) {
    expect(JSON.parse(result.result_errors!['@visualizations.flow.broken'])).toEqual([
      expect.objectContaining({ code: 'invalid_value', path: ['contract', 'visualization', 'weighting'] }),
    ])
  }
})

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
