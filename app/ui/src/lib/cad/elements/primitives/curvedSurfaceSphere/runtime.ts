import { geometries, primitives } from '@jscad/modeling'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
import { curvedSurfaceSphereManifest, type CurvedSurfaceSphereAttributes } from './definition'

const tau = Math.PI * 2

export function createCurvedSurfaceSphereGeometry(attributes: CurvedSurfaceSphereAttributes) {
  const azimuthalCurve = attributes.azimuthalCurve!
  const polarCurve = attributes.polarCurve!

  const azimuthalSegments = attributes.azimuthalSegments === undefined ? 64 : attributes.azimuthalSegments
  const polarSegments = attributes.polarSegments === undefined ? 32 : attributes.polarSegments

  const pointAt = (theta: number, phi: number) => {
    let azimuthalRadius = 0
    azimuthalCurve.forEach((mode, modeIndex) => {
      azimuthalRadius += mode.amplitude * Math.cos(modeIndex * theta + mode.phase)
    })
    let polarRadius = 0
    polarCurve.forEach((mode, modeIndex) => {
      polarRadius += mode.amplitude * Math.cos(modeIndex * phi + mode.phase)
    })
    const radius = azimuthalRadius * polarRadius

    const radialDistance = radius * Math.sin(phi)
    return [radialDistance * Math.cos(theta), radialDistance * Math.sin(theta), radius * Math.cos(phi)] as [
      number,
      number,
      number,
    ]
  }

  const points: [number, number, number][] = [pointAt(0, 0)]
  for (let polarIndex = 1; polarIndex < polarSegments; polarIndex += 1) {
    const phi = (Math.PI * polarIndex) / polarSegments
    for (let azimuthalIndex = 0; azimuthalIndex < azimuthalSegments; azimuthalIndex += 1) {
      const theta = (tau * azimuthalIndex) / azimuthalSegments
      points.push(pointAt(theta, phi))
    }
  }
  const southPoleIndex = points.push(pointAt(0, Math.PI)) - 1
  const faces: number[][] = []

  for (let azimuthalIndex = 0; azimuthalIndex < azimuthalSegments; azimuthalIndex += 1) {
    const nextAzimuthalIndex = (azimuthalIndex + 1) % azimuthalSegments
    faces.push([0, 1 + azimuthalIndex, 1 + nextAzimuthalIndex])
  }
  for (let polarIndex = 1; polarIndex < polarSegments - 1; polarIndex += 1) {
    const upperRingStart = 1 + (polarIndex - 1) * azimuthalSegments
    const lowerRingStart = upperRingStart + azimuthalSegments
    for (let azimuthalIndex = 0; azimuthalIndex < azimuthalSegments; azimuthalIndex += 1) {
      const nextAzimuthalIndex = (azimuthalIndex + 1) % azimuthalSegments
      faces.push([
        upperRingStart + azimuthalIndex,
        lowerRingStart + azimuthalIndex,
        lowerRingStart + nextAzimuthalIndex,
      ])
      faces.push([
        upperRingStart + azimuthalIndex,
        lowerRingStart + nextAzimuthalIndex,
        upperRingStart + nextAzimuthalIndex,
      ])
    }
  }
  const lastRingStart = 1 + (polarSegments - 2) * azimuthalSegments
  for (let azimuthalIndex = 0; azimuthalIndex < azimuthalSegments; azimuthalIndex += 1) {
    const nextAzimuthalIndex = (azimuthalIndex + 1) % azimuthalSegments
    faces.push([lastRingStart + azimuthalIndex, southPoleIndex, lastRingStart + nextAzimuthalIndex])
  }

  return primitives.polyhedron({ points, faces })
}

export const curvedSurfaceSphereDefinition = {
  kind: 'primitive',
  tag: curvedSurfaceSphereManifest.tag,
  manifest: curvedSurfaceSphereManifest,
  defaultProps: Object.freeze({
    azimuthalCurve: Object.freeze([Object.freeze({ amplitude: 0.5, phase: 0 })]),
    polarCurve: Object.freeze([Object.freeze({ amplitude: 1, phase: 0 })]),
    azimuthalSegments: 64,
    polarSegments: 32,
  }),
  createGeometry(props) {
    return createCurvedSurfaceSphereGeometry(props as CurvedSurfaceSphereAttributes)
  },
  createSurfaces(geometry) {
    const polygons = geometries.geom3.toPolygons(geometry as ReturnType<typeof geometries.geom3.create>)
    return [{ surfaceIndex: 0, label: 'Outer', polygonIndices: polygons.map((_polygon, index) => index) }]
  },
} satisfies PrimitiveElementDefinition<'curvedSurfaceSphere'>
