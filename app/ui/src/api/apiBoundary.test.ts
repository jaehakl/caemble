import { afterEach, describe, expect, it, vi } from 'vitest'
import { dbTables, getListRequest } from './api'
import { ApiContractError } from './http'
import { parseCalculationListResponse } from '@/contracts/api/calculationValidators'
import { parseExperimentListResponse } from '@/contracts/api/experimentValidators'
import { parseMaterialNameListResponse } from '@/contracts/api/materialValidators'
import { parseMeasurementListResponse } from '@/contracts/api/measurementValidators'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('API read boundaries', () => {
  it('wraps malformed persisted items in ApiContractError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: 'not-a-database-id',
              experiment_id: 1,
              vars: {},
              material_parameters: {},
              recorded_at: null,
              calculation_data_count: 0,
            },
          ],
          total: 1,
        }),
      ),
    )

    const result = dbTables.Measurement.listRows(getListRequest())

    await expect(result).rejects.toBeInstanceOf(ApiContractError)
    await expect(result).rejects.toMatchObject({ path: '/measurement/list' })
  })

  it('validates the recursive Measurement recorded-data response', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        recorded_data: {
          malformed: {
            experiment_record_id: 1,
            quantity_kind: null,
            tensor_order: 0,
            dtype: 'float64',
            data_schema: null,
          },
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = dbTables.Measurement.readRecordedData(7, { signal: controller.signal })

    await expect(result).rejects.toBeInstanceOf(ApiContractError)
    await expect(result).rejects.toMatchObject({ path: '/measurement/7/recorded-data' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/measurement/7/recorded-data',
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it('validates identity and relationship fields for core persisted domains', () => {
    expect(() => parseMaterialNameListResponse({ items: [{ id: 1, name: 'Steel' }], total: 1 })).toThrow()
    expect(() => parseExperimentListResponse({ items: [{ id: 1 }], total: 1 })).toThrow()
    expect(() => parseMeasurementListResponse({ items: [{ id: 1 }], total: 1 })).toThrow()
    expect(() => parseCalculationListResponse({ items: [{ id: 1 }], total: 1 })).toThrow()
  })

  it('keeps unmodeled response fields while validating core persisted fields', () => {
    const materialNames = parseMaterialNameListResponse({
      items: [{ id: 1, material_id: 2, name: 'Steel', future_field: 'kept' }],
      total: 1,
    })
    const experiments = parseExperimentListResponse({
      items: [
        {
          id: 1,
          namespace: 'user',
          repository_slug: 'workspace',
          experiment_key: 'beam',
          version_major: 1,
          version_minor: 0,
          version_patch: 0,
          name: 'Beam',
          source_bundle: { files: { 'experiment.tsx': 'export default null' } },
          source_hash: 'source-hash',
          future_field: 'kept',
        },
      ],
      total: 1,
    })
    const measurements = parseMeasurementListResponse({
      items: [
        {
          id: 1,
          experiment_id: 2,
          vars: {},
          material_parameters: {},
          recorded_at: null,
          calculation_data_count: 0,
          future_field: 'kept',
        },
      ],
      total: 1,
    })
    const calculations = parseCalculationListResponse({
      items: [
        {
          id: 1,
          experiment_id: 2,
          name: 'Stress',
          source_code: 'return 0',
          contract_status: 'needs_preflight',
          experiment_record_ids: [],
          future_field: 'kept',
        },
      ],
      total: 1,
    })

    expect(materialNames.items[0]).toHaveProperty('future_field', 'kept')
    expect(experiments.items[0]).toHaveProperty('future_field', 'kept')
    expect(measurements.items[0]).toHaveProperty('future_field', 'kept')
    expect(calculations.items[0]).toHaveProperty('future_field', 'kept')
  })
})
