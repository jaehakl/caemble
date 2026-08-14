import { geometries, measurements } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { Material } from '../../../model/core'
import { evaluateCad, h } from '../../../index'
import type { CurvedEdgeCylinderAttributes } from './definition'
import { createCurvedEdgeCylinderGeometry } from './runtime'

const validAttributes = {
  height: 2,
  azimuthalCurve: [{ amplitude: 1, phase: 0 }],
  verticalCurve: { origin: 0, coefficients: [1] },
  azimuthalSegments: 8,
  verticalSegments: 2,
} satisfies CurvedEdgeCylinderAttributes

describe('curved edge cylinder geometry', () => {
  it('creates a valid capped constant-radius solid', () => {
    const geometry = createCurvedEdgeCylinderGeometry({
      height: 4,
      azimuthalCurve: [{ amplitude: 2, phase: 0 }],
      verticalCurve: { origin: 7, coefficients: [3] },
      azimuthalSegments: 4,
      verticalSegments: 1,
    })

    expect(() => geometries.geom3.validate(geometry)).not.toThrow()
    const bounds = measurements.measureBoundingBox(geometry)
    expect(bounds[0][0]).toBeCloseTo(-6)
    expect(bounds[0][1]).toBeCloseTo(-6)
    expect(bounds[0][2]).toBeCloseTo(-2)
    expect(bounds[1][0]).toBeCloseTo(6)
    expect(bounds[1][1]).toBeCloseTo(6)
    expect(bounds[1][2]).toBeCloseTo(2)
    expect(measurements.measureVolume(geometry)).toBeCloseTo(288)
  })

  it('samples Fourier modes and Taylor coefficients around a shifted origin', () => {
    const geometry = createCurvedEdgeCylinderGeometry({
      height: 2,
      azimuthalCurve: [
        { amplitude: 3, phase: 0 },
        { amplitude: 1, phase: 0 },
      ],
      verticalCurve: { origin: 1, coefficients: [2, 0, 1] },
      azimuthalSegments: 4,
      verticalSegments: 2,
    })
    const points = geometries.geom3.toPoints(geometry).flat()

    expect(points.some(([x, y, z]) => Math.abs(x - 24) < 1e-9 && Math.abs(y) < 1e-9 && z === -1)).toBe(true)
    expect(points.some(([x, y, z]) => Math.abs(x + 12) < 1e-9 && Math.abs(y) < 1e-9 && z === -1)).toBe(true)
    expect(points.some(([x, y, z]) => Math.abs(x - 12) < 1e-9 && Math.abs(y) < 1e-9 && z === 0)).toBe(true)
    expect(points.some(([x, y, z]) => Math.abs(x - 8) < 1e-9 && Math.abs(y) < 1e-9 && z === 1)).toBe(true)
    expect(points.some(([x, y, z]) => Math.abs(x + 4) < 1e-9 && Math.abs(y) < 1e-9 && z === 1)).toBe(true)
  })

  it('inherits Material and participates in transforms and same-Material CSG', () => {
    const material = new Material('Curved Cylinder', { color: '#0f766e' })
    function CurvedCylinder() {
      return h('curvedEdgeCylinder', validAttributes)
    }

    const [translated] = evaluateCad(
      h(CurvedCylinder, { id: 'cylinder', pos: [3, 0, 0], materials: { body: material } }),
    )
    const [combined] = evaluateCad(
      h(
        () =>
          h(
            'union',
            null,
            h(CurvedCylinder, { id: 'first', materials: { body: material } }),
            h(CurvedCylinder, { id: 'second', pos: [1, 0, 0], materials: { body: material } }),
          ),
        { id: 'combined' },
      ),
    )

    const bounds = measurements.measureBoundingBox(translated.geometry)
    expect(bounds[0][0]).toBeCloseTo(2)
    expect(bounds[1][0]).toBeCloseTo(4)
    expect(translated.material?.name).toBe('Curved Cylinder')
    expect(translated.surfaces.map((surface) => surface.name)).toEqual(['Bottom', 'Side', 'Top'])
    expect(combined.material?.name).toBe('Curved Cylinder')
    expect(measurements.measureVolume(combined.geometry)).toBeGreaterThan(0)
  })
})

describe('curved edge cylinder validation', () => {
  it('rejects invalid height and segment counts', () => {
    expect(() => createCurvedEdgeCylinderGeometry({ ...validAttributes, height: 0 })).toThrow(
      '<curvedEdgeCylinder> height',
    )
    expect(() => createCurvedEdgeCylinderGeometry({ ...validAttributes, height: Number.POSITIVE_INFINITY })).toThrow(
      '<curvedEdgeCylinder> height',
    )
    expect(() => createCurvedEdgeCylinderGeometry({ ...validAttributes, azimuthalSegments: 3 })).toThrow(
      '<curvedEdgeCylinder> azimuthalSegments',
    )
    expect(() => createCurvedEdgeCylinderGeometry({ ...validAttributes, azimuthalSegments: 4.5 })).toThrow(
      '<curvedEdgeCylinder> azimuthalSegments',
    )
    expect(() => createCurvedEdgeCylinderGeometry({ ...validAttributes, verticalSegments: 0 })).toThrow(
      '<curvedEdgeCylinder> verticalSegments',
    )
  })

  it('rejects malformed Fourier modes', () => {
    expect(() => createCurvedEdgeCylinderGeometry({ ...validAttributes, azimuthalCurve: [] })).toThrow(
      '<curvedEdgeCylinder> azimuthalCurve',
    )
    expect(() =>
      createCurvedEdgeCylinderGeometry({
        ...validAttributes,
        azimuthalCurve: [null] as unknown as CurvedEdgeCylinderAttributes['azimuthalCurve'],
      }),
    ).toThrow('<curvedEdgeCylinder> azimuthalCurve[0]')
    expect(() =>
      createCurvedEdgeCylinderGeometry({
        ...validAttributes,
        azimuthalCurve: [{ amplitude: -1, phase: 0 }],
      }),
    ).toThrow('<curvedEdgeCylinder> azimuthalCurve[0].amplitude')
    expect(() =>
      createCurvedEdgeCylinderGeometry({
        ...validAttributes,
        azimuthalCurve: [{ amplitude: 1, phase: Number.NaN }],
      }),
    ).toThrow('<curvedEdgeCylinder> azimuthalCurve[0].phase')
  })

  it('rejects malformed Taylor curves', () => {
    expect(() =>
      createCurvedEdgeCylinderGeometry({
        ...validAttributes,
        verticalCurve: null as unknown as CurvedEdgeCylinderAttributes['verticalCurve'],
      }),
    ).toThrow('<curvedEdgeCylinder> verticalCurve')
    expect(() =>
      createCurvedEdgeCylinderGeometry({
        ...validAttributes,
        verticalCurve: { origin: Number.NEGATIVE_INFINITY, coefficients: [1] },
      }),
    ).toThrow('<curvedEdgeCylinder> verticalCurve.origin')
    expect(() =>
      createCurvedEdgeCylinderGeometry({ ...validAttributes, verticalCurve: { origin: 0, coefficients: [] } }),
    ).toThrow('<curvedEdgeCylinder> verticalCurve.coefficients')
    expect(() =>
      createCurvedEdgeCylinderGeometry({
        ...validAttributes,
        verticalCurve: { origin: 0, coefficients: [1, Number.NaN] },
      }),
    ).toThrow('<curvedEdgeCylinder> verticalCurve.coefficients[1]')
  })

  it('rejects non-positive or non-finite sampled product radii', () => {
    expect(() =>
      createCurvedEdgeCylinderGeometry({
        ...validAttributes,
        azimuthalCurve: [{ amplitude: 0, phase: 0 }],
      }),
    ).toThrow('<curvedEdgeCylinder> radius must be finite and positive')
    expect(() =>
      createCurvedEdgeCylinderGeometry({
        ...validAttributes,
        azimuthalCurve: [{ amplitude: 1, phase: Math.PI }],
      }),
    ).toThrow('<curvedEdgeCylinder> radius must be finite and positive')
    expect(() =>
      createCurvedEdgeCylinderGeometry({
        ...validAttributes,
        verticalCurve: { origin: Number.MAX_VALUE, coefficients: [1, 0, 1] },
      }),
    ).toThrow('<curvedEdgeCylinder> radius must be finite and positive')
  })
})
