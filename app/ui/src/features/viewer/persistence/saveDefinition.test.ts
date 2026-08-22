import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCadSourceDocument, createExperimentSourceBundle } from '@/lib/cad'
import { experimentSourceBundleHash, saveCadDefinition } from './saveDefinition'

const mocks = vi.hoisted(() => ({ experimentSave: vi.fn() }))

vi.mock('@/api', () => ({ dbTables: { Experiment: { save: mocks.experimentSave } } }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.experimentSave.mockResolvedValue({
    id: 9,
    action: 'new_version',
    namespace: 'jlee',
    repository: 'examples',
    key: 'python',
    version: '1.2.4',
    coordinate: 'caemble:experiment/jlee/examples/python@1.2.4',
    bundleHash: 'a'.repeat(64),
    sourceLocked: false,
    derivedCounts: { measurements: 0, recordedData: 0, designerModels: 0, predictorModels: 0 },
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
      mode: 'new_version',
      savedSourceBundle: baseBundle,
      selectedId: 8,
      values: {
        name: 'Python child',
        description: 'atomic sources',
        repository: 'examples',
        key: 'python',
        bump: 'patch',
      },
    })

    expect(mocks.experimentSave).toHaveBeenCalledWith({
      mode: 'new_version',
      experimentId: 8,
      name: 'Python child',
      description: 'atomic sources',
      sourceBundle,
      bundleHash: await experimentSourceBundleHash(sourceBundle),
      baseBundleHash: await experimentSourceBundleHash(baseBundle),
      bump: 'patch',
    })
    expect(result.sourceBundle).toEqual(sourceBundle)
    expect(result.action).toBe('new_version')
  })

  it('creates a new root without an id or base hash', async () => {
    const sourceBundle = createExperimentSourceBundle({
      'experiment.tsx': 'experiment source',
      'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
      'tasks/main.tsx': 'task',
    })
    await saveCadDefinition({
      document: createCadSourceDocument('experiment', sourceBundle),
      mode: 'create',
      savedSourceBundle: sourceBundle,
      selectedId: 8,
      values: { name: 'New root', description: '', repository: 'common', key: 'new-root', bump: 'patch' },
    })

    expect(mocks.experimentSave).toHaveBeenCalledWith({
      name: 'New root',
      description: null,
      mode: 'create',
      repository: 'common',
      key: 'new-root',
      initialVersion: '0.1.0',
      sourceBundle,
      bundleHash: await experimentSourceBundleHash(sourceBundle),
    })
  })

  it('hashes a v6 bundle independently of file insertion order', async () => {
    const bundle = createExperimentSourceBundle({
      'tasks/main.tsx': 'task',
      'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
      'experiment.tsx': 'experiment source',
    })

    const reordered = createExperimentSourceBundle({
      'experiment.tsx': 'experiment source',
      'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
      'tasks/main.tsx': 'task',
    })
    await expect(experimentSourceBundleHash(bundle)).resolves.toBe(await experimentSourceBundleHash(reordered))
  })

  it('matches Python Unicode code-point ordering for mixed-case Task paths', async () => {
    const bundle = createExperimentSourceBundle({
      'tasks/a.tsx': 'lower task',
      'tasks/Z.tsx': 'upper task',
      'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
      'experiment.tsx': 'experiment source',
    })

    await expect(experimentSourceBundleHash(bundle)).resolves.toMatch(/^[0-9a-f]{64}$/)
  })
})
