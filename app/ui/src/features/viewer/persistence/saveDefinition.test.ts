import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCadSourceDocument, createExperimentSourceBundle, createExperimentSourceBundleV3 } from '@/lib/cad'
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

  it('matches the recursively sorted Python API hash for a v3 bundle', async () => {
    const bundle = createExperimentSourceBundleV3(
      {
        'tasks/main.tsx': 'task',
        'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
        'experiment.tsx': 'experiment source',
      },
      { schemaVersion: 1, roots: [], modules: [] },
    )

    await expect(experimentSourceBundleHash(bundle)).resolves.toBe(
      '63afac457936fbea2406f09f3d61695ed9ec07bed5fc6a911f4201bd6a3919ac',
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
      '8d2ca7babb3abc218f9990f61625a56ea59b4fc1b3908f072412fa51b7f72117',
    )
  })
})
