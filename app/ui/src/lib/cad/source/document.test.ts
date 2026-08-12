import { describe, expect, it } from 'vitest'
import {
  CAD_SOURCE_API_VERSION,
  CAD_SOURCE_FORMAT_VERSION,
  EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION,
  MAX_CAD_SOURCE_BYTES,
  addExperimentTask,
  assertCadSourceDocument,
  assertExperimentSourceBundle,
  cadSourceHash,
  createCadSourceDocument,
  createExperimentSourceBundle,
  removeExperimentTask,
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

describe('ExperimentSourceDocument v2', () => {
  it('hashes the complete sorted source bundle without generation state', async () => {
    const document = createCadSourceDocument('experiment', bundle())
    const hash = await cadSourceHash(document)

    expect(hash).toMatch(/^[0-9a-f]{64}$/u)
    await expect(cadSourceHash(updateExperimentSourceFile(document, 'simulate.py', 'changed'))).resolves.not.toBe(hash)
    expect(() => assertCadSourceDocument({ ...document, generationMetadata: { method: 'random' } })).toThrow(
      'generationMetadata',
    )
  })

  it('adds and removes independent Task files but keeps the last Task', () => {
    const document = createCadSourceDocument('experiment', bundle())
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

  it('updates only the Experiment entry while preserving the bundle contract', () => {
    const document = createCadSourceDocument('experiment', bundle())
    const edited = updateCadSource(document, 'updated experiment')
    expect(edited.sourceBundle.files['experiment.tsx']).toBe('updated experiment')
    expect(edited).not.toHaveProperty('generationMetadata')
  })

  it('validates paths, required files, UTF-8 sizes, and v5/v2 versions', () => {
    expect(CAD_SOURCE_API_VERSION).toBe(5)
    expect(CAD_SOURCE_FORMAT_VERSION).toBe(2)
    expect(EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION).toBe(2)
    expect(() => assertExperimentSourceBundle({ formatVersion: 2, files: { 'experiment.tsx': 'x' } })).toThrow(
      'requires experiment.tsx and simulate.py',
    )
    expect(() =>
      assertExperimentSourceBundle({
        formatVersion: 2,
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
