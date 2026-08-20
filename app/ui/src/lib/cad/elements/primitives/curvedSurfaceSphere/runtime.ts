import { geometries, primitives } from '@jscad/modeling'
import { CadModelError } from '../../../model/core'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
import { curvedSurfaceSphereManifest, type CurvedSurfaceSphereAttributes } from './definition'

const tau = Math.PI * 2

export function createCurvedSurfaceSphereGeometry(attributes: CurvedSurfaceSphereAttributes) {
  const azimuthalCurve = attributes.azimuthalCurve!
  const polarCurve = attributes.polarCurve!
  const curves = [
    { name: 'azimuthalCurve', modes: azimuthalCurve },
    { name: 'polarCurve', modes: polarCurve },
  ] as const
  curves.forEach(({ name, modes }) => {
    if (!Array.isArray(modes) || modes.length === 0) {
      throw new CadModelError(`<curvedSurfaceSphere> ${name} must be a non-empty array of Fourier modes.`)
    }
    modes.forEach((mode, index) => {
      if (typeof mode !== 'object' || mode === null || Array.isArray(mode)) {
        throw new CadModelError(`<curvedSurfaceSphere> ${name}[${index}] must be an object.`)
      }
      if (typeof mode.amplitude !== 'number' || !Number.isFinite(mode.amplitude) || mode.amplitude < 0) {
        throw new CadModelError(
          `<curvedSurfaceSphere> ${name}[${index}].amplitude must be a finite non-negative number.`,
        )
      }
      if (typeof mode.phase !== 'number' || !Number.isFinite(mode.phase)) {
        throw new CadModelError(`<curvedSurfaceSphere> ${name}[${index}].phase must be a finite number.`)
      }
    })
  })

  const azimuthalSegments = attributes.azimuthalSegments === undefined ? 64 : attributes.azimuthalSegments
  if (!Number.isSafeInteger(azimuthalSegments) || azimuthalSegments < 4) {
    throw new CadModelError(
      '<curvedSurfaceSphere> azimuthalSegments must be a safe integer greater than or equal to 4.',
    )
  }
  const polarSegments = attributes.polarSegments === undefined ? 32 : attributes.polarSegments
  if (!Number.isSafeInteger(polarSegments) || polarSegments < 2) {
    throw new CadModelError('<curvedSurfaceSphere> polarSegments must be a safe integer greater than or equal to 2.')
  }

  const pointAt = (theta: number, phi: number, azimuthalIndex: number, polarIndex: number) => {
    let azimuthalRadius = 0
    azimuthalCurve.forEach((mode, modeIndex) => {
      azimuthalRadius += mode.amplitude * Math.cos(modeIndex * theta + mode.phase)
    })
    let polarRadius = 0
    polarCurve.forEach((mode, modeIndex) => {
      polarRadius += mode.amplitude * Math.cos(modeIndex * phi + mode.phase)
    })
    const radius = azimuthalRadius * polarRadius
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new CadModelError(
        `<curvedSurfaceSphere> radius must be finite and positive at azimuthal sample ${azimuthalIndex}, polar sample ${polarIndex}.`,
      )
    }

    const radialDistance = radius * Math.sin(phi)
    return [radialDistance * Math.cos(theta), radialDistance * Math.sin(theta), radius * Math.cos(phi)] as [
      number,
      number,
      number,
    ]
  }

  const points: [number, number, number][] = [pointAt(0, 0, 0, 0)]
  for (let polarIndex = 1; polarIndex < polarSegments; polarIndex += 1) {
    const phi = (Math.PI * polarIndex) / polarSegments
    for (let azimuthalIndex = 0; azimuthalIndex < azimuthalSegments; azimuthalIndex += 1) {
      const theta = (tau * azimuthalIndex) / azimuthalSegments
      points.push(pointAt(theta, phi, azimuthalIndex, polarIndex))
    }
  }
  const southPoleIndex = points.push(pointAt(0, Math.PI, 0, polarSegments)) - 1
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
    return [{ name: 'Outer', polygonIndices: polygons.map((_polygon, index) => index) }]
  },
} satisfies PrimitiveElementDefinition<'curvedSurfaceSphere'>
