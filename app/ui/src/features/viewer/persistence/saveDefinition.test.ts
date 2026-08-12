import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCadSourceDocument, createExperimentSourceBundle } from '@/lib/cad'
import { experimentSourceBundleHash, saveCadDefinition } from './saveDefinition'

const mocks = vi.hoisted(() => ({ experimentSave: vi.fn() }))

vi.mock('@/api', () => ({ dbTables: { Experiment: { save: mocks.experimentSave } } }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.experimentSave.mockResolvedValue({
    id: 9,
    action: 'forked',
    parentId: 8,
    sourceHash: 'a'.repeat(64),
  })
})

describe('saveCadDefinition', () => {
  it('atomically includes current and base bundle hashes for an Experiment revision', async () => {
    const baseBundle = createExperimentSourceBundle({
      'experiment.tsx': 'experiment source',
      'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return 1\n',
      'tasks/main.tsx': 'task',
    })
    const sourceBundle = createExperimentSourceBundle({
      ...baseBundle.files,
      'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return 2\n',
    })
    const document = createCadSourceDocument('experiment', sourceBundle)

    const result = await saveCadDefinition({
      document,
      savedSourceBundle: baseBundle,
      selectedId: 8,
      values: { name: 'Python child', description: 'atomic sources' },
    })

    expect(mocks.experimentSave).toHaveBeenCalledWith({
      id: 8,
      name: 'Python child',
      description: 'atomic sources',
      sourceBundle,
      bundleHash: await experimentSourceBundleHash(sourceBundle),
      baseBundleHash: await experimentSourceBundleHash(baseBundle),
    })
    expect(result).toEqual({
      id: 9,
      action: 'forked',
      parentId: 8,
      sourceHash: 'a'.repeat(64),
      sourceBundle,
    })
  })

  it('creates a new root without an id or base hash', async () => {
    const sourceBundle = createExperimentSourceBundle({
      'experiment.tsx': 'experiment source',
      'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
      'tasks/main.tsx': 'task',
    })
    await saveCadDefinition({
      document: createCadSourceDocument('experiment', sourceBundle),
      forceRoot: true,
      savedSourceBundle: sourceBundle,
      selectedId: 8,
      values: { name: 'New root', description: '' },
    })

    expect(mocks.experimentSave).toHaveBeenCalledWith({
      name: 'New root',
      description: null,
      sourceBundle,
      bundleHash: await experimentSourceBundleHash(sourceBundle),
    })
  })
})
