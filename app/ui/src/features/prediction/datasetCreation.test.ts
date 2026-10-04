import { beforeEach, expect, it, vi } from 'vitest'
import type { ExperimentRecordedDataRecord } from '@caemble/execution/contracts/api/experiment'
import { PredictionAssetController, type PredictionAssetWork } from './assetManagement'
import { createStandaloneDataset } from './datasetCreation'
import { datasetFixture } from './datasetFiles.fixture'

const mocks = vi.hoisted(() => ({ create: vi.fn(), catalog: vi.fn(), inspect: vi.fn(), prepare: vi.fn() }))
vi.mock('@/api/prediction', () => ({ predictionApi: { createDataset: mocks.create } }))
vi.mock('@/api/catalog', () => ({ catalogApi: { runtimeSlice: mocks.catalog } }))
vi.mock('@caemble/execution/catalog/references', () => ({
  createCachedCatalogRuntimeSliceResolver: () => mocks.catalog,
}))
vi.mock('@/lib/cad/execution/evaluateDocument', () => ({
  inspectDocument: mocks.inspect,
  preparePredictionDocument: mocks.prepare,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.catalog.mockResolvedValue({ catalogRevision: 'fixture' })
  mocks.inspect.mockResolvedValue({ varsSchema: { x: { shape: [], min: 3, max: 3 } } })
  mocks.prepare.mockResolvedValue({
    varsSchema: { x: { shape: [], min: 3, max: 3 } },
    simulationProgram: { recordedData: {}, resultContracts: {} },
  })
  mocks.create.mockResolvedValue(datasetFixture)
})

it('creates from saved source without connecting a Predictor and retries the identical frozen body', async () => {
  const manager = new PredictionAssetController('user:test', 'all')
  const work = {
    signal: new AbortController().signal,
    progress: vi.fn(),
    connect: vi.fn(),
  } as unknown as PredictionAssetWork
  let retry!: (work: PredictionAssetWork) => Promise<unknown>
  vi.spyOn(manager, 'run').mockImplementation(async (_key, _label, callback) => {
    retry = callback
    return callback(work)
  })
  const experiment = {
    id: 1,
    source_hash: 'a'.repeat(64),
    source_bundle: { files: { 'experiment.tsx': 'saved source' } },
  }
  const records = [
    { id: 11, name: '온도' },
    { id: 22, name: '압력' },
  ] as ExperimentRecordedDataRecord[]
  expect(await createStandaloneDataset(manager, { experiment, records, recordIds: [11], name: ' 새 원본 ' })).toBe(
    datasetFixture,
  )
  expect(mocks.prepare).toHaveBeenCalledWith(
    { document: { kind: 'experiment', sourceBundle: experiment.source_bundle }, vars: { x: 3 } },
    ['온도'],
    expect.anything(),
  )
  expect(mocks.create.mock.calls[0][0]).toMatchObject({
    name: '새 원본',
    record_ids: [11],
    source_hash: experiment.source_hash,
    experiment_id: 1,
    calculation_ids: [],
  })
  await retry(work)
  expect(mocks.create.mock.calls[0]).toEqual(mocks.create.mock.calls[1])
  expect(mocks.prepare).toHaveBeenCalledOnce()
  expect(work.connect).not.toHaveBeenCalled()
})

it('does not create data when source preparation fails', async () => {
  const manager = new PredictionAssetController('user:test', 'all')
  vi.spyOn(manager, 'run').mockImplementation(async (_key, _label, callback) =>
    callback({ signal: new AbortController().signal, progress: vi.fn() } as unknown as PredictionAssetWork),
  )
  mocks.inspect.mockRejectedValue(new Error('invalid source'))
  await expect(
    createStandaloneDataset(manager, {
      experiment: { id: 1, source_hash: 'a'.repeat(64), source_bundle: { files: {} } },
      records: [{ id: 11, name: '온도' }] as ExperimentRecordedDataRecord[],
      recordIds: [11],
      name: '실패',
    }),
  ).rejects.toThrow('invalid source')
  expect(mocks.create).not.toHaveBeenCalled()
})
