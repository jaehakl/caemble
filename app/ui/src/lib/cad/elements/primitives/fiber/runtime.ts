import { extrusions, geometries } from '@jscad/modeling'
import type { MutableVec3 } from '../../../geometry/vec3'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
import { fiberManifest, type FiberAttributes } from './definition'
import { sampleFiber } from './sampling'

const tau = Math.PI * 2

export function createFiberGeometry(attributes: FiberAttributes) {
  const sampled = sampleFiber(attributes)
  const slices = sampled.points.map((point, pathIndex) => {
    const frame = sampled.frames[pathIndex]
    const radius = sampled.radii[pathIndex]
    const ring = Array.from({ length: sampled.radialSegments }, (_, radialIndex) => {
      const angle = (tau * radialIndex) / sampled.radialSegments
      const normalScale = radius * Math.cos(angle)
      const binormalScale = radius * Math.sin(angle)
      return [
        point[0] + normalScale * frame.normal[0] + binormalScale * frame.binormal[0],
        point[1] + normalScale * frame.normal[1] + binormalScale * frame.binormal[1],
        point[2] + normalScale * frame.normal[2] + binormalScale * frame.binormal[2],
      ] as MutableVec3
    })
    return extrusions.slice.fromPoints(ring)
  })

  return extrusions.extrudeFromSlices(
    {
      numberOfSlices: slices.length,
      capStart: true,
      capEnd: true,
      close: false,
      callback: (_progress, index, base) => (index === 0 ? base : slices[index]),
    },
    slices[0],
  )
}

export const fiberDefinition = {
  kind: 'primitive',
  tag: fiberManifest.tag,
  manifest: fiberManifest,
  defaultProps: Object.freeze({
    from: Object.freeze([0, 0, -0.5]),
    to: Object.freeze([0, 0, 0.5]),
    basePath: undefined,
    radius: 0.05,
    helix: undefined,
    fourier: undefined,
    envelopePower: 2,
    up: undefined,
    pathSegments: 128,
    radialSegments: 12,
  }),
  createGeometry(props) {
    return createFiberGeometry(props as FiberAttributes)
  },
  createSurfaces(geometry, props) {
    const polygons = geometries.geom3.toPolygons(geometry as ReturnType<typeof geometries.geom3.create>)
    const radialSegments = props.radialSegments === undefined ? 12 : (props.radialSegments as number)
    const capPolygonCount = radialSegments - 2
    const endCapStart = polygons.length - capPolygonCount * 2
    const startCapStart = polygons.length - capPolygonCount
    return [
      {
        name: 'Start cap',
        polygonIndices: Array.from({ length: capPolygonCount }, (_value, index) => startCapStart + index),
      },
      {
        name: 'Side',
        polygonIndices: Array.from({ length: endCapStart }, (_value, index) => index),
      },
      {
        name: 'End cap',
        polygonIndices: Array.from({ length: capPolygonCount }, (_value, index) => endCapStart + index),
      },
    ]
  },
} satisfies PrimitiveElementDefinition<'fiber'>
