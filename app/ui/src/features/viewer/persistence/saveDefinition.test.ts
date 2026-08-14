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

  it('matches the recursively sorted Python API hash for a v5 bundle', async () => {
    const bundle = createExperimentSourceBundle({
      'tasks/main.tsx': 'task',
      'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
      'experiment.tsx': 'experiment source',
    })

    await expect(experimentSourceBundleHash(bundle)).resolves.toBe(
      '54c79cdb2aef16e11084bb9563bdbccbef1c408682ce711f343dde1e24485733',
    )
  })

  it('matches Python Unicode code-point ordering for mixed-case Task paths', async () => {
    const bundle = createExperimentSourceBundle({
      'tasks/a.tsx': 'lower task',
      'tasks/Z.tsx': 'upper task',
      'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
      'experiment.tsx': 'experiment source',
    })

    await expect(experimentSourceBundleHash(bundle)).resolves.toBe(
      '7a1f2b4093055ae3009d896186672c2cd1823352211adf889c72fcfa2cb09b20',
    )
  })
})
