import { describe, expect, it } from 'vitest'
import {
  addExperimentSourceFile,
  addExperimentTask,
  assertCadSourceDocument,
  assertExperimentSourceBundle,
  cadSourceHash,
  createCadSourceDocument,
  createExperimentSourceBundle,
  experimentTaskPaths,
  removeExperimentSourceFile,
  removeExperimentTask,
  updateExperimentSourceFile,
} from './document'

const files = {
  'experiment.tsx': 'export default 1',
  'simulate.py': 'async def simulate(*, sim, tasks, vars):\n  pass',
}

describe('Experiment source bundle v6', () => {
  it('adds the required TypeScript core files and permits zero Tasks', () => {
    const bundle = createExperimentSourceBundle(files)
    expect(bundle).toEqual({
      formatVersion: 6,
      files: {
        'experiment.tsx': files['experiment.tsx'],
        'geometry.tsx': 'export {}\n',
        'material.tsx': 'export {}\n',
        'simulate.py': files['simulate.py'],
      },
    })
    expect(experimentTaskPaths(bundle)).toEqual([])
  })

  it('rejects legacy graph fields, missing core files, unsafe paths, and case collisions', () => {
    expect(() =>
      assertExperimentSourceBundle({
        formatVersion: 5,
        files,
        geometrySnapshot: { schemaVersion: 2, entryImports: [], modules: [] },
      }),
    ).toThrow('geometrySnapshot')
    expect(() => assertExperimentSourceBundle({ formatVersion: 6, files: { 'experiment.tsx': 'x' } })).toThrow(
      'requires',
    )
    expect(() => createExperimentSourceBundle({ ...files, '../escape.ts': 'export {}' })).toThrow('path is invalid')
    expect(() =>
      createExperimentSourceBundle({ ...files, 'shared/Part.ts': 'export {}', 'shared/part.ts': 'export {}' }),
    ).toThrow('differ only by case')
  })

  it('edits Tasks and arbitrary TS/TSX files while protecting the four core files', () => {
    const document = createCadSourceDocument('experiment', createExperimentSourceBundle(files))
    expect(document.apiVersion).toBe(8)
    expect(() => assertCadSourceDocument(document)).not.toThrow()
    const edited = updateExperimentSourceFile(document, 'geometry.tsx', 'export {}\n// changed')
    const withHelper = addExperimentSourceFile(edited, 'shared/shape.tsx', 'export const Shape = () => null')
    const withTask = addExperimentTask(withHelper, 'electric', 'export default 1')
    expect(experimentTaskPaths(withTask.sourceBundle)).toEqual(['tasks/electric.tsx'])
    expect(removeExperimentTask(withTask, 'electric').sourceBundle.files['tasks/electric.tsx']).toBeUndefined()
    expect(
      removeExperimentSourceFile(withTask, 'shared/shape.tsx').sourceBundle.files['shared/shape.tsx'],
    ).toBeUndefined()
    expect(() => removeExperimentSourceFile(withTask, 'simulate.py')).toThrow('cannot be removed')
  })

  it('uses the canonical v6 bundle hash regardless of file insertion order', async () => {
    const first = createCadSourceDocument(
      'experiment',
      createExperimentSourceBundle({ ...files, 'shared/value.ts': 'export const value = 1' }),
    )
    const second = createCadSourceDocument(
      'experiment',
      createExperimentSourceBundle({
        'shared/value.ts': 'export const value = 1',
        'simulate.py': files['simulate.py'],
        'experiment.tsx': files['experiment.tsx'],
      }),
    )
    await expect(cadSourceHash(first)).resolves.toBe(await cadSourceHash(second))
  })
})
