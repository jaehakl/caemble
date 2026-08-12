import { describe, expect, it } from 'vitest'
import { analyzeCadSource, analyzeTaskSource, parseCadSource, staticCadSourceImports } from './sourceAnalysis'

describe('CAD source policy', () => {
  it('resolves the Experiment factory through direct top-level const bindings', () => {
    const source = `import { experiment as define } from '@caemble/core'
const options = { lengthUnit: 'mm', varsSchema: {}, geometry: () => <box size={[1, 1, 1]} />, recordedData: {} }
const active = define(options)
export default active
`
    const analysis = analyzeCadSource(source)
    expect(analysis.factoryName).toBe('experiment')
    expect(analysis.options.type).toBe('ObjectExpression')
    expect(staticCadSourceImports(source)).toEqual(['@caemble/core'])
  })

  it('requires exactly one Experiment default factory export', () => {
    expect(() =>
      analyzeCadSource(`import { experiment } from '@caemble/core'
export default experiment({})
export default experiment({})`),
    ).toThrow('Exactly one default export')
    expect(() =>
      analyzeCadSource(`import { experiment } from '@caemble/core'
export default class Model {}`),
    ).toThrow('must resolve to experiment({...})')
    expect(() =>
      analyzeCadSource(`import { structure } from '@caemble/core'
export default structure({})`),
    ).toThrow('experiment must be a named import')
  })

  it('recognizes an independent Task definition', () => {
    const task = `import { defineTask } from '@caemble/core'
export default defineTask({ kernel: { name: 'solver', version: '1.0.0' }, config: () => ({}) })`
    expect(analyzeTaskSource(task).factoryName).toBe('defineTask')
  })

  it('rejects imports and hidden nondeterminism while allowing deterministic Math', () => {
    expect(() => parseCadSource("import value from './value'")).toThrow('independent')
    expect(() => parseCadSource("const value = import('@caemble/core')")).toThrow('Dynamic import')
    expect(() => parseCadSource("const value = require('@caemble/core')")).toThrow('Source-level require')
    expect(() => parseCadSource('const value = Math.random()')).toThrow('Math.random')
    expect(() => parseCadSource('const value = Date.now()')).toThrow('Date')
    expect(() => parseCadSource('const value = crypto.getRandomValues([])')).toThrow('crypto')
    expect(() => parseCadSource('const M = Math; const value = M.random()')).toThrow('Aliasing Math')
    expect(() => parseCadSource('const { random } = Math; const value = random()')).toThrow('Destructuring')
    expect(() => parseCadSource('const D = Date; const value = D.now()')).toThrow('Date')
    expect(() => parseCadSource('const c = crypto; const value = c.getRandomValues([])')).toThrow('crypto')
    expect(() => parseCadSource('const value = globalThis.location')).toThrow('Global runtime access')
    expect(() => parseCadSource('const value = Math.sin(Math.PI / 2)')).not.toThrow()
  })
})
