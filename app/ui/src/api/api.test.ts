import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('./http', () => ({ API_URL: '/api', request: mocks.request }))

import { dbTables, getListRequest } from './api'
import type { ExperimentRecord, MeasurementRecord } from './types'

const sourceHash = 'a'.repeat(64)
const sourceBundle = {
  formatVersion: 5 as const,
  files: {
    'experiment.tsx': 'export default experiment({})',
    'geometry.tsx': 'export {}\n',
    'material.tsx': 'export {}\n',
    'simulate.py': 'async def simulate(*, sim, tasks, vars): pass',
    'tasks/main.tsx': 'export default defineTask({})',
  },
  geometrySnapshot: { schemaVersion: 2 as const, entryImports: [], modules: [] },
}

beforeEach(() => mocks.request.mockReset())

describe('integrated Experiment API facade', () => {
  it('exposes only the integrated Experiment and Measurement tables', () => {
    expect(dbTables).toHaveProperty('Experiment')
    expect(dbTables).toHaveProperty('Measurement')
    expect(dbTables).toHaveProperty('RecordedData')
    expect(dbTables).not.toHaveProperty('Structure')
    expect(dbTables).not.toHaveProperty('Sample')
    expect(dbTables).not.toHaveProperty('Setup')
  })

  it('parses Experiment rows with authoritative source_hash', async () => {
    const row: ExperimentRecord = {
      id: 7,
      user_id: 'user-1',
      parent_id: null,
      name: 'Integrated experiment',
      description: null,
      source_bundle: sourceBundle,
      source_hash: sourceHash,
    }
    mocks.request.mockResolvedValueOnce({ total: 1, items: [row] })

    await expect(dbTables.Experiment.listRows(getListRequest('mine', [7]))).resolves.toEqual({
      total: 1,
      items: [row],
    })
    expect(mocks.request).toHaveBeenCalledWith(
      'post',
      '/experiment/list',
      expect.objectContaining({ selected_ids: [7] }),
    )
  })

  it('saves format v5 bundles with bundle hashes and returns sourceHash', async () => {
    mocks.request.mockResolvedValueOnce({ id: 7, action: 'forked', parentId: 4, sourceHash })

    await expect(
      dbTables.Experiment.save({
        id: 4,
        name: 'Experiment',
        description: null,
        sourceBundle,
        bundleHash: sourceHash,
        baseBundleHash: 'b'.repeat(64),
      }),
    ).resolves.toEqual({ id: 7, action: 'forked', parentId: 4, sourceHash })
  })

  it('creates a prepared Measurement and records results through separate endpoints', async () => {
    mocks.request.mockResolvedValueOnce({ id: 21 }).mockResolvedValueOnce({ id: 21 })

    await expect(
      dbTables.Measurement.create({
        experiment_id: 7,
        experiment_source_hash: sourceHash,
        vars: { width: 2 },
        material_parameters: {
          schemaVersion: 2,
          experiment: { schemaVersion: 1, materials: {} },
          tasks: { main: { schemaVersion: 1, materials: {} } },
        },
      }),
    ).resolves.toEqual({ id: 21 })
    await expect(
      dbTables.Measurement.record(21, {
        recorded_data: [
          {
            name: 'temperature',
            quantity_kind: 'ThermodynamicTemperature',
            tensor_order: 0,
            dtype: 'float64',
            data_schema: { dtype: 'float64', unit: 'K', quantityKind: 'ThermodynamicTemperature' },
            data: 300,
          },
        ],
      }),
    ).resolves.toEqual({ id: 21 })

    expect(mocks.request.mock.calls.map(([, path]) => path)).toEqual(['/measurement/create', '/measurement/21/record'])
  })

  it('parses prepared and recorded Measurement states from recorded_at', () => {
    const prepared: MeasurementRecord = {
      id: 1,
      experiment_id: 7,
      vars: {},
      material_parameters: {
        schemaVersion: 2,
        experiment: { schemaVersion: 1, materials: {} },
        tasks: { main: { schemaVersion: 1, materials: {} } },
      },
      recorded_at: null,
    }
    const recorded: MeasurementRecord = { ...prepared, id: 2, recorded_at: '2026-08-12T00:00:00Z' }
    expect(dbTables.Measurement.rowSchema.parse(prepared).recorded_at).toBeNull()
    expect(dbTables.Measurement.rowSchema.parse(recorded).recorded_at).toBeTruthy()
  })
})
