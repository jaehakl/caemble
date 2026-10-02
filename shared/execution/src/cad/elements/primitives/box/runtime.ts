import { geometries, primitives } from '@jscad/modeling'
import type { Vec3 } from '../../../model/types'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
import { boxManifest } from './definition'

export const boxDefinition = {
  kind: 'primitive',
  tag: boxManifest.tag,
  manifest: boxManifest,
  defaultProps: Object.freeze({ size: Object.freeze([1, 1, 1]) }),
  createGeometry(props) {
    const size = props.size as Vec3
    return primitives.cuboid({ size: [size[0], size[1], size[2]] })
  },
  createSurfaces(geometry) {
    const polygons = geometries.geom3.toPolygons(geometry as ReturnType<typeof geometries.geom3.create>)
    const faces = [
      { surfaceIndex: 0, label: 'Local -X', normal: [-1, 0, 0] },
      { surfaceIndex: 1, label: 'Local +X', normal: [1, 0, 0] },
      { surfaceIndex: 2, label: 'Local -Y', normal: [0, -1, 0] },
      { surfaceIndex: 3, label: 'Local +Y', normal: [0, 1, 0] },
      { surfaceIndex: 4, label: 'Local -Z', normal: [0, 0, -1] },
      { surfaceIndex: 5, label: 'Local +Z', normal: [0, 0, 1] },
    ]

    return faces.map((face) => ({
      surfaceIndex: face.surfaceIndex,
      label: face.label,
      polygonIndices: polygons.flatMap((polygon, polygonIndex) => {
        const plane = geometries.poly3.plane(polygon)
        return plane.slice(0, 3).every((coordinate, axis) => Math.abs(coordinate - face.normal[axis]) < 1e-10)
          ? [polygonIndex]
          : []
      }),
    }))
  },
} satisfies PrimitiveElementDefinition<'box'>
