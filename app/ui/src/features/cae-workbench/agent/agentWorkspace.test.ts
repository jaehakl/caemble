// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultExperimentSourceBundle } from '@/lib/defaultExperimentCode'
import { createCadSourceDocument } from '@/lib/cad'
import { validateAgentWorkspace } from './agentWorkspace'

const mocks = vi.hoisted(() => ({
  cadSourceHash: vi.fn(),
  evaluateDocument: vi.fn(),
  fetchCatalogRuntimeSlice: vi.fn(),
  generateRandomVars: vi.fn(),
  inspectDocument: vi.fn(),
}))

vi.mock('@/lib/cad', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cad')>()),
  cadSourceHash: mocks.cadSourceHash,
  evaluateDocument: mocks.evaluateDocument,
  generateRandomVars: mocks.generateRandomVars,
  inspectDocument: mocks.inspectDocument,
}))

vi.mock('@/lib/catalog/references', () => ({ fetchCatalogRuntimeSlice: mocks.fetchCatalogRuntimeSlice }))

const document = createCadSourceDocument('experiment', defaultExperimentSourceBundle)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cadSourceHash.mockResolvedValue('a'.repeat(64))
  mocks.fetchCatalogRuntimeSlice.mockResolvedValue({ catalogRevision: 'catalog-v1' })
  mocks.inspectDocument.mockResolvedValue({ sourceHash: 'b'.repeat(64), varsSchema: { width: { min: 1, max: 10 } } })
  mocks.generateRandomVars.mockReturnValue({ width: 5 })
  mocks.evaluateDocument.mockResolvedValue({
    kind: 'experiment',
    sourceHash: 'b'.repeat(64),
    variables: { width: 5 },
    varsSchema: { width: { min: 1, max: 10 } },
    scene: { sceneHash: 'c'.repeat(64) },
    taskScenes: { main: { sceneHash: 'd'.repeat(64) } },
    simulationProgram: {},
  })
})

describe('validateAgentWorkspace', () => {
  it('reuses one generated Candidate for repeated validation in the same run and schema', async () => {
    const cache = new Map()

    const first = await validateAgentWorkspace('run-1', document.sourceBundle, cache)
    const second = await validateAgentWorkspace('run-1', document.sourceBundle, cache)

    expect(first).toMatchObject({
      status: 'valid',
      catalogFingerprint: 'catalog-v1',
      sceneHash: 'c'.repeat(64),
      taskSceneHashes: { main: 'd'.repeat(64) },
    })
    expect(second.status).toBe('valid')
    expect(mocks.generateRandomVars).toHaveBeenCalledTimes(1)
    expect(mocks.evaluateDocument.mock.calls[0][0].vars).toBe(mocks.evaluateDocument.mock.calls[1][0].vars)
  })

  it('reuses each schema Candidate when a run returns to an earlier schema', async () => {
    const cache = new Map()
    const firstSchema = { width: { min: 1, max: 10 } }
    const secondSchema = { height: { min: 2, max: 20 } }
    mocks.inspectDocument
      .mockResolvedValueOnce({ sourceHash: 'b'.repeat(64), varsSchema: firstSchema })
      .mockResolvedValueOnce({ sourceHash: 'b'.repeat(64), varsSchema: secondSchema })
      .mockResolvedValueOnce({ sourceHash: 'b'.repeat(64), varsSchema: firstSchema })
    mocks.generateRandomVars.mockReturnValueOnce({ width: 5 }).mockReturnValueOnce({ height: 8 })

    await validateAgentWorkspace('run-1', document.sourceBundle, cache)
    await validateAgentWorkspace('run-1', document.sourceBundle, cache)
    await validateAgentWorkspace('run-1', document.sourceBundle, cache)

    expect(mocks.generateRandomVars).toHaveBeenCalledTimes(2)
    expect(mocks.evaluateDocument.mock.calls[0][0].vars).toBe(mocks.evaluateDocument.mock.calls[2][0].vars)
  })

  it('reports catalog fetch failures as unavailable instead of invalid source', async () => {
    mocks.fetchCatalogRuntimeSlice.mockRejectedValueOnce(new Error('offline'))

    const result = await validateAgentWorkspace('run-1', document.sourceBundle, new Map())

    expect(result).toMatchObject({ status: 'unavailable', error: { kind: 'catalog', message: 'offline' } })
    expect(mocks.inspectDocument).not.toHaveBeenCalled()
  })

  it('stops waiting for a catalog request when Agent validation is cancelled', async () => {
    mocks.fetchCatalogRuntimeSlice.mockReturnValueOnce(new Promise(() => undefined))
    const controller = new AbortController()

    const pending = validateAgentWorkspace('run-1', document.sourceBundle, new Map(), {
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(mocks.fetchCatalogRuntimeSlice).toHaveBeenCalled())
    controller.abort()

    await expect(pending).resolves.toMatchObject({ status: 'unavailable', error: { kind: 'cancelled' } })
    expect(mocks.inspectDocument).not.toHaveBeenCalled()
  })

  it('rejects a staged bundle missing required files before catalog access', async () => {
    const result = await validateAgentWorkspace(
      'run-1',
      { ...document.sourceBundle, files: { 'experiment.tsx': 'export default {}' } },
      new Map(),
    )

    expect(result).toMatchObject({ status: 'invalid', error: { kind: 'structural' } })
    expect(mocks.fetchCatalogRuntimeSlice).not.toHaveBeenCalled()
  })
})
