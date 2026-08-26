import { geometries, primitives } from '@jscad/modeling'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
import { cylinderManifest } from './definition'

export const cylinderDefinition = {
  kind: 'primitive',
  tag: cylinderManifest.tag,
  manifest: cylinderManifest,
  defaultProps: Object.freeze({ radius: 0.5, radius_2: undefined, height: 1, segments: 32 }),
  createGeometry(props) {
    const radius = props.radius as number
    const radius_2 = props.radius_2 === undefined ? radius : (props.radius_2 as number)
    const segments = props.segments === undefined ? 32 : (props.segments as number)
    return primitives.cylinderElliptic({
      startRadius: [radius, radius],
      endRadius: [radius_2, radius_2],
      height: props.height as number,
      segments,
    })
  },
  createSurfaces(geometry) {
    const groups = [
      { surfaceIndex: 0, label: 'Bottom', polygonIndices: [] as number[] },
      { surfaceIndex: 1, label: 'Side', polygonIndices: [] as number[] },
      { surfaceIndex: 2, label: 'Top', polygonIndices: [] as number[] },
    ]
    geometries.geom3.toPolygons(geometry as ReturnType<typeof geometries.geom3.create>).forEach((polygon, index) => {
      const normalZ = geometries.poly3.plane(polygon)[2]
      if (Math.abs(normalZ + 1) < 1e-10) groups[0].polygonIndices.push(index)
      else if (Math.abs(normalZ - 1) < 1e-10) groups[2].polygonIndices.push(index)
      else groups[1].polygonIndices.push(index)
    })

    return groups.filter(({ polygonIndices }) => polygonIndices.length > 0)
  },
} satisfies PrimitiveElementDefinition<'cylinder'>
