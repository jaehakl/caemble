import { geometries, primitives } from '@jscad/modeling'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
import { sphereManifest } from './definition'

export const sphereDefinition = {
  kind: 'primitive',
  tag: sphereManifest.tag,
  manifest: sphereManifest,
  defaultProps: Object.freeze({ radius: 0.5, segments: 32 }),
  createGeometry(props) {
    const segments = props.segments === undefined ? 32 : (props.segments as number)
    return primitives.sphere({ radius: props.radius as number, segments })
  },
  createSurfaces(geometry) {
    const polygons = geometries.geom3.toPolygons(geometry as ReturnType<typeof geometries.geom3.create>)
    return [{ surfaceIndex: 0, label: 'Outer', polygonIndices: polygons.map((_polygon, index) => index) }]
  },
} satisfies PrimitiveElementDefinition<'sphere'>
