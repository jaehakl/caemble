import { geometries, primitives } from '@jscad/modeling'
import { CadModelError } from '../../../model/core'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
import { boxManifest } from './definition'

export const boxDefinition = {
  kind: 'primitive',
  tag: boxManifest.tag,
  manifest: boxManifest,
  defaultProps: Object.freeze({ size: Object.freeze([1, 1, 1]) }),
  createGeometry(props) {
    if (
      !Array.isArray(props.size) ||
      props.size.length !== 3 ||
      props.size.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    ) {
      throw new CadModelError('<box> size must be an array of exactly three finite positive numbers.')
    }
    return primitives.cuboid({ size: [props.size[0], props.size[1], props.size[2]] })
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
