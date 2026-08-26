import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { compiledCadSemanticHash } from './semanticHash'
import type { CompiledCadSource } from './types'
import { CAD_COMPILER_VERSION } from './types'

function compiledSource(code: string): CompiledCadSource {
  return {
    apiVersion: 11,
    compilerVersion: CAD_COMPILER_VERSION,
    entryFile: 'structure.tsx',
    code: `${code}\n//# sourceURL=caemble://${'a'.repeat(64)}/structure.tsx`,
    sourceHash: 'a'.repeat(64),
  }
}

describe('compiledCadSemanticHash', () => {
  it('ignores emitted formatting, comments, raw quotes, parentheses, and semicolons', async () => {
    const first = await compiledCadSemanticHash(compiledSource(`const value = 'same';\nmodule.exports = (value);`))
    const second = await compiledCadSemanticHash(compiledSource(`// comment\nconst value="same"\nmodule.exports=value`))
    expect(second).toBe(first)
  })

  it('preserves identifiers, values, operators, and statement order', async () => {
    const base = await compiledCadSemanticHash(compiledSource('const value = 1; module.exports = value + 2;'))
    await expect(
      compiledCadSemanticHash(compiledSource('const renamed = 1; module.exports = renamed + 2;')),
    ).resolves.not.toBe(base)
    await expect(
      compiledCadSemanticHash(compiledSource('const value = 1; module.exports = value - 2;')),
    ).resolves.not.toBe(base)
    await expect(
      compiledCadSemanticHash(compiledSource('module.exports = value + 2; const value = 1;')),
    ).resolves.not.toBe(base)
  })

  it('ignores TypeScript-only declarations removed by emit', async () => {
    const emit = (source: string) =>
      ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      }).outputText
    const typed = emit(`type Value = number
      const value: Value = 1
      export default value`)
    const plain = emit(`const value = 1
      export default value`)
    await expect(compiledCadSemanticHash(compiledSource(typed))).resolves.toBe(
      await compiledCadSemanticHash(compiledSource(plain)),
    )
  })
})
