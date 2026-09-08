import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBatchArtifact, type BrowserBatchIntent } from './buildBatchArtifact'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  saveItem: vi.fn(),
  saveManifest: vi.fn(),
  close: vi.fn(),
  catalog: vi.fn(),
  experiment: vi.fn(),
}))
vi.mock('@/api', () => ({ dbTables: { Experiment: { listRows: mocks.experiment } }, getListRequest: () => ({}) }))
vi.mock('@/api/submitArtifact', () => ({ sha256Bytes: async () => 'a'.repeat(64) }))
vi.mock('@/features/viewer/workspace/catalogRuntime', () => ({ fetchCatalogRuntimeSlice: mocks.catalog }))
vi.mock('@/platform/browser/build', () => ({ prepareBrowserMeasurement: mocks.prepare }))
vi.mock('@/platform/browser/artifactStore', () => ({
  BrowserArtifactStore: {
    open: async () => ({ saveItem: mocks.saveItem, saveManifest: mocks.saveManifest, close: mocks.close }),
  },
}))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.experiment.mockResolvedValue({ items: [{ id: 1, source_bundle: { files: { 'experiment.tsx': 'source' } } }] })
  mocks.catalog.mockResolvedValue({ catalogRevision: 'catalog' })
  mocks.prepare.mockImplementation(async ({ vars }) => ({
    measurement: {
      kind: 'measurement',
      experiment: { sourceHash: 'source', variables: vars },
      materialSnapshot: { value: vars.x * 2 },
    },
  }))
})

describe('multiple Candidate artifact preparation', () => {
  it('prepares distinct Vars sequentially and accepts centers before selecting the next candidate', async () => {
    const accepted: number[] = []
    const request: BrowserBatchIntent = {
      request_id: 'request',
      experiment_id: 1,
      experiment_source_hash: 'source',
      mode: 'candidate',
      candidates: {
        count: 3,
        next: async (attempt) => {
          expect(accepted.length).toBe(attempt - 1)
          return { x: attempt }
        },
        accepted: async (attempt) => {
          accepted.push(attempt)
        },
        failed: vi.fn(),
      },
    }
    const { artifact } = await buildBatchArtifact(request, new AbortController().signal, vi.fn())
    expect(artifact.mode).toBe('candidate')
    expect(artifact.items.map((item) => item.index)).toEqual([1, 2, 3])
    expect(mocks.prepare.mock.calls.map(([input]) => input.vars)).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }])
    expect(
      mocks.saveItem.mock.calls.map(
        ([, bytes]) => JSON.parse(new TextDecoder().decode(bytes)).measurement.materialSnapshot.value,
      ),
    ).toEqual([2, 4, 6])
    expect(mocks.catalog).toHaveBeenCalledOnce()
    expect(mocks.experiment).toHaveBeenCalledOnce()
  })

  it('skips failed preparation and assigns contiguous artifact indexes', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('invalid candidate'))
    const failed = vi.fn()
    const accepted = vi.fn()
    const { artifact } = await buildBatchArtifact(
      {
        request_id: 'partial',
        experiment_id: 1,
        experiment_source_hash: 'source',
        mode: 'candidate',
        candidates: { count: 2, next: async (attempt) => ({ x: attempt }), accepted, failed },
      },
      new AbortController().signal,
      vi.fn(),
    )
    expect(artifact.items.map((item) => item.index)).toEqual([1])
    expect(failed).toHaveBeenCalledWith(1, expect.any(Error))
    expect(accepted).toHaveBeenCalledExactlyOnceWith(2)
  })

  it.each(['failed', 'cancelled'] as const)('does not finalize a manifest when preparation is %s', async (scenario) => {
    const controller = new AbortController()
    mocks.prepare.mockImplementation(async () => {
      if (scenario === 'cancelled') controller.abort()
      throw new Error('preparation failure')
    })
    await expect(
      buildBatchArtifact(
        {
          request_id: 'empty',
          experiment_id: 1,
          experiment_source_hash: 'source',
          mode: 'candidate',
          candidates: { count: 2, next: async () => ({ x: 1 }), accepted: vi.fn(), failed: vi.fn() },
        },
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toThrow()
    expect(mocks.saveManifest).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledOnce()
    if (scenario === 'cancelled') expect(mocks.prepare).toHaveBeenCalledOnce()
  })
})
