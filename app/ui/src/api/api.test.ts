import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('./http', () => ({ API_URL: '/api', request: mocks.request }))

import { dbTables, getListRequest } from './api'
import { catalogApi } from './catalog'
import type { ExperimentRecord, MeasurementRecord } from './types'

const sourceHash = 'a'.repeat(64)
const sourceBundle = {
  formatVersion: 6 as const,
  files: {
    'experiment.tsx': 'export default experiment({})',
    'geometry.tsx': 'export {}\n',
    'material.tsx': 'export {}\n',
    'simulate.py': 'async def simulate(*, sim, tasks, vars): pass',
    'tasks/main.tsx': 'export default defineTask({})',
  },
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
    expect(dbTables).not.toHaveProperty('GeometryRepository')
    expect(dbTables).not.toHaveProperty('GeometryPackage')
    expect(dbTables).not.toHaveProperty('GeometryVersion')
  })

  it('parses Experiment rows with authoritative source_hash', async () => {
    const row: ExperimentRecord = {
      id: 7,
      user_id: 'user-1',
      namespace: 'jlee',
      repository_slug: 'examples',
      experiment_key: 'integrated',
      version_major: 1,
      version_minor: 2,
      version_patch: 3,
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

  it('saves format v6 bundles as a new SemVer Version', async () => {
    const response = {
      id: 7,
      action: 'new_version' as const,
      namespace: 'jlee',
      repository: 'examples',
      key: 'integrated',
      version: '1.2.4',
      coordinate: 'caemble:experiment/jlee/examples/integrated@1.2.4',
      bundleHash: sourceHash,
      sourceLocked: false,
      derivedCounts: { measurements: 0, recordedData: 0, designerModels: 0, predictorModels: 0 },
    }
    mocks.request.mockResolvedValueOnce(response)

    await expect(
      dbTables.Experiment.save({
        mode: 'new_version',
        experimentId: 4,
        namespace: 'jlee',
        repository: 'examples',
        key: 'integrated',
        name: 'Experiment',
        description: null,
        sourceBundle,
        bundleHash: sourceHash,
        baseBundleHash: 'b'.repeat(64),
        bump: 'patch',
      }),
    ).resolves.toEqual(response)
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

describe('Example Experiment catalog identity', () => {
  it('uses the full namespace, repository, key, and SemVer selector for detail requests', async () => {
    const identity = {
      key: 'integrated',
      namespace: 'caemble',
      repository: 'verified',
      version: '2.1.0',
      coordinate: 'caemble:experiment/caemble/verified/integrated@2.1.0',
    }
    mocks.request.mockResolvedValueOnce({
      ...identity,
      title: 'Integrated',
      description: 'Example Experiment.',
      cadApiVersion: 9,
      sourceFormatVersion: 2,
      bundleFormatVersion: 6,
      bundleHash: sourceHash,
      concepts: [],
      relatedSolvers: [],
      sourceBundle,
      verification: { kernelTasks: ['main'], recordedData: [], expectations: [] },
    })

    await expect(catalogApi.getExperiment(identity)).resolves.toMatchObject(identity)
    expect(mocks.request).toHaveBeenCalledWith(
      'get',
      '/catalog/experiments/integrated?namespace=caemble&repository=verified&version=2.1.0',
    )
  })
})
