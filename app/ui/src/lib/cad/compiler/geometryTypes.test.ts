import { describe, expect, it } from 'vitest'
import { geometryCoordinateTypes } from './geometryTypes'

describe('generated Geometry named-export declarations', () => {
  it('links every named export to its exact virtual source and makes destructuring defaults optional', () => {
    const coordinate = 'caemble:geometry/jlee/common/notched@1.0.0'
    const declarations = geometryCoordinateTypes({
      entryImports: [{ exportName: 'Notched', alias: 'Notched', coordinate }],
      modules: [
        {
          coordinate,
          source: `import { type Geometry } from '@caemble/core'
export const Notched: Geometry<{ size: number; required: number }> = ({ size = 1, required }) => <box scale={[size, required, 1]} />
export function Preview() { return <sphere /> }`,
          imports: [],
        },
      ],
    })
    expect(declarations).toContain(`declare module "${coordinate}"`)
    expect(declarations).toContain(`typeof import("./geometries/${encodeURIComponent(coordinate)}")["Notched"]`)
    expect(declarations).toContain('Partial<Pick<NotchedProps, NotchedDefaultedProps>>')
    expect(declarations).toContain('export { Preview }')
    expect(declarations).not.toContain('declare const Notched')
  })
})
