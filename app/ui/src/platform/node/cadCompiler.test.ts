// @vitest-environment node
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CatalogRuntimeSlice } from '../../contracts/catalog'
import { compileNodeCadDocument } from './cadCompiler'

const emptyCatalog: CatalogRuntimeSlice = {
  catalogRevision: 'syntax-fixture',
  solvers: [],
  quantityKinds: [],

  materialModels: [],

  warnings: [],
}

describe('Node CAD compiler diagnostics', () => {
  it('reports a known policy file but no fabricated source range', () => {
    try {
      compileNodeCadDocument({ 'geometry.tsx': 'export default 1' }, 'source-hash', emptyCatalog)
      throw new Error('Expected policy rejection.')
    } catch (cause) {
      expect(cause).toMatchObject({
        code: 'source-policy',
        stage: 'source-policy',
        language: 'typescript',
        sourceHash: 'source-hash',
        referenceId: 'diagnostic.experiment',
        diagnostics: [expect.objectContaining({ file: 'geometry.tsx', location: null })],
      })
      expect((cause as { diagnostics: object[] }).diagnostics[0]).not.toHaveProperty('range')
    }
  })

  it('reports the actual TypeScript code, source line and range', () => {
    const source = `import { Box, type Geometry } from '@caemble/core'
export const Part: Geometry = () => <Box size="invalid" />
`
    try {
      compileNodeCadDocument({ 'geometry.tsx': source }, 'typed-hash', emptyCatalog, path.resolve('src/lib/cad/api'))
      throw new Error('Expected type rejection.')
    } catch (cause) {
      expect(cause).toMatchObject({
        code: 'compile',
        language: 'typescript',
        sourceHash: 'typed-hash',
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: expect.stringMatching(/^TS\d+$/),
            file: 'geometry.tsx',
            range: expect.objectContaining({ startLineNumber: 2 }),
            location: expect.objectContaining({ file: 'geometry.tsx', line: 2 }),
            sourceLine: expect.stringContaining('size="invalid"'),
          }),
        ]),
      })
    }
  })
})
