import { describe, expect, it } from 'vitest'
import {
  evaluatePublicExampleBundle,
  expectReliablePublicScene,
  standalonePublicExampleBundle,
} from '@/test/publicExampleHarness'
import { cadAuthoringContract } from '../catalog'
import {
  insertPrimitiveAfterCursorLine,
  operationAuthoringElements,
  primitiveAuthoringElements,
  wrapSelectionWithOperation,
} from './authoringEdits'

function primitiveSource() {
  return `import { experiment } from '@caemble/core'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {},
  geometry: () => (
    <>
      {/* insert here */}
    </>
  ),
  recordedData: {},
})
`
}

function operationSource(childCount: number) {
  const children = [
    '      <Box id="base" size={[4, 4, 4]} />',
    '      <Box id="tool" size={[2, 2, 2]} position={[0.5, 0, 0]} />',
  ].slice(0, childCount)
  const marker = children.join('\n')
  return {
    source: `import { Box, experiment } from '@caemble/core'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {},
  geometry: () => (
    <>
${marker}
    </>
  ),
  recordedData: {},
})
`,
    marker,
  }
}

describe('CAD ribbon authoring edits', () => {
  it('inserts a fully expanded primitive below the cursor line and extends the core import', () => {
    const source = `import { type Geometry } from '@caemble/core'
export const Part: Geometry = () => (
  <>
    <Box id="box" />
  </>
)
`
    const box = primitiveAuthoringElements.find((element) => element.tag === 'box')!
    const result = insertPrimitiveAfterCursorLine(source, source.indexOf('<Box'), box)

    expect(result.source).toContain("import { type Geometry, Box } from '@caemble/core'")
    expect(result.source).toContain(`    <Box id="box" />
    <Box
      id="box-2"
      size={[1, 1, 1]}
      position={[0, 0, 0]}
      rotation={[0, 0, 0]}
      scale={[1, 1, 1]}
    />`)
    expect(result.cursorOffset).toBe(result.source.indexOf('    />') + '    />'.length)
  })

  it('reuses a core alias and creates a safe alias for a conflicting local binding', () => {
    const box = primitiveAuthoringElements.find((element) => element.tag === 'box')!
    const aliased = `import { Box as Cuboid, type Geometry } from '@caemble/core'
export const Part: Geometry = () => <></>`
    const reused = insertPrimitiveAfterCursorLine(aliased, aliased.indexOf('<></>'), box)
    expect(reused.source).not.toContain('CaembleBox')
    expect(reused.source).toContain('<Cuboid\n')

    const conflict = `import { type Geometry } from '@caemble/core'
const Box = 'local'
export const Part: Geometry = () => <></>`
    const safe = insertPrimitiveAfterCursorLine(conflict, conflict.indexOf('<></>'), box)
    expect(safe.source).toContain('Box as CaembleBox')
    expect(safe.source).toContain('<CaembleBox\n')
  })

  it('creates a core import when absent and preserves a trailing-comma import', () => {
    const sphere = primitiveAuthoringElements.find((element) => element.tag === 'sphere')!
    const withoutImport = 'export const Part = () => <></>'
    const created = insertPrimitiveAfterCursorLine(withoutImport, withoutImport.indexOf('<></>'), sphere)
    expect(created.source).toMatch(/^import \{ Sphere \} from '@caemble\/core'\n/u)

    const multiline = `import {
  type Geometry,
} from '@caemble/core'
export const Part: Geometry = () => <></>`
    const extended = insertPrimitiveAfterCursorLine(multiline, multiline.indexOf('<></>'), sphere)
    expect(extended.source).toContain('type Geometry, Sphere\n}')
  })

  it.each(primitiveAuthoringElements)('includes every current <$authoringName> prop exactly once', (element) => {
    const source = primitiveSource()
    const result = insertPrimitiveAfterCursorLine(source, source.indexOf('{/* insert here */}'), element)
    const expected = [
      'id',
      ...element.properties.map((property) => property.name),
      ...(element.standardTransforms
        ? cadAuthoringContract.transforms.canonicalProperties.map((property) => property.name)
        : []),
    ]
    expected.forEach((name) => expect(result.source.match(new RegExp(`\\b${name}=`, 'gu'))).toHaveLength(1))
    expect(result.source).not.toMatch(/\b(?:pos|rotate)=/u)
  })

  it('wraps an indented multiline selection and rejects whitespace-only selections', () => {
    const source = `export const Part = () => (
  <>
    <Box id="left" />
    <Box id="right" />
  </>
)`
    const union = operationAuthoringElements.find((element) => element.tag === 'union')!
    const start = source.indexOf('    <Box id="left"')
    const end = source.indexOf('\n  </>')
    const result = wrapSelectionWithOperation(source, start, end, union)!

    expect(result.source).toContain(`    <union
      id="union"
      position={[0, 0, 0]}
      rotation={[0, 0, 0]}
      scale={[1, 1, 1]}
    >
      <Box id="left" />
      <Box id="right" />
    </union>`)
    expect(wrapSelectionWithOperation(source, 0, 0, union)).toBeNull()
    expect(wrapSelectionWithOperation('   ', 0, 3, union)).toBeNull()
  })

  it.each(primitiveAuthoringElements)(
    'compiles and evaluates the generated <$authoringName> snippet',
    async (element) => {
      const source = primitiveSource()
      const result = insertPrimitiveAfterCursorLine(source, source.indexOf('{/* insert here */}'), element)
      const evaluated = await evaluatePublicExampleBundle(standalonePublicExampleBundle(result.source))
      expectReliablePublicScene(evaluated.scene)
    },
  )

  it.each(operationAuthoringElements)(
    'compiles and evaluates the generated <$authoringName> wrapper',
    async (element) => {
      const childCount = element.tag === 'subtract' || element.tag === 'intersect' ? 2 : 1
      const input = operationSource(childCount)
      const start = input.source.indexOf(input.marker)
      const result = wrapSelectionWithOperation(input.source, start, start + input.marker.length, element)!
      const evaluated = await evaluatePublicExampleBundle(standalonePublicExampleBundle(result.source))
      expectReliablePublicScene(evaluated.scene)
    },
  )
})
