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
  createExperimentSourceBundleV3,
  removeExperimentTask,
  updateCadSource,
  updateExperimentSourceFile,
  upgradeExperimentSourceBundleV3,
} from './document'
import {
  createGeometrySnapshot,
  geometryModuleHash,
  geometrySourceHash,
  type GeometryCoordinate,
  type GeometrySnapshotModule,
} from './geometrySnapshot'

const coordinate = 'caemble:geometry/jlee/demo/block@1.0.0' as GeometryCoordinate

async function geometryModule(): Promise<GeometrySnapshotModule> {
  const source = 'export default <box size={[1, 1, 1]} />\n'
  const sourceHash = await geometrySourceHash(source)
  const module = {
    geometryVersionId: 1,
    coordinate,
    moduleFormatVersion: 1 as const,
    cadApiVersion: 5 as const,
    description: null,
    source,
    sourceHash,
    imports: [],
  }
  return { ...module, moduleHash: await geometryModuleHash(module) }
}

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

    expect(hash).toBe('87780356d57442238c72e0107bf0591b0e4a4c2ed3eda68c453b3f2e0930b2ab')
    await expect(cadSourceHash(updateExperimentSourceFile(document, 'simulate.py', 'changed'))).resolves.not.toBe(hash)
    expect(() => assertCadSourceDocument({ ...document, generationMetadata: { method: 'random' } })).toThrow(
      'generationMetadata',
    )
  })

  it('adds canonical Geometry snapshot data only in v3 and preserves it across source edits', async () => {
    const module = await geometryModule()
    const snapshot = createGeometrySnapshot(
      [{ alias: 'block', geometryVersionId: 1, coordinate, moduleHash: module.moduleHash }],
      [module],
    )
    const v2 = bundle()
    const v3 = createExperimentSourceBundleV3(v2.files, snapshot)
    const document = createCadSourceDocument('experiment', v3)
    const edited = updateCadSource(document, 'changed experiment')

    expect(v3.formatVersion).toBe(3)
    expect(upgradeExperimentSourceBundleV3(v3).geometrySnapshot).toEqual(snapshot)
    expect(edited.sourceBundle).toMatchObject({ formatVersion: 3, geometrySnapshot: snapshot })
    await expect(cadSourceHash(document)).resolves.toMatch(/^[0-9a-f]{64}$/u)
    expect(await cadSourceHash(document)).not.toBe(await cadSourceHash(createCadSourceDocument('experiment', v2)))
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
