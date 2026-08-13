import { describe, expect, it } from 'vitest'
import {
  analyzeCadSource,
  analyzeGeometrySource,
  analyzeTaskSource,
  parseCadSource,
  rewriteGeometryRootAlias,
  rewriteGeometryImportCoordinates,
  staticCadSourceImports,
  validateGeometryUsage,
} from './sourceAnalysis'

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

  it('rejects the retired Geometry registry import in Experiment and Task sources', () => {
    const experiment = `import { experiment } from '@caemble/core'
import geometries from '@caemble/geometries'
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => geometries.block, recordedData: {} })`
    const task = `import { defineTask } from '@caemble/core'
import geometries from '@caemble/geometries'
export default defineTask({ kernel: { name: 'solver', version: '1' }, geometry: () => geometries.block, config: () => ({}) })`
    expect(() => analyzeCadSource(experiment)).toThrow('has been removed')
    expect(() => analyzeTaskSource(task)).toThrow('has been removed')
  })

  it('rewrites free Geometry root identifiers without changing locally bound names', () => {
    const source = `const First = () => <OldRoot id="first" />
const Second = OldRoot
function local(OldRoot: () => unknown) { return <OldRoot /> }`
    expect(rewriteGeometryRootAlias(source, 'OldRoot', 'NewRoot')).toEqual({
      references: 2,
      source: `const First = () => <NewRoot id="first" />
const Second = NewRoot
function local(OldRoot: () => unknown) { return <OldRoot /> }`,
    })
    expect(() =>
      rewriteGeometryRootAlias(
        'function local() { const NewRoot = () => null; return <OldRoot id="root" /> }',
        'OldRoot',
        'NewRoot',
      ),
    ).toThrow('충돌하는 지역 binding')
  })

  it('extracts exact default Geometry imports and rejects floating or named imports', () => {
    const coordinate = 'caemble:geometry/jlee/demo/block@1.2.3'
    const source = `import { type Geometry } from '@caemble/core'
import Child from '${coordinate}'
const Value: Geometry = () => <union><Child id="nested" /></union>
export default Value`
    expect(analyzeGeometrySource(source).imports).toEqual([{ coordinate, localName: 'Child' }])
    expect(analyzeGeometrySource(source).componentName).toBe('Value')
    expect(() =>
      analyzeGeometrySource("import child from 'caemble:geometry/jlee/demo/block@latest'\nexport default child"),
    ).toThrow('exact caemble:geometry coordinate')
    expect(() => analyzeGeometrySource(`import { child } from '${coordinate}'\nexport default child`)).toThrow(
      'exactly one default import',
    )
    expect(() => analyzeGeometrySource(`export { default } from '${coordinate}'`)).toThrow('Re-export')
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
    expect(() => parseCadSource('clearTimeout(1)')).toThrow('clearTimeout')
    expect(() => parseCadSource('clearInterval(1)')).toThrow('clearInterval')
    expect(() => parseCadSource('new Worker("worker.js")')).toThrow('Worker')
    expect(() => parseCadSource('new SharedWorker("worker.js")')).toThrow('SharedWorker')
    expect(() => parseCadSource('new XMLHttpRequest()')).toThrow('XMLHttpRequest')
    expect(() => parseCadSource('new WebSocket("ws://example.com")')).toThrow('WebSocket')
    expect(() => parseCadSource('const value = global.process')).toThrow('Global runtime access')
    expect(() => parseCadSource('const value = Math.sin(Math.PI / 2)')).not.toThrow()
  })

  it('rewrites only exact static Geometry imports and preserves quote style', () => {
    const previous = 'caemble:geometry/alice/common/plate@1.0.0' as const
    const next = 'caemble:geometry/alice/common/plate@1.0.1' as const
    const source = `import Plate from '${previous}'\nconst note = ${JSON.stringify(previous)}\nconst Assembly = () => <Plate id="plate" />\nexport default Assembly`

    expect(rewriteGeometryImportCoordinates(source, { [previous]: next })).toBe(
      `import Plate from '${next}'\nconst note = ${JSON.stringify(previous)}\nconst Assembly = () => <Plate id="plate" />\nexport default Assembly`,
    )
  })

  it('requires function Geometry exports and validates one explicit-id JSX usage', () => {
    expect(() => analyzeGeometrySource('export default <box />')).toThrow('function component')
    expect(analyzeGeometrySource('export default () => <box />').renderExpression.type).toBe('JSXElement')
    expect(analyzeGeometrySource('function Block() { return <box /> }\nexport default Block').componentName).toBe(
      'Block',
    )
    expect(
      analyzeGeometrySource(
        'const Block = ({ size = [1, 1, 1], position: localPosition = [0, 0, 0], id = "ignored" }) => <box size={size} pos={localPosition} />\nexport default Block',
      ).defaultedProps,
    ).toEqual(['position', 'size'])
    expect(validateGeometryUsage('<Block id="block" size={[1, 1, 1]} />', 'Block')).toContain('id="block"')
    expect(() => validateGeometryUsage('<Block />', 'Block')).toThrow('explicit id')
    expect(() => validateGeometryUsage('<Other id="block" />', 'Block')).toThrow('<Block')
    expect(() =>
      analyzeGeometrySource(
        'const Block = () => { if (true) return <box />; return <sphere /> }\nexport default Block',
      ),
    ).toThrow('one top-level return')
    expect(() =>
      analyzeGeometrySource('const Block = () => { if (true) return <box /> }\nexport default Block'),
    ).toThrow('one top-level return')
  })
})
