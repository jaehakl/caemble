import { describe, expect, it, vi } from 'vitest'
import {
  CAD_SOURCE_API_VERSION,
  MAX_CAD_SOURCE_BYTES,
  addExperimentTask,
  assertExperimentSourceBundle,
  cadSourceHash,
  createCadSourceDocument,
  createExperimentSourceBundle,
  removeExperimentTask,
  rerollCadSourceDocument,
  updateCadSource,
  updateExperimentSourceFile,
} from './document'

function bundle() {
  return createExperimentSourceBundle({
    'experiment.tsx': 'experiment',
    'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
    'tasks/electric.tsx': 'electric task',
  })
}

describe('CadSourceDocument', () => {
  it('hashes sorted bundle paths and ignores realization seed', async () => {
    const document = createCadSourceDocument('experiment', bundle(), 7)
    const hash = await cadSourceHash(document)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    await expect(cadSourceHash({ ...document, realizationSeed: 99 })).resolves.toBe(hash)
    await expect(cadSourceHash(updateExperimentSourceFile(document, 'simulate.py', 'changed'))).resolves.not.toBe(hash)
  })

  it('adds and removes independent Task files but keeps the last Task', () => {
    const document = createCadSourceDocument('experiment', bundle(), 7)
    const added = addExperimentTask(document, 'thermal', 'thermal task')
    expect(Object.keys(added.sourceBundle.files)).toEqual([
      'experiment.tsx',
      'simulate.py',
      'tasks/electric.tsx',
      'tasks/thermal.tsx',
    ])
    expect(removeExperimentTask(added, 'electric').sourceBundle.files).toHaveProperty('tasks/thermal.tsx')
    expect(() => removeExperimentTask(document, 'electric')).toThrow('at least one Task')
  })

  it('changes only source on edits and only seed on reroll', () => {
    const document = createCadSourceDocument('structure', 'before', 7)
    const edited = updateCadSource(document, 'after')
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
      array[0] = 7
      return array
    }) as Crypto['getRandomValues'])
    expect(rerollCadSourceDocument(edited)).toEqual({ ...edited, realizationSeed: 8 })
    random.mockRestore()
  })

  it('validates paths, required files, UTF-8 sizes, and API v4', () => {
    expect(CAD_SOURCE_API_VERSION).toBe(4)
    expect(() => assertExperimentSourceBundle({ formatVersion: 1, files: { 'experiment.tsx': 'x' } })).toThrow(
      'requires experiment.tsx and simulate.py',
    )
    expect(() =>
      assertExperimentSourceBundle({
        formatVersion: 1,
        files: { 'experiment.tsx': 'x', 'simulate.py': 'x', '../task.tsx': 'x' },
      }),
    ).toThrow('path is not allowed')
    expect(() =>
      createExperimentSourceBundle({
        'experiment.tsx': 'x',
        'simulate.py': 'x',
        'tasks/main.tsx': '한'.repeat(MAX_CAD_SOURCE_BYTES / 2),
      }),
    ).toThrow(`exceeds ${MAX_CAD_SOURCE_BYTES} bytes`)
    expect(() =>
      createExperimentSourceBundle({
        'experiment.tsx': 'x',
        'simulate.py': 'x',
        'tasks/main.tsx': '\ud800',
      }),
    ).toThrow('valid UTF-8')
  })
})
