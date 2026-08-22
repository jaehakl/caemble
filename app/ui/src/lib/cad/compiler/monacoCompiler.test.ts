// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCadSourceDocument, createExperimentSourceBundle } from '../source/document'
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

const helperSource = `import { type Geometry } from '@caemble/core'
export const Part: Geometry = () => <box size={[1, 1, 1]} />
`

function document(variant: string) {
  return createCadSourceDocument(
    'experiment',
    createExperimentSourceBundle({
      'experiment.tsx': `import { experiment } from '@caemble/core'
import { Part } from './geometry'
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => <Part id="part" />, recordedData: {} })
// ${variant}
`,
      'geometry.tsx': `export { Part } from './shared/part'`,
      'shared/part.tsx': helperSource,
      'shared/value.ts': 'export const value = 1',
      'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
    }),
  )
}

beforeEach(() => {
  monacoMocks.models.clear()
  monacoMocks.createdUris.length = 0
  vi.clearAllMocks()
})

describe('Monaco bundle compiler model ownership', () => {
  it('keeps an open authoring model isolated and compiles every TS/TSX bundle file', async () => {
    const authoringUri = 'file:///authoring/shared/part.tsx'
    const authoringModel = monacoMocks.createModel(helperSource, 'typescript', monacoMocks.parse(authoringUri))

    const compiled = await compileCadDocument(document('authoring-open'))

    expect(monacoMocks.models.get(authoringUri)).toBe(authoringModel)
    expect(authoringModel.dispose).not.toHaveBeenCalled()
    expect(Object.keys(compiled.sources)).toEqual([
      'experiment.tsx',
      'geometry.tsx',
      'material.tsx',
      'shared/part.tsx',
      'shared/value.ts',
    ])
    expect(monacoMocks.createdUris).toContainEqual(
      expect.stringMatching(/^file:\/\/\/caemble-source\/[0-9a-f]{64}\/shared\/part\.tsx$/u),
    )
  })

  it('uses distinct model URIs for overlapping bundle paths from different source hashes', async () => {
    await expect(
      Promise.all([compileCadDocument(document('first')), compileCadDocument(document('second'))]),
    ).resolves.toHaveLength(2)

    const helperUris = monacoMocks.createdUris.filter(
      (uri) => uri.startsWith('file:///caemble-source/') && uri.endsWith('/shared/part.tsx'),
    )
    expect(helperUris).toHaveLength(2)
    expect(new Set(helperUris).size).toBe(2)
  })
})
