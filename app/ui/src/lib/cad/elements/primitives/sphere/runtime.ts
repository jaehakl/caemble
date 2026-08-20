import { geometries, primitives } from '@jscad/modeling'
import { CadModelError } from '../../../model/core'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
import { sphereManifest } from './definition'

export const sphereDefinition = {
  kind: 'primitive',
  tag: sphereManifest.tag,
  manifest: sphereManifest,
  defaultProps: Object.freeze({ radius: 0.5, segments: 32 }),
  createGeometry(props) {
    if (typeof props.radius !== 'number' || !Number.isFinite(props.radius) || props.radius <= 0) {
      throw new CadModelError('<sphere> radius must be a finite positive number.')
    }
    const segments = props.segments === undefined ? 32 : props.segments
    if (!Number.isSafeInteger(segments) || (segments as number) < 4) {
      throw new CadModelError('<sphere> segments must be a safe integer greater than or equal to 4.')
    }
    return primitives.sphere({ radius: props.radius, segments: segments as number })
  },
  createSurfaces(geometry) {
    const polygons = geometries.geom3.toPolygons(geometry as ReturnType<typeof geometries.geom3.create>)
    return [{ name: 'Outer', polygonIndices: polygons.map((_polygon, index) => index) }]
  },
} satisfies PrimitiveElementDefinition<'sphere'>
