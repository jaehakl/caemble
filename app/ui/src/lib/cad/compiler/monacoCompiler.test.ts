// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCadSourceDocument, createExperimentSourceBundle } from '../source/document'
import {
  createGeometrySnapshot,
  geometryModuleHash,
  geometrySourceHash,
  type GeometryCoordinate,
} from '../source/geometrySnapshot'
import { compileCadDocument } from './monacoCompiler'

const monacoMocks = vi.hoisted(() => {
  const models = new Map<string, object>()
  const createdUris: string[] = []
  const parse = vi.fn((value: string) => ({ toString: () => value }))
  const createModel = vi.fn((source: string, language: string, uri: { toString: () => string }) => {
    const key = uri.toString()
    if (models.has(key)) throw new Error('Cannot add model because it already exists!')
    const model = {
      dispose: vi.fn(() => {
        if (models.get(key) === model) models.delete(key)
      }),
      getPositionAt: vi.fn(() => ({ lineNumber: 1, column: 1 })),
      language,
      source,
      uri,
    }
    createdUris.push(key)
    models.set(key, model)
    return model
  })
  const worker = {
    getEmitOutput: vi.fn(async (uri: string) => ({
      emitSkipped: false,
      outputFiles: [{ name: `${uri}.js`, text: 'module.exports = {}' }],
    })),
    getSemanticDiagnostics: vi.fn(async () => []),
    getSyntacticDiagnostics: vi.fn(async () => []),
  }
  const monaco = {
    Uri: { parse },
    editor: { createModel },
    typescript: {
      getTypeScriptWorker: vi.fn(async () => async () => worker),
      typescriptDefaults: { addExtraLib: vi.fn(() => ({ dispose: vi.fn() })) },
    },
  }
  return { createModel, createdUris, models, monaco, parse }
})

vi.mock('./monacoRuntime', () => ({ loadMonaco: async () => monacoMocks.monaco }))

const coordinate = 'caemble:geometry/jlee/common/part@1.0.0' as GeometryCoordinate
const geometrySource = `import { type Geometry } from '@caemble/core'
export const Part: Geometry = () => <box size={[1, 1, 1]} />
`

async function document(variant: string) {
  const sourceHash = await geometrySourceHash(geometrySource)
  const base = {
    geometryVersionId: 1,
    coordinate,
    moduleFormatVersion: 3 as const,
    cadApiVersion: 5 as const,
    description: null,
    source: geometrySource,
    sourceHash,
    imports: [],
  }
  const module = { ...base, moduleHash: await geometryModuleHash(base) }
  const snapshot = createGeometrySnapshot(
    [{ exportName: 'Part', alias: 'Part', geometryVersionId: 1, coordinate, moduleHash: module.moduleHash }],
    [module],
  )
  return createCadSourceDocument(
    'experiment',
    createExperimentSourceBundle(
      {
        'experiment.tsx': `import { experiment } from '@caemble/core'
import { Part } from './geometry'
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => <Part id="part" />, recordedData: {} })
// ${variant}
`,
        'geometry.tsx': `import { Part } from ${JSON.stringify(coordinate)}
export { Part }
`,
        'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
        'tasks/main.tsx': `import { defineTask } from '@caemble/core'
export default defineTask({ kernel: { name: 'preview', version: '1.0.0' }, config: () => ({}) })
`,
      },
      snapshot,
    ),
  )
}

beforeEach(() => {
  monacoMocks.models.clear()
  monacoMocks.createdUris.length = 0
  vi.clearAllMocks()
})

describe('Monaco compiler model ownership', () => {
  it('keeps an open Geometry authoring model isolated from compilation', async () => {
    const authoringUri = `file:///geometries/${encodeURIComponent(coordinate)}.tsx`
    const authoringModel = monacoMocks.createModel(geometrySource, 'typescript', monacoMocks.parse(authoringUri))

    await expect(compileCadDocument(await document('authoring-open'))).resolves.toBeDefined()

    expect(monacoMocks.models.get(authoringUri)).toBe(authoringModel)
    expect(authoringModel.dispose).not.toHaveBeenCalled()
    expect(monacoMocks.createdUris).toContainEqual(
      expect.stringMatching(/^file:\/\/\/caemble-source\/[0-9a-f]{64}\/geometries\//u),
    )
  })

  it('uses distinct Geometry model URIs for overlapping source hashes', async () => {
    const [first, second] = await Promise.all([document('first'), document('second')])

    await expect(Promise.all([compileCadDocument(first), compileCadDocument(second)])).resolves.toHaveLength(2)

    const geometryUris = monacoMocks.createdUris.filter(
      (uri) => uri.startsWith('file:///caemble-source/') && uri.includes('/geometries/'),
    )
    expect(geometryUris).toHaveLength(2)
    expect(new Set(geometryUris).size).toBe(2)
  })
})
