import { describe, expect, it } from 'vitest'
import {
  analyzeCadSource,
  analyzeGeometrySource,
  analyzeTaskSource,
  parseCadSource,
  staticCadSourceImports,
} from './sourceAnalysis'

describe('CAD source policy', () => {
  it('accepts only the explicit relative geometry module in Experiment and Task', () => {
    const experiment = `import { experiment } from '@caemble/core'\nimport { Assembly } from './geometry'\nexport default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => <Assembly id="assembly" />, recordedData: {} })`
    const task = `import { defineTask } from '@caemble/core'\nimport { Assembly } from '../geometry'\nexport default defineTask({ kernel: { name: 'solver', version: '1.0.0' }, geometry: () => <Assembly id="assembly" />, config: () => ({}) })`
    expect(analyzeCadSource(experiment).factoryName).toBe('experiment')
    expect(analyzeTaskSource(task).factoryName).toBe('defineTask')
    expect(staticCadSourceImports(experiment)).toEqual(['@caemble/core', './geometry'])
    expect(() => analyzeCadSource(experiment.replace('./geometry', '../geometry'))).toThrow()
    expect(() => analyzeTaskSource(task.replace('../geometry', './geometry'))).toThrow()
  })

  it('derives multiple named function exports and aliased exact/local imports', () => {
    const coordinate = 'caemble:geometry/jlee/common/part@1.2.3'
    const source = `import { type Geometry } from '@caemble/core'
import { Part as Child, Preview } from "${coordinate}"
export const Assembly: Geometry<{ size: number; required: number }> = ({ size = 1, required }) => <Child id="child" scale={[size, required, 1]} />
export function Alternate() { return <Preview id="preview" /> }`
    const analysis = analyzeGeometrySource(source)
    expect(analysis.exports.map((item) => item.name)).toEqual(['Assembly', 'Alternate'])
    expect(analysis.exports.find((item) => item.name === 'Assembly')?.defaultedProps).toEqual(['size'])
    expect(analysis.imports.map((item) => [item.exportName, item.alias, item.coordinate])).toEqual([
      ['Part', 'Child', coordinate],
      ['Preview', 'Preview', coordinate],
    ])
    expect(() => analyzeGeometrySource(source.replace('@1.2.3', '@local'))).toThrow('exact')
    expect(
      analyzeGeometrySource(source.replace('@1.2.3', '@local'), { allowLocal: true }).imports[0]?.coordinate,
    ).toContain('@local')
  })

  it('allows empty experiment geometry.tsx but rejects static, default and helper exports in modules', () => {
    expect(analyzeGeometrySource('export {}', { allowEmpty: true }).exports).toEqual([])
    expect(() => analyzeGeometrySource('export {}')).toThrow('at least one')
    expect(() => analyzeGeometrySource('export default () => <box />')).toThrow('named Geometry component exports')
    expect(() => analyzeGeometrySource('export const Shape = <box />')).toThrow('function')
    expect(() => analyzeGeometrySource('export const Helper = 1')).toThrow('function')
  })

  it('rejects retired registry, default Geometry imports and nondeterminism', () => {
    expect(() =>
      analyzeGeometrySource("import value from 'caemble:geometry/jlee/common/x@1.0.0'\nexport { value }"),
    ).toThrow('named')
    expect(() => analyzeGeometrySource("import value from '@caemble/geometries'\nexport { value }")).toThrow()
    expect(() => parseCadSource('const value = Math.random()')).toThrow('Math.random')
    expect(() => parseCadSource('const value = Date.now()')).toThrow('Date')
  })
})
