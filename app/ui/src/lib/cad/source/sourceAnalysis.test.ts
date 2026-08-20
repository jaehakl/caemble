import { describe, expect, it } from 'vitest'
import {
  analyzeCadSource,
  analyzeGeometrySource,
  analyzeMaterialSource,
  analyzeTaskSource,
  geometryExportAtOffset,
  parseCadSource,
  projectGeometryExportSource,
  staticCadSourceImports,
} from './sourceAnalysis'

describe('CAD source policy', () => {
  it('accepts only the explicit relative geometry and material modules in Experiment and Task', () => {
    const experiment = `import { experiment } from '@caemble/core'\nimport { Assembly } from './geometry'\nimport { Steel } from './material'\nvoid Steel\nexport default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => <Assembly id="assembly" />, recordedData: {} })`
    const task = `import { defineTask } from '@caemble/core'\nimport { Assembly } from '../geometry'\nimport { Steel } from '../material'\nvoid Steel\nexport default defineTask({ kernel: { name: 'solver', version: '1.0.0' }, geometry: () => <Assembly id="assembly" />, config: () => ({}) })`
    expect(analyzeCadSource(experiment).factoryName).toBe('experiment')
    expect(analyzeTaskSource(task).factoryName).toBe('defineTask')
    expect(staticCadSourceImports(experiment)).toEqual(['@caemble/core', './geometry', './material'])
    expect(() => analyzeCadSource(experiment.replace('./geometry', '../geometry'))).toThrow()
    expect(() => analyzeTaskSource(task.replace('../geometry', './geometry'))).toThrow()
  })

  it('accepts named Material values and factories only in material.tsx', () => {
    const source = `import { Material } from '@caemble/core'
export const Steel = new Material('Steel')
export function withDensity(value: number) { void value; return new Material('Dynamic') }
`
    expect(analyzeMaterialSource(source).exports).toEqual(['Steel', 'withDensity'])
    expect(() =>
      analyzeCadSource(
        `import { Material, experiment } from '@caemble/core'
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => null, recordedData: {} })
void new Material('Inline')`,
      ),
    ).toThrow('material.tsx')
    expect(() => analyzeMaterialSource("import { Part } from './geometry'\nexport { Part }")).toThrow('@caemble/core')
    expect(() => analyzeMaterialSource('export default 1')).toThrow('named Material')
    expect(() => analyzeMaterialSource('const Steel = {}\nexport { Steel as default }')).toThrow('named Material')
    expect(() =>
      analyzeGeometrySource("import { Steel } from './material'\nexport const Part = () => <box />"),
    ).toThrow()
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

  it('maps cursor offsets to local named Geometry functions and ignores imported re-exports', () => {
    const coordinate = 'caemble:geometry/jlee/common/part@1.2.3'
    const source = `import { Imported } from "${coordinate}"
export const Arrow = () => <box id="arrow" />
function Declared() { return <sphere id="declared" /> }
const Shared = () => <cylinder id="shared" />
export { Declared, Shared as FirstAlias, Shared as SecondAlias, Imported }
`
    const analysis = analyzeGeometrySource(source)
    const arrowOffset = source.indexOf('<box')
    const declaredOffset = source.indexOf('<sphere')
    const sharedOffset = source.indexOf('<cylinder')
    const importedExportOffset = source.lastIndexOf('Imported')

    expect(geometryExportAtOffset(analysis, arrowOffset)).toBe('Arrow')
    expect(geometryExportAtOffset(analysis, source.indexOf('Arrow'))).toBe('Arrow')
    expect(geometryExportAtOffset(analysis, declaredOffset)).toBe('Declared')
    expect(geometryExportAtOffset(analysis, sharedOffset)).toBe('FirstAlias')
    expect(geometryExportAtOffset(analysis, sharedOffset, 'SecondAlias')).toBe('SecondAlias')
    expect(geometryExportAtOffset(analysis, importedExportOffset)).toBeNull()
    expect(analysis.exports.find((item) => item.name === 'Imported')?.functionRange).toBeNull()
    expect(geometryExportAtOffset(analysis, source.indexOf('function Declared') - 1)).toBeNull()
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

  it('projects one Geometry export with only its transitive declarations and import specifiers', () => {
    const coordinate = 'caemble:geometry/jlee/common/child@1.2.3'
    const source = `import { type Geometry, type Vec3 } from '@caemble/core'
import { Child, Unused } from "${coordinate}"

const Shared: Geometry<{ size: Vec3 }> = ({ size }) => <Child id="child" size={size} />
const Unrelated = () => <Unused id="unused" />

export const Assembly: Geometry<{ size: Vec3 }> = ({ size }) => <Shared id="shared" size={size} />
export const Other: Geometry = () => <Unrelated id="other" />
`
    const projected = projectGeometryExportSource(source, 'Assembly')
    const analysis = analyzeGeometrySource(projected)
    expect(analysis.exports.map((item) => item.name)).toEqual(['Assembly'])
    expect(analysis.imports.map((item) => item.exportName)).toEqual(['Child'])
    expect(projected).toMatch(/import \{\s*type Geometry,\s*type Vec3\s*\} from ['"]@caemble\/core['"]/)
    expect(projected).toContain('const Shared')
    expect(projected).not.toContain('Unused')
    expect(projected).not.toContain('Unrelated')
    expect(projected).not.toContain('Other')
  })

  it('preserves bounded loops and control flow inside a projected Geometry export', () => {
    const source = `import { Box, type Geometry } from '@caemble/core'
export const Pattern: Geometry<{ count?: number; includeCap?: boolean }> = ({ count = 3, includeCap = true }) => {
  const parts: unknown[] = []
  for (let index = 0; index < count; index += 1) {
    parts.push(<Box id={\`cell-\${index}\`} size={[1, 1, 1]} position={[index * 2, 0, 0]} />)
  }
  if (includeCap) parts.push(<Box id="cap" size={[1, 2, 1]} />)
  const mirrored = Array.from({ length: count }, (_, index) => index).map((index) => (
    <Box id={\`mirror-\${index}\`} size={[1, 1, 1]} position={[-index * 2, 0, 0]} />
  ))
  return <>{parts}{mirrored}</>
}
export const Unused = () => <Box id="unused" size={[1, 1, 1]} />
`
    const projected = projectGeometryExportSource(source, 'Pattern')
    expect(projected).toContain("import { Box, type Geometry } from '@caemble/core'")
    expect(projected).toContain('for (let index = 0; index < count; index += 1)')
    expect(projected).toContain('if (includeCap)')
    expect(projected).toContain('Array.from')
    expect(projected).toContain('.map(')
    expect(projected).not.toContain('Unused')
    expect(analyzeGeometrySource(projected).exports.map((item) => item.name)).toEqual(['Pattern'])
  })

  it('keeps a wheel-style private component closure and an aliased public export', () => {
    const source = `import { type Geometry } from '@caemble/core'
const Tire: Geometry = () => <cylinder radius={10} height={2} />
const Hub: Geometry = () => <cylinder radius={4} height={2} />
const WheelParts: Geometry = () => <><Tire id="tire" /><Hub id="hub" /></>
const InternalWheel: Geometry = () => <WheelParts id="parts" />
const Unused: Geometry = () => <box />
export { InternalWheel as WheelAssembly, Unused }
`
    const projected = projectGeometryExportSource(source, 'WheelAssembly')
    expect(projected).toContain('const Tire')
    expect(projected).toContain('const Hub')
    expect(projected).toContain('const WheelParts')
    expect(projected).toContain('export { InternalWheel as WheelAssembly }')
    expect(projected).not.toContain('const Unused')
    expect(analyzeGeometrySource(projected).exports.map((item) => item.name)).toEqual(['WheelAssembly'])
  })

  it('projects an aliased imported binding re-export', () => {
    const coordinate = 'caemble:geometry/jlee/common/child@1.2.3'
    const projected = projectGeometryExportSource(
      `import { Child as InternalChild, Unused } from "${coordinate}"
export { InternalChild as PublishedChild, Unused }
`,
      'PublishedChild',
    )
    expect(projected).toContain('import { Child as InternalChild }')
    expect(projected).toContain('export { InternalChild as PublishedChild }')
    expect(projected).not.toContain('Unused')
    expect(analyzeGeometrySource(projected).exports.map((item) => item.name)).toEqual(['PublishedChild'])
  })

  it('rejects unsafe mutable projection and selected local Geometry dependencies', () => {
    expect(() =>
      projectGeometryExportSource(
        `let size = 1\nexport const Mutable = () => <box size={[size, size, size]} />`,
        'Mutable',
      ),
    ).toThrow('mutable top-level binding')
    expect(() =>
      projectGeometryExportSource(
        `import { Child } from 'caemble:geometry/jlee/common/child@local'\nexport const Parent = () => <Child id="child" />`,
        'Parent',
      ),
    ).toThrow('Publish local Geometry dependency first')
    expect(() => projectGeometryExportSource('export const Part = () => <box />', 'Missing')).toThrow(
      'Geometry export was not found',
    )
  })
})
