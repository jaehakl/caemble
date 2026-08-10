import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { ZodError } from 'zod'
import authSource from '../features/auth/use-auth.ts?raw'
import apiSource from './api.ts?raw'
import indexSource from './index.ts?raw'
import typesSource from './types.ts?raw'
import type {
  ExperimentRecord,
  GeometryRecord,
  GetListRequest,
  MaterialParameterRecord,
  SampleRecord,
  StructureRecord,
  UserData,
} from './types'

type HasCodeEmbedding<T> = 'code_embedding' extends keyof T ? true : false

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
  vi.resetModules()
})
afterAll(() => server.close())

async function loadApi() {
  vi.stubEnv('VITE_API_BASE_URL', 'http://api.test')
  return import('./api')
}

describe('unified dbTables API', () => {
  it('keeps code entity records and row schemas free of code_embedding', () => {
    const geometryHasCodeEmbedding: HasCodeEmbedding<GeometryRecord> = false
    const structureHasCodeEmbedding: HasCodeEmbedding<StructureRecord> = false
    const experimentHasCodeEmbedding: HasCodeEmbedding<ExperimentRecord> = false

    expect(geometryHasCodeEmbedding).toBe(false)
    expect(structureHasCodeEmbedding).toBe(false)
    expect(experimentHasCodeEmbedding).toBe(false)
    expect(apiSource).not.toContain('code_embedding')
  })

  it('exports dbTables without legacy domain API aliases', () => {
    expect(indexSource).toContain('dbTables')
    expect(indexSource).not.toMatch(/structuresApi|experimentsApi|samplesApi|setupsApi/)
  })

  it('uses public Zod row schemas as the only table field contract', async () => {
    const userId: UserData['id'] = 'user-id'
    const roles: UserData['roles'] = ['user']
    const structureId: NonNullable<StructureRecord['id']> = 1
    const description: StructureRecord['description'] = null
    const sampleVars: SampleRecord['vars'] = { width: 2 }
    const materialValue: MaterialParameterRecord['value'] = null

    expect({ userId, roles, structureId, description, sampleVars, materialValue }).toEqual({
      userId: 'user-id',
      roles: ['user'],
      structureId: 1,
      description: null,
      sampleVars: { width: 2 },
      materialValue: null,
    })
    expect(typesSource).not.toContain('z.infer')
    expect(typesSource).not.toContain('./schemas')
    expect(apiSource).not.toMatch(/ColumnDefinition|ColumnMap|ColumnScalar|ColumnValue|RowFromColumns|getColumnSchema/)
    expect(apiSource).not.toMatch(/createCrudTable|\.extend\(|^const .*RowSchema/m)
    expect(authSource).toContain('queryFn: () => dbTables.User.fetchMe()')

    const { dbTables } = await loadApi()
    const rowSchemas = Object.values(dbTables).flatMap((table) => ('rowSchema' in table ? [table.rowSchema] : []))
    expect(new Set(rowSchemas)).toHaveLength(rowSchemas.length)
    for (const table of Object.values(dbTables)) {
      if (!('rowSchema' in table)) continue
      expect(table).toHaveProperty('rowSchema')
      expect(table).not.toHaveProperty('columns')
      expect(table).not.toHaveProperty('label')
    }
    expect(dbTables.Structure.rowSchema.parse({ name: 'Structure', code: 'export default structure({})' })).toEqual({
      name: 'Structure',
      code: 'export default structure({})',
    })
    expect(dbTables.Sample.rowSchema.parse({ structure_id: 1, vars: {}, material_parameters: {} })).toEqual({
      structure_id: 1,
      vars: {},
      material_parameters: {},
    })
  })

  it('validates string IDs, formats, lists, booleans, and datetimes with the User row schema', async () => {
    const validUser = {
      id: 'd7929429-84f8-4d92-865d-dc638d8e64e0',
      email: 'designer@example.com',
      display_name: null,
      picture_url: 'https://example.com/avatar.png',
      is_active: true,
      roles: ['user'],
      created_at: '2026-07-21T00:00:00Z',
      updated_at: null,
    }
    const { dbTables } = await loadApi()
    server.use(http.get('http://api.test/auth/me', () => HttpResponse.json(validUser)))
    await expect(dbTables.User.fetchMe()).resolves.toEqual(validUser)

    for (const invalidUser of [
      { ...validUser, id: 7 },
      { ...validUser, email: 'not-an-email' },
      { ...validUser, picture_url: 'not-a-url' },
      { ...validUser, is_active: 'yes' },
      { ...validUser, roles: [1] },
      { ...validUser, created_at: 123 },
    ]) {
      server.use(http.get('http://api.test/auth/me', () => HttpResponse.json(invalidUser)))
      await expect(dbTables.User.fetchMe()).rejects.toBeInstanceOf(ZodError)
    }
  })

  it('creates, lists, and revokes same-origin access tokens with CSRF protection', async () => {
    const token = {
      id: 'token-1',
      user_id: 'user-1',
      key_type: 'user_api',
      name: 'sdk',
      key_prefix: 'csk_example',
      scopes: ['client'],
      status: 'active',
    }
    const requests: { body: unknown; csrf: string | null; path: string }[] = []
    server.use(
      http.get('http://api.test/web/auth/csrf', () => HttpResponse.json({ csrf_token: 'csrf-test' })),
      http.post('http://api.test/web/crud/access_keys/list', async ({ request }) => {
        requests.push({
          body: await request.json(),
          csrf: request.headers.get('X-CSRF-Token'),
          path: '/list',
        })
        return HttpResponse.json({ total: 1, items: [token] })
      }),
      http.post('http://api.test/web/users/me/access-tokens', async ({ request }) => {
        requests.push({
          body: await request.json(),
          csrf: request.headers.get('X-CSRF-Token'),
          path: '/create',
        })
        return HttpResponse.json({ access_key: token, secret: 'csk_secret' })
      }),
      http.post('http://api.test/web/crud/access_keys/delete', async ({ request }) => {
        requests.push({
          body: await request.json(),
          csrf: request.headers.get('X-CSRF-Token'),
          path: '/delete',
        })
        return HttpResponse.json({ deleted: 1 })
      }),
    )
    const { dbTables } = await loadApi()

    await expect(dbTables.AccessKey.list()).resolves.toEqual({ total: 1, items: [token] })
    await expect(dbTables.AccessKey.create({ name: ' sdk ', scopes: ['client'] })).resolves.toEqual({
      access_key: token,
      secret: 'csk_secret',
    })
    await expect(dbTables.AccessKey.revoke('token-1')).resolves.toEqual({ deleted: 1 })
    expect(requests.map((item) => item.path)).toEqual(['/list', '/create', '/delete'])
    expect(requests.every((item) => item.csrf === 'csrf-test')).toBe(true)
    expect(requests[1].body).toEqual({ name: 'sdk', scopes: ['client'] })
  })

  it('validates the bounded latest progress contract on web job summaries', async () => {
    const job = {
      id: 'job-1',
      user_id: 'user-1',
      handler_type: 'cae.simulation.start',
      slave_app_id: 'cae',
      state: 'running',
      latest_progress: {
        time: '2031-04-05T06:07:08Z',
        progress: { stage: 'solve', completed: 42, total: 100 },
      },
      attempt_count: 1,
    }
    server.use(
      http.get('http://api.test/web/jobs', ({ request }) => {
        expect(new URL(request.url).searchParams.get('active_only')).toBe('true')
        return HttpResponse.json([job])
      }),
    )
    const { dbTables } = await loadApi()

    await expect(dbTables.Job.list(true)).resolves.toEqual([job])
  })

  it('validates numeric, FK, required, nullable, and JSON fields before sending', async () => {
    const calls: string[] = []
    server.use(
      http.post('http://api.test/:entity/upsert', ({ params }) => {
        calls.push(String(params.entity))
        return HttpResponse.json([{ id: 1 }])
      }),
    )
    const { dbTables } = await loadApi()

    await expect(
      dbTables.Structure.upsertRow([{ id: 1, name: 'Structure', description: null, code: 'export default null' }]),
    ).resolves.toEqual([{ id: 1 }])
    await expect(
      dbTables.MaterialParameter.upsertRow([{ material_id: 1, name: 'value', value: null, temperature: 293.15 }]),
    ).resolves.toEqual([{ id: 1 }])
    await expect(dbTables.Sample.upsertRow([{ structure_id: 1, vars: {}, material_parameters: {} }])).resolves.toEqual([
      { id: 1 },
    ])
    await expect(
      dbTables.RecordedData.upsertRow([
        {
          measurement_id: 1,
          name: 'Current',
          quantity_kind: 'ElectricCurrent',
          tensor_order: 0,
          dtype: 'float64',
          data: [1, 2],
        },
      ]),
    ).resolves.toEqual([{ id: 1 }])
    expect(calls).toEqual(['structure', 'material_parameter', 'sample', 'recorded_data'])

    const callsBeforeInvalidRecords = calls.length
    await expect(
      dbTables.Structure.upsertRow([{ id: null, name: 'Structure', code: 'export default null' } as never]),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      dbTables.Structure.upsertRow([{ parent_id: 1.5, name: 'Structure', code: 'export default null' }]),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      dbTables.MaterialParameter.upsertRow([{ material_id: 1, name: 'missing value' } as never]),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      dbTables.Sample.upsertRow([{ structure_id: 1, vars: [] as never, material_parameters: {} }]),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      dbTables.RecordedData.upsertRow([
        { measurement_id: 1, name: 'Current', quantity_kind: 'ElectricCurrent', tensor_order: 0.5, dtype: 'float64' },
      ]),
    ).rejects.toBeInstanceOf(ZodError)
    expect(calls).toHaveLength(callsBeforeInvalidRecords)
  })

  it('uses the dedicated Structure and Experiment semantic save endpoints', async () => {
    const seen: string[] = []
    server.use(
      http.post('http://api.test/:entity/save', ({ params }) => {
        seen.push(String(params.entity))
        return HttpResponse.json({ id: seen.length, action: seen.length === 1 ? 'updated' : 'forked', parentId: null })
      }),
    )
    const { dbTables } = await loadApi()
    const payload = {
      id: 1,
      name: 'Definition',
      description: null,
      code: 'export default 1',
      rawCodeHash: '1'.repeat(64),
      semanticHash: '2'.repeat(64),
      semanticHashVersion: 1 as const,
      baseRawCodeHash: '3'.repeat(64),
      baseSemanticHash: '4'.repeat(64),
    }

    await expect(dbTables.Structure.save(payload)).resolves.toMatchObject({ action: 'updated' })
    await expect(
      dbTables.Experiment.save({
        id: 1,
        name: 'Definition',
        description: null,
        sourceBundle: {
          formatVersion: 1,
          files: { 'experiment.tsx': 'experiment', 'simulate.py': 'simulate', 'tasks/main.tsx': 'task' },
        },
        bundleHash: '1'.repeat(64),
        semanticHash: '2'.repeat(64),
        semanticHashVersion: 2,
        baseBundleHash: '3'.repeat(64),
        baseSemanticHash: '4'.repeat(64),
      }),
    ).resolves.toMatchObject({ action: 'forked' })
    expect(seen).toEqual(['structure', 'experiment'])
  })

  it('validates Measurement context-list and atomic save contracts', async () => {
    const seen: Array<{ endpoint: string; payload: unknown }> = []
    server.use(
      http.post('http://api.test/measurement/:action', async ({ params, request }) => {
        seen.push({ endpoint: String(params.action), payload: await request.json() })
        return params.action === 'context-list'
          ? HttpResponse.json({
              total: 1,
              items: [{ id: 9, sample_id: 3, setup_id: 4 }],
            })
          : HttpResponse.json({ id: 9 })
      }),
    )
    const { dbTables } = await loadApi()

    await expect(dbTables.Measurement.listContext(1, 2)).resolves.toEqual({
      total: 1,
      items: [{ id: 9, sample_id: 3, setup_id: 4 }],
    })
    await expect(
      dbTables.Measurement.save({
        sample_id: 3,
        setup_id: 4,
        recorded_data: [
          {
            name: 'Current',
            quantity_kind: 'electromagnetism.ElectricCurrent',
            tensor_order: 0,
            dtype: 'float64',
            data_schema: {
              dtype: 'float64',
              unit: 'A',
              quantityKind: 'electromagnetism.ElectricCurrent',
            },
            data: { value: 2.5 },
          },
        ],
      }),
    ).resolves.toEqual({ id: 9 })
    expect(seen).toEqual([
      { endpoint: 'context-list', payload: { structure_id: 1, experiment_id: 2 } },
      {
        endpoint: 'save',
        payload: {
          sample_id: 3,
          setup_id: 4,
          recorded_data: [
            {
              name: 'Current',
              quantity_kind: 'electromagnetism.ElectricCurrent',
              tensor_order: 0,
              dtype: 'float64',
              data_schema: {
                dtype: 'float64',
                unit: 'A',
                quantityKind: 'electromagnetism.ElectricCurrent',
              },
              data: { value: 2.5 },
            },
          ],
        },
      },
    ])
    await expect(dbTables.Measurement.listContext(1.5, 2)).rejects.toBeInstanceOf(ZodError)
    await expect(
      dbTables.Measurement.save({
        sample_id: 3,
        setup_id: 4,
        recorded_data: [
          {
            name: 'Current',
            quantity_kind: 'electromagnetism.ElectricCurrent',
            tensor_order: -1,
            dtype: 'float64',
            data_schema: {
              dtype: 'float64',
              unit: 'A',
              quantityKind: 'electromagnetism.ElectricCurrent',
            },
            data: { value: 2.5 },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      dbTables.Measurement.save({
        sample_id: 3,
        setup_id: 4,
        recorded_data: [
          {
            name: 'Current',
            quantity_kind: 'electromagnetism.ElectricCurrent',
            tensor_order: 0,
            dtype: 'float64',
            data_schema: {
              dtype: 'float64',
              unit: 'A',
              quantityKind: 'electromagnetism.ElectricCurrent',
              axes: [{ name: 'time', unsupported: true }],
            },
          },
        ],
      } as never),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('reads shared RecordedData schemas and nullable legacy compatibility fields', async () => {
    const vectorSchema = {
      dtype: 'float32' as const,
      unit: 'A.m-2',
      quantityKind: 'electromagnetism.ElectricCurrentDensity',
      basis: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] as [[number, number, number], [number, number, number], [number, number, number]],
      axes: [{ name: 'point', length: 2 }],
    }
    server.use(
      http.post('http://api.test/recorded_data/list', () =>
        HttpResponse.json({
          total: 2,
          items: [
            {
              measurement_id: 1,
              name: 'Current density',
              quantity_kind: 'electromagnetism.ElectricCurrentDensity',
              tensor_order: 1,
              dtype: 'float32',
              data_schema: vectorSchema,
            },
            {
              measurement_id: 1,
              name: 'Labels',
              quantity_kind: null,
              tensor_order: 0,
              dtype: 'string',
              data_schema: null,
            },
          ],
        }),
      ),
    )
    const { dbTables } = await loadApi()

    await expect(dbTables.RecordedData.listRows()).resolves.toMatchObject({
      items: [{ data_schema: vectorSchema }, { data_schema: null, quantity_kind: null }],
    })
  })

  it('uses validated list, upsert, and delete contracts for every CRUD table', async () => {
    const definitions = [
      ['Material', 'material', { color: '#a1b2c3' }],
      ['MaterialName', 'material_name', { material_id: 1, name: 'Copper' }],
      ['MaterialParameter', 'material_parameter', { material_id: 1, name: 'conductivity', value: 5.96e7 }],
      [
        'MaterialParameterQualifier',
        'material_parameter_qualifier',
        { material_parameter_id: 1, name: 'temperature', value: 293.15 },
      ],
      ['Geometry', 'geometry', { name: 'Geometry', code: 'export default null' }],
      ['Structure', 'structure', { name: 'Structure', code: 'export default structure({})' }],
      [
        'Experiment',
        'experiment',
        {
          name: 'Experiment',
          source_bundle: {
            formatVersion: 1,
            files: { 'experiment.tsx': 'experiment', 'simulate.py': 'simulate', 'tasks/main.tsx': 'task' },
          },
        },
      ],
      ['Sample', 'sample', { structure_id: 1, vars: {}, material_parameters: {} }],
      ['Setup', 'setup', { experiment_id: 1, vars: {}, material_parameters: {} }],
      ['Measurement', 'measurement', { sample_id: 1, setup_id: 1 }],
      [
        'RecordedData',
        'recorded_data',
        { measurement_id: 1, name: 'Current', quantity_kind: 'ElectricCurrent', tensor_order: 0, dtype: 'float64' },
      ],
      ['DesignerModel', 'designer_model', { structure_id: 1, experiment_id: 1 }],
      ['PredictorModel', 'predictor_model', { structure_id: 1, experiment_id: 1 }],
    ] as const
    const seenLists: Array<{ endpoint: string; payload: unknown }> = []
    const seenUpserts: Array<{ endpoint: string; payload: unknown }> = []
    const seenDeletes: Array<{ endpoint: string; payload: unknown }> = []
    server.use(
      http.post('http://api.test/:entity/list', async ({ params, request }) => {
        seenLists.push({ endpoint: String(params.entity), payload: await request.json() })
        return HttpResponse.json({ total: 0, items: [] })
      }),
      http.post('http://api.test/:entity/upsert', async ({ params, request }) => {
        seenUpserts.push({ endpoint: String(params.entity), payload: await request.json() })
        return HttpResponse.json([{ id: 7, fk_not_found: null }])
      }),
      http.delete('http://api.test/:entity/', async ({ params, request }) => {
        seenDeletes.push({ endpoint: String(params.entity), payload: await request.json() })
        return HttpResponse.json(null)
      }),
    )

    const { dbTables, getListRequest } = await loadApi()
    for (const [tableName, endpoint, record] of definitions) {
      const table = dbTables[tableName] as {
        deleteRows: (ids: readonly number[]) => Promise<void>
        listRows: (request: GetListRequest) => Promise<unknown>
        rowSchema: { parse: (value: unknown) => unknown }
        upsertRow: (records: readonly unknown[]) => Promise<unknown>
      }
      expect(table.rowSchema.parse(record)).toEqual(record)
      await table.listRows(getListRequest('public'))
      await table.upsertRow([record])
      await table.deleteRows([7])
      expect(seenLists[seenLists.length - 1]).toEqual({
        endpoint,
        payload: expect.objectContaining({ scope: 'public' }),
      })
      expect(seenUpserts[seenUpserts.length - 1]).toEqual({ endpoint, payload: [record] })
      expect(seenDeletes[seenDeletes.length - 1]).toEqual({ endpoint, payload: [7] })
    }
  })

  it('rejects invalid list items and invalid upsert responses at runtime', async () => {
    server.use(
      http.post('http://api.test/structure/list', () =>
        HttpResponse.json({
          total: 1,
          items: [{ id: 1, name: 'Broken', code: 42 }],
        }),
      ),
      http.post('http://api.test/structure/upsert', () => HttpResponse.json([{ id: 'invalid' }])),
    )

    const { dbTables, getListRequest } = await loadApi()
    await expect(dbTables.Structure.listRows(getListRequest())).rejects.toBeInstanceOf(ZodError)
    await expect(
      dbTables.Structure.upsertRow([{ name: 'Valid input', code: 'export default null' }]),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects invalid outgoing records before sending a request', async () => {
    let calls = 0
    server.use(
      http.post('http://api.test/structure/upsert', () => {
        calls += 1
        return HttpResponse.json([{ id: 1 }])
      }),
    )

    const { dbTables } = await loadApi()
    await expect(dbTables.Structure.upsertRow([{ name: 123, code: null } as never])).rejects.toBeInstanceOf(ZodError)
    expect(calls).toBe(0)
  })

  it('validates non-table request and response contracts inline in api.ts', async () => {
    let calls = 0
    server.use(
      http.post('http://api.test/structure/list', () => {
        calls += 1
        return HttpResponse.json({ total: 0, items: [] })
      }),
      http.post('http://api.test/auth/logout', () => HttpResponse.json({ ok: false })),
    )
    const { dbTables, logout } = await loadApi()
    await expect(
      dbTables.Structure.listRows({
        scope: 'visible',
        offset: -1,
        limit: 24,
        selected_ids: [],
        search_text: null,
        text_filter: {},
        filter: {},
        sort: null,
      }),
    ).rejects.toBeInstanceOf(ZodError)
    expect(calls).toBe(0)
    await expect(logout()).rejects.toBeInstanceOf(ZodError)
  })
})
