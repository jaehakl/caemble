import { extrusions, geometries } from '@jscad/modeling'
import { CadModelError } from '../../../model/core'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
import {
  curvedEdgeCylinderManifest,
  type CurvedEdgeCylinderAttributes,
  type CurvedEdgeCylinderFourierMode,
  type CurvedEdgeCylinderTaylorCurve,
} from './definition'

const tau = Math.PI * 2

export function createCurvedEdgeCylinderGeometry(attributes: CurvedEdgeCylinderAttributes) {
  const height = attributes.height!
  if (typeof attributes.height !== 'number' || !Number.isFinite(attributes.height) || attributes.height <= 0) {
    throw new CadModelError('<curvedEdgeCylinder> height must be a finite positive number.')
  }

  if (!Array.isArray(attributes.azimuthalCurve) || attributes.azimuthalCurve.length === 0) {
    throw new CadModelError('<curvedEdgeCylinder> azimuthalCurve must be a non-empty array of Fourier modes.')
  }
  const azimuthalCurve = attributes.azimuthalCurve.map((mode, index) => {
    if (typeof mode !== 'object' || mode === null || Array.isArray(mode)) {
      throw new CadModelError(`<curvedEdgeCylinder> azimuthalCurve[${index}] must be an object.`)
    }
    if (typeof mode.amplitude !== 'number' || !Number.isFinite(mode.amplitude) || mode.amplitude < 0) {
      throw new CadModelError(
        `<curvedEdgeCylinder> azimuthalCurve[${index}].amplitude must be a finite non-negative number.`,
      )
    }
    if (typeof mode.phase !== 'number' || !Number.isFinite(mode.phase)) {
      throw new CadModelError(`<curvedEdgeCylinder> azimuthalCurve[${index}].phase must be a finite number.`)
    }
    return mode as CurvedEdgeCylinderFourierMode
  })

  if (
    typeof attributes.verticalCurve !== 'object' ||
    attributes.verticalCurve === null ||
    Array.isArray(attributes.verticalCurve)
  ) {
    throw new CadModelError('<curvedEdgeCylinder> verticalCurve must be an object with origin and coefficients.')
  }
  if (typeof attributes.verticalCurve.origin !== 'number' || !Number.isFinite(attributes.verticalCurve.origin)) {
    throw new CadModelError('<curvedEdgeCylinder> verticalCurve.origin must be a finite number.')
  }
  if (!Array.isArray(attributes.verticalCurve.coefficients) || attributes.verticalCurve.coefficients.length === 0) {
    throw new CadModelError('<curvedEdgeCylinder> verticalCurve.coefficients must be a non-empty array.')
  }
  attributes.verticalCurve.coefficients.forEach((coefficient, index) => {
    if (typeof coefficient !== 'number' || !Number.isFinite(coefficient)) {
      throw new CadModelError(`<curvedEdgeCylinder> verticalCurve.coefficients[${index}] must be a finite number.`)
    }
  })
  const verticalCurve = attributes.verticalCurve as CurvedEdgeCylinderTaylorCurve

  const azimuthalSegments = attributes.azimuthalSegments === undefined ? 64 : attributes.azimuthalSegments
  if (!Number.isSafeInteger(azimuthalSegments) || azimuthalSegments < 4) {
    throw new CadModelError('<curvedEdgeCylinder> azimuthalSegments must be a safe integer greater than or equal to 4.')
  }
  const verticalSegments = attributes.verticalSegments === undefined ? 32 : attributes.verticalSegments
  if (!Number.isSafeInteger(verticalSegments) || verticalSegments < 1) {
    throw new CadModelError('<curvedEdgeCylinder> verticalSegments must be a safe integer greater than or equal to 1.')
  }

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
      if (!Number.isFinite(radius) || radius <= 0) {
        throw new CadModelError(
          `<curvedEdgeCylinder> radius must be finite and positive at azimuthal sample ${azimuthalIndex}, vertical sample ${verticalIndex}.`,
        )
      }
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
