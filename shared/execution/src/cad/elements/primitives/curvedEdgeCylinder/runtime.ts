import { extrusions, geometries } from '@jscad/modeling'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
import { curvedEdgeCylinderManifest, type CurvedEdgeCylinderAttributes } from './definition'

const tau = Math.PI * 2

export function createCurvedEdgeCylinderGeometry(attributes: CurvedEdgeCylinderAttributes) {
  const height = attributes.height!
  const azimuthalCurve = attributes.azimuthalCurve!
  const verticalCurve = attributes.verticalCurve!

  const azimuthalSegments = attributes.azimuthalSegments === undefined ? 64 : attributes.azimuthalSegments
  const verticalSegments = attributes.verticalSegments === undefined ? 32 : attributes.verticalSegments

  const slices = Array.from({ length: verticalSegments + 1 }, (_, verticalIndex) => {
    const z = -height / 2 + (height * verticalIndex) / verticalSegments
    const offset = z - verticalCurve.origin
    let verticalRadius = 0
    for (let order = verticalCurve.coefficients.length - 1; order >= 0; order -= 1) {
      verticalRadius = verticalRadius * offset + verticalCurve.coefficients[order]
    }

    const points = Array.from({ length: azimuthalSegments }, (_, azimuthalIndex) => {
      const theta = (tau * azimuthalIndex) / azimuthalSegments
      let azimuthalRadius = 0
      azimuthalCurve.forEach((mode, modeIndex) => {
        azimuthalRadius += mode.amplitude * Math.cos(modeIndex * theta + mode.phase)
      })
      const radius = azimuthalRadius * verticalRadius
      return [radius * Math.cos(theta), radius * Math.sin(theta), z] as [number, number, number]
    })
    return extrusions.slice.fromPoints(points)
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

export const curvedEdgeCylinderDefinition = {
  kind: 'primitive',
  tag: curvedEdgeCylinderManifest.tag,
  manifest: curvedEdgeCylinderManifest,
  defaultProps: Object.freeze({
    height: 1,
    azimuthalCurve: Object.freeze([Object.freeze({ amplitude: 0.5, phase: 0 })]),
    verticalCurve: Object.freeze({ origin: 0, coefficients: Object.freeze([1]) }),
    azimuthalSegments: 64,
    verticalSegments: 32,
  }),
  createGeometry(props) {
    return createCurvedEdgeCylinderGeometry(props as CurvedEdgeCylinderAttributes)
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
    return groups
  },
} satisfies PrimitiveElementDefinition<'curvedEdgeCylinder'>
