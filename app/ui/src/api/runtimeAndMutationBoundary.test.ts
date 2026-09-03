import { afterEach, describe, expect, it, vi } from 'vitest'
import { dbTables } from './api'
import { ApiContractError } from './http'
import {
  parseCalculationDataMissingResponse,
  parseCalculationDataSaveResponse,
} from '@/contracts/api/calculationValidators'
import {
  parseExperimentListResponse,
  parseExperimentUsageResponse,
  parseSaveExperimentResponse,
} from '@/contracts/api/experimentValidators'
import {
  parseAccessKeyCreateResponse,
  parseAccessKeyListResponse,
  parseDeletedResponse,
  parseJobSummaryList,
  parseLauncherListResponse,
  parseLauncherReconcileResponse,
  parseLauncherRuntimeList,
  parseOkResponse,
} from '@/contracts/api/runtimeValidators'
import { parseBooleanResponse, parseEmptyResponse } from '@/contracts/api/validators'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('runtime response contracts', () => {
  it('preserves nullable AccessKey names and validates every list item', () => {
    const response = parseAccessKeyListResponse({
      total: 1,
      items: [
        {
          id: 'key-1',
          user_id: 'user-1',
          key_type: 'user_api',
          name: null,
          key_prefix: 'cae_1234',
          scopes: ['client'],
          status: 'active',
          future_field: 'kept',
        },
      ],
    })

    expect(response.items[0]).toMatchObject({ name: null, future_field: 'kept' })
    expect(() =>
      parseAccessKeyListResponse({
        total: 1,
        items: [{ id: 'key-1', name: null, scopes: 'client' }],
      }),
    ).toThrow()
  })

  it('validates Launcher rows and runtime snapshots', () => {
    expect(() =>
      parseLauncherListResponse({
        total: 1,
        items: [
          {
            id: 'launcher-1',
            user_id: 'user-1',
            launcher_name: 'Local',
            status: 'ready',
            slave_app_ids: 'cae',
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      parseLauncherRuntimeList([
        {
          launcher_id: 'launcher-1',
          resetting: false,
          metadata: [],
        },
      ]),
    ).toThrow()
  })

  it('allows backend-extensible Job states but rejects malformed progress metadata', () => {
    const baseJob = {
      id: 'job-1',
      user_id: 'user-1',
      handler_type: 'cae.start',
      slave_app_id: 'cae',
      state: 'future_state',
      launcher_id: null,
      attempt_count: 0,
      created_at: '2026-09-03T00:00:00+00:00',
      updated_at: '2026-09-03T00:00:00+00:00',
    }

    expect(parseJobSummaryList([{ ...baseJob, latest_progress: null }])[0]?.state).toBe('future_state')
    expect(() => parseJobSummaryList([{ ...baseJob, latest_progress: { progress: 50 } }])).toThrow()
  })

  it('validates runtime mutation acknowledgements and AccessKey creation', () => {
    const accessKey = {
      id: 'key-1',
      user_id: 'user-1',
      key_type: 'user_api',
      name: 'Local client',
      key_prefix: 'cae_1234',
      scopes: ['client'],
      status: 'active',
    }

    expect(parseAccessKeyCreateResponse({ access_key: accessKey, secret: 'secret' }).secret).toBe('secret')
    expect(() => parseAccessKeyCreateResponse({ access_key: accessKey, secret: '' })).toThrow()
    expect(() => parseDeletedResponse({ deleted: -1 })).toThrow()
    expect(() => parseLauncherReconcileResponse({ ok: false, launchers: 1 })).toThrow()
    expect(() => parseOkResponse({ ok: false })).toThrow()
  })
})

describe('core mutation response contracts', () => {
  it('accepts only the exact boolean and empty response shapes used by delete mutations', () => {
    expect(parseBooleanResponse(true)).toBe(true)
    expect(() => parseBooleanResponse({ deleted: true })).toThrow()
    expect(parseEmptyResponse(null)).toBeUndefined()
    expect(parseEmptyResponse(undefined)).toBeUndefined()
    expect(() => parseEmptyResponse({})).toThrow()
  })

  it('validates optional Experiment ownership metadata used by persisted drafts', () => {
    expect(() =>
      parseExperimentListResponse({
        total: 1,
        items: [
          {
            id: 1,
            user_id: 99,
            namespace: 'user',
            repository_slug: 'workspace',
            experiment_key: 'beam',
            version_major: 0,
            version_minor: 1,
            version_patch: 0,
            name: 'Beam',
            source_bundle: { files: {} },
            source_hash: 'hash',
          },
        ],
      }),
    ).toThrow()
  })

  it('validates Experiment save and usage payloads', () => {
    expect(() =>
      parseSaveExperimentResponse({
        id: 1,
        action: 'overwrite',
        namespace: 'user',
        repository: 'workspace',
        key: 'beam',
        version: '0.1.0',
        coordinate: 'caemble:experiment/user/workspace/beam@0.1.0',
        bundleHash: 'hash',
        sourceLocked: true,
        derivedCounts: { measurements: 1, recordedData: -1, calculations: 1 },
      }),
    ).toThrow()
    expect(() =>
      parseExperimentUsageResponse({
        items: [{ experimentId: '1', sourceLocked: false, derivedCounts: {} }],
      }),
    ).toThrow()
  })

  it('validates CalculationData target and save payloads', () => {
    expect(() =>
      parseCalculationDataMissingResponse({
        total: 1,
        items: [{ calculation_id: 0, measurement_id: 2 }],
      }),
    ).toThrow()
    expect(() => parseCalculationDataSaveResponse({ id: 1, created: 'yes' })).toThrow()
  })
})

describe('API validator wiring', () => {
  it('wraps malformed Job list responses with endpoint context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          {
            id: 'job-1',
            user_id: 'user-1',
            handler_type: 'cae.start',
            slave_app_id: 'cae',
            state: 'running',
            latest_progress: null,
            attempt_count: -1,
          },
        ]),
      ),
    )

    await expect(dbTables.Job.list()).rejects.toMatchObject({
      name: 'ApiContractError',
      path: '/web/jobs?active_only=true&limit=200',
    })
  })

  it('wraps malformed CalculationData save responses with endpoint context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ id: 1, created: 'yes' })),
    )

    const result = dbTables.CalculationData.save({
      calculation_id: 1,
      measurement_id: 2,
      source_hash: 'hash',
      data: { dtype: 'float64', shape: [], data: 1, axes: [] },
    })

    await expect(result).rejects.toBeInstanceOf(ApiContractError)
    await expect(result).rejects.toMatchObject({ path: '/calculation_data/save' })
  })
})
