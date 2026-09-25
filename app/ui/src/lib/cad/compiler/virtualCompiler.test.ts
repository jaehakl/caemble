// @vitest-environment node
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readCatalogExamples } from '../../../../scripts/catalog-example-support'
import { compileNodeCadDocument } from '@/platform/node/cadCompiler'
import { extractCatalogSourceReferences } from '@/lib/catalog/references'
import { experimentTypeScriptPaths } from '../source/moduleResolution'
import { catalogRuntimeTypes } from './catalogTypeEnvironment'
import { compileVirtualCadDocument } from './virtualCompiler'
import type { CadCompilationInput } from './compilerProtocol'
import type { CadCompilationError } from './compilationError'
import { inspectCompiledDocument } from '../execution/userModule'

const mocks = vi.hoisted(() => ({ compile: vi.fn() }))
vi.mock('./compilerClient', () => ({ compileInWorker: mocks.compile }))

// Read real contracts from the canonical SQLite catalog, never duplicate material data.
const { examples, catalog } = readCatalogExamples(path.resolve('../catalog/caemble_catalog/catalog.sqlite3'))
const templates = [
  examples.find(
    (entry) =>
      entry.repository === 'fluid' &&
      entry.sourceBundle.files['material.tsx'].includes('fluidDynamics.newtonian-fluid@1'),
  )!,
  examples.find(
    (entry) =>
      entry.repository === 'fea' && entry.sourceBundle.files['material.tsx'].includes('mechanics.isotropic-elastic@1'),
  )!,
  examples.find((entry) => entry.sourceBundle.files['material.tsx'].includes('optics.constant-complex-index@1'))!,
]
const inputs = templates.map((entry) => {
  const references = extractCatalogSourceReferences(entry.sourceBundle)
  const slice = {
    ...catalog,
    materialModels: catalog.materialModels.filter((model) => references.materialModels.includes(model.key)),
  }
  return {
    sourceHash: entry.bundleHash,
    sources: Object.fromEntries(
      experimentTypeScriptPaths(entry.sourceBundle.files).map((name) => [name, entry.sourceBundle.files[name]]),
    ),
    catalogTypes: catalogRuntimeTypes(slice),
  }
})

describe('real Monaco TypeScript engine with isolated virtual files', () => {
  it('enforces the varsSchema rank limit in browser and Node authoring', async () => {
    for (const shape of [undefined, [], [3], [13, 4], [1, 1, 1], [2, 3, 4, 5]]) {
      const sources = {
        'material.tsx': 'export {}',
        'experiment.tsx': `import { Box, experiment } from '@caemble/core'
export default experiment({
  lengthUnit: 'mm', varsSchema: { input: ${JSON.stringify({ shape, min: 0, max: 1 })} },
  geometry: () => <Box id="probe" size={[1, 1, 1]} />, recordedData: {},
})`,
      }
      const input = { sourceHash: `rank-${JSON.stringify(shape)}`, sources, catalogTypes: 'export {}' }
      const compileNode = () =>
        compileNodeCadDocument(sources, input.sourceHash, catalog, path.resolve('src/lib/cad/api'))
      if ((shape?.length ?? 0) > 2) {
        await expect(compileVirtualCadDocument(input)).rejects.toMatchObject({ errorType: 'type' })
        expect(compileNode).toThrow()
      } else {
        const browser = await compileVirtualCadDocument(input)
        const node = compileNode()
        for (const compiled of [browser, node]) {
          expect(inspectCompiledDocument(compiled).varsSchema.input.shape).toEqual(shape ?? [])
        }
      }
    }
  }, 30_000)

  it('compiles fluid, elastic, optical and fluid templates without leaking declarations', async () => {
    for (const input of [...inputs, inputs[0]]) {
      const result = await compileVirtualCadDocument(input)
      expect(Object.keys(result.sources)).toEqual(Object.keys(input.sources))
      expect(result.sources['material.tsx'].sourceMap).toBeDefined()
      expect(result.sources['material.tsx'].code).toContain(`sourceURL=caemble://${input.sourceHash}/material.tsx`)
      expect(result.sources['material.tsx'].code).not.toContain('sourceMappingURL=')
    }
  }, 30_000)

  it('rejects elastic material under a fluid catalog, then compiles the same source with its own catalog', async () => {
    await expect(
      compileVirtualCadDocument({ ...inputs[1], catalogTypes: inputs[0].catalogTypes }),
    ).rejects.toMatchObject({
      errorType: 'type',
      diagnostics: expect.arrayContaining([expect.objectContaining({ file: 'material.tsx', code: 2322 })]),
    })
    await expect(compileVirtualCadDocument(inputs[1])).resolves.toHaveProperty('sourceHash', inputs[1].sourceHash)
  }, 30_000)

  it('isolates simultaneous requests even when source paths and hashes are identical', async () => {
    const results = await Promise.all(
      inputs.map((input) => compileVirtualCadDocument({ ...input, sourceHash: 'same' })),
    )
    expect(results).toHaveLength(3)
    expect(new Set(results.map((result) => result.sources['material.tsx'].code)).size).toBe(3)
  }, 30_000)

  it('preserves UTF-16 positions and matches Node diagnostics on CRLF Korean source', async () => {
    const sources = {
      'geometry.tsx':
        'import { Box, type Geometry } from \'@caemble/core\'\r\n// 한글 😀\r\nexport const Part: Geometry = () => /* 한글 😀 */ <Box size="invalid" />\r\n',
    }
    let browserError: CadCompilationError | undefined
    try {
      await compileVirtualCadDocument({ sourceHash: 'positions', sources, catalogTypes: 'export {}' })
    } catch (cause) {
      browserError = cause as CadCompilationError
    }
    expect(browserError?.errorType).toBe('type')
    let nodeDiagnostics: { file: string; code: string; range: unknown }[] = []
    try {
      compileNodeCadDocument(sources, 'positions', catalog, path.resolve('src/lib/cad/api'))
    } catch (cause) {
      nodeDiagnostics = (cause as { diagnostics: typeof nodeDiagnostics }).diagnostics
    }
    expect(browserError!.diagnostics.map(({ file, code, range }) => ({ file, code: `TS${code}`, range }))).toEqual(
      nodeDiagnostics.map(({ file, code, range }) => ({ file, code, range })),
    )
    expect(browserError!.diagnostics[0].range.startLineNumber).toBe(3)
  })

  it('retains policy and module-graph rejection before type checking', async () => {
    await expect(
      compileVirtualCadDocument({
        sourceHash: 'policy',
        sources: { 'geometry.tsx': 'export default 1' },
        catalogTypes: 'export {}',
      }),
    ).rejects.toMatchObject({ errorType: 'policy', diagnostics: [expect.objectContaining({ code: 'CAD_POLICY' })] })
    await expect(
      compileVirtualCadDocument({
        sourceHash: 'graph',
        sources: { 'extra.ts': "import { Part } from './missing'; export const Value = Part" },
        catalogTypes: 'export {}',
      }),
    ).rejects.toMatchObject({
      errorType: 'policy',
      diagnostics: [expect.objectContaining({ code: 'CAD_MODULE_GRAPH' })],
    })
    await expect(compileVirtualCadDocument(inputs[0])).resolves.toHaveProperty('sourceHash')
  }, 30_000)
})

describe('browser compile identity', () => {
  it('includes actual catalog declarations even when catalog revision and source are identical', async () => {
    const { compileCadDocument } = await import('./monacoCompiler')
    mocks.compile.mockImplementation(async (_key: string, input: CadCompilationInput) => ({
      sourceHash: input.sourceHash,
      sources: {},
    }))
    const document = { kind: 'experiment' as const, sourceBundle: templates[1].sourceBundle }
    await compileCadDocument(document, { catalog })
    const originalKey = mocks.compile.mock.lastCall![0]
    await compileCadDocument(document, { catalog: { ...catalog, materialModels: [] } })
    expect(mocks.compile.mock.lastCall![0]).not.toBe(originalKey)
    await compileCadDocument(document, { catalog })
    expect(mocks.compile.mock.lastCall![0]).toBe(originalKey)
    await compileCadDocument(document, { catalog: { ...catalog, catalogRevision: 'another-revision' } })
    expect(mocks.compile.mock.lastCall![0]).not.toBe(originalKey)
  })

  it('rejects an already cancelled compile without creating a Worker request', async () => {
    const { compileCadDocument } = await import('./monacoCompiler')
    const abort = new AbortController()
    abort.abort()
    await expect(
      compileCadDocument({ kind: 'experiment', sourceBundle: templates[0].sourceBundle }, { signal: abort.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.compile).not.toHaveBeenCalled()
  })
})
