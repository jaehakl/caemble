import { describe, expect, it } from 'vitest'
import {
  addExperimentTask,
  assertExperimentSourceBundle,
  createCadSourceDocument,
  createExperimentSourceBundle,
  experimentTaskPaths,
  removeExperimentTask,
  updateExperimentSourceFile,
} from './document'

const files = {
  'experiment.tsx': 'import { Assembly } from "./geometry"\nvoid Assembly',
  'simulate.py': 'async def simulate(*, sim, tasks, vars):\n  pass',
  'tasks/main.tsx': 'import { Assembly } from "../geometry"\nvoid Assembly',
}

describe('Experiment source bundle v5', () => {
  it('always adds geometry.tsx, material.tsx, and an empty snapshot v2', () => {
    const bundle = createExperimentSourceBundle(files)
    expect(bundle.formatVersion).toBe(5)
    expect(bundle.files['geometry.tsx']).toBe('export {}\n')
    expect(bundle.files['material.tsx']).toBe('export {}\n')
    expect(bundle.geometrySnapshot).toEqual({ schemaVersion: 2, entryImports: [], modules: [] })
    expect(Object.keys(bundle.files)).toEqual([
      'experiment.tsx',
      'geometry.tsx',
      'material.tsx',
      'simulate.py',
      'tasks/main.tsx',
    ])
  })

  it('rejects legacy bundles and missing required files', () => {
    expect(() =>
      assertExperimentSourceBundle({
        formatVersion: 4,
        files,
        geometrySnapshot: { schemaVersion: 2, entryImports: [], modules: [] },
      }),
    ).toThrow('version 5')
    expect(() =>
      assertExperimentSourceBundle({
        formatVersion: 5,
        files: { 'experiment.tsx': 'x' },
        geometrySnapshot: { schemaVersion: 2, entryImports: [], modules: [] },
      }),
    ).toThrow('requires')
  })

  it('preserves geometry snapshot while editing and managing tasks', () => {
    const document = createCadSourceDocument('experiment', createExperimentSourceBundle(files))
    const edited = updateExperimentSourceFile(document, 'geometry.tsx', 'export {}\n// changed')
    expect(edited.sourceBundle.geometrySnapshot).toEqual(document.sourceBundle.geometrySnapshot)
    const added = addExperimentTask(edited, 'electric', 'export default 1')
    expect(experimentTaskPaths(added.sourceBundle)).toEqual(['tasks/electric.tsx', 'tasks/main.tsx'])
    expect(removeExperimentTask(added, 'electric').sourceBundle.files['tasks/electric.tsx']).toBeUndefined()
    expect(() => removeExperimentTask(document, 'main')).toThrow('at least one Task')
  })
})
