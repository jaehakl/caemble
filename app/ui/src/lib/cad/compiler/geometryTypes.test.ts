import { describe, expect, it } from 'vitest'
import type { EffectiveGeometryGraph } from '../source/effectiveGeometryGraph'
import type { GeometryCoordinate } from '../source/geometrySnapshot'
import { geometryCoordinateTypes, geometryRootTypes } from './geometryTypes'

describe('generated Geometry module declarations', () => {
  it('links exact coordinates and root aliases to the source module default export', () => {
    const coordinate = 'caemble:geometry/jlee/common/notched@1.0.0' as GeometryCoordinate
    const encoded = encodeURIComponent(coordinate)
    const graph = {
      graphHash: 'a'.repeat(64),
      roots: [{ alias: 'Notched', coordinate, moduleHash: 'b'.repeat(64) }],
      modules: [
        {
          coordinate,
          source: `import { type Geometry, type Vec3 } from '@caemble/core'
const Notched: Geometry<{ size: Vec3; required: number }> = ({ size = [1, 1, 1], required }) => <box size={size} scale={[required, 1, 1]} />
export default Notched`,
          sourceHash: 'c'.repeat(64),
          moduleHash: 'b'.repeat(64),
          imports: [],
        },
      ],
    } satisfies EffectiveGeometryGraph

    expect(geometryCoordinateTypes(graph)).toContain(`declare module "${coordinate}"`)
    expect(geometryCoordinateTypes(graph)).toContain(`typeof import("./geometries/${encoded}").default`)
    expect(geometryCoordinateTypes(graph)).toContain('type DefaultedProps = Extract<"size", keyof GeometryProps>')
    expect(geometryCoordinateTypes(graph)).toContain('Partial<Pick<GeometryProps, DefaultedProps>>')
    expect(geometryRootTypes(graph)).toContain(`declare const Notched: typeof import("${coordinate}").default`)
  })
})
