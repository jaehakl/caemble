import { describe, expect, it } from 'vitest'
import { analyzeCadSource, analyzeTaskSource, parseCadSource, staticCadSourceImports } from './sourceAnalysis'

describe('CAD source policy', () => {
  it('resolves one lowercase factory through direct top-level const bindings', () => {
    const source = `import { structure as define } from '@caemble/core'
const options = { lengthUnit: 'mm', varsSchema: {}, geometry: () => <box size={[1, 1, 1]} /> }
const active = define(options)
export default active
`
    const analysis = analyzeCadSource(source, 'structure')

    expect(analysis.factoryName).toBe('structure')
    expect(analysis.options.type).toBe('ObjectExpression')
    expect(staticCadSourceImports(source)).toEqual(['@caemble/core'])
  })

  it('requires exactly one matching default factory export', () => {
    expect(() =>
      analyzeCadSource(
        `import { structure } from '@caemble/core'
export default structure({})
export default structure({})`,
        'structure',
      ),
    ).toThrow('Exactly one default export')
    expect(() =>
      analyzeCadSource(
        `import { structure } from '@caemble/core'
export default class Model {}`,
        'structure',
      ),
    ).toThrow('must resolve to structure({...})')
    expect(() =>
      analyzeCadSource(
        `import { structure } from '@caemble/core'
export default structure({})`,
        'experiment',
      ),
    ).toThrow('experiment must be a named import')
  })

  it('recognizes an independent Task definition from the core module', () => {
    const task = `import { defineTask } from '@caemble/core'
export default defineTask({
  kernel: { name: 'solver', version: '1.0.0' },
  lengthUnit: 'mm',
  geometry: () => null,
  config: () => ({}),
})`

    expect(analyzeTaskSource(task).factoryName).toBe('defineTask')
  })

  it('rejects relative, versioned, external, URL, dynamic, and source-level require imports', () => {
    expect(() => parseCadSource("import value from './value'")).toThrow('independent')
    expect(() => parseCadSource("import value from '@caemble/core/v2'")).toThrow('independent')
    expect(() => parseCadSource("import value from '@caemble/core/v3'")).toThrow('independent')
    expect(() => parseCadSource("import value from '@caemble/kernels'")).toThrow('independent')
    expect(() => parseCadSource("import value from 'other-package'")).toThrow('independent')
    expect(() => parseCadSource("import value from 'https://example.com/value.ts'")).toThrow('independent')
    expect(() => parseCadSource("const value = import('@caemble/core')")).toThrow('Dynamic import is not supported')
    expect(() => parseCadSource("const value = require('@caemble/core')")).toThrow(
      'Source-level require() is not supported',
    )
  })
})
