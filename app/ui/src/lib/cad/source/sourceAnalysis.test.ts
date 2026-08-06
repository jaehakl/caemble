import { describe, expect, it } from 'vitest'
import { analyzeCadSource, parseCadSource, staticCadSourceImports } from './sourceAnalysis'

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

  it('allows an unversioned kernel import only for Experiment Sources', () => {
    const program = `import { experiment } from '@caemble/core'
import { dcCurrentDensity } from '@caemble/kernels'
export default experiment({
  varsSchema: {},
  tasks: () => ({ electric: dcCurrentDensity({}) }),
  recordedData: {},
  simulate: ({ sim }) => sim.initialState,
})`

    expect(analyzeCadSource(program, 'experiment').factoryName).toBe('experiment')
    expect(() => analyzeCadSource(program, 'structure')).toThrow('Structure Source cannot import @caemble/kernels')
  })

  it('rejects relative, versioned, external, URL, dynamic, and source-level require imports', () => {
    expect(() => parseCadSource("import value from './value'")).toThrow('single-file')
    expect(() => parseCadSource("import value from '@caemble/core/v2'")).toThrow('single-file')
    expect(() => parseCadSource("import value from '@caemble/core/v3'")).toThrow('single-file')
    expect(() => parseCadSource("import value from '@caemble/kernels/v1'")).toThrow('single-file')
    expect(() => parseCadSource("import value from 'other-package'")).toThrow('single-file')
    expect(() => parseCadSource("import value from 'https://example.com/value.ts'")).toThrow('single-file')
    expect(() => parseCadSource("const value = import('@caemble/core')")).toThrow('Dynamic import is not supported')
    expect(() => parseCadSource("const value = require('@caemble/core')")).toThrow(
      'Source-level require() is not supported',
    )
  })
})
