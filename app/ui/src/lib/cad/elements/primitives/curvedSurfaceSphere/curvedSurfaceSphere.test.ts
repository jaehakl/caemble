import { geometries, measurements } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { Material } from '../../../model/core'
import { evaluateCad, h } from '../../../index'
import type { CurvedSurfaceSphereAttributes } from './definition'
import { createCurvedSurfaceSphereGeometry } from './runtime'

const validAttributes = {
  azimuthalCurve: [{ amplitude: 1, phase: 0 }],
  polarCurve: [{ amplitude: 1, phase: 0 }],
  azimuthalSegments: 8,
  polarSegments: 4,
} satisfies CurvedSurfaceSphereAttributes

describe('curved surface sphere geometry', () => {
  it('creates a valid closed constant-radius solid and applies mode-zero phases', () => {
    const geometry = createCurvedSurfaceSphereGeometry({
      azimuthalCurve: [{ amplitude: 4, phase: Math.PI / 3 }],
      polarCurve: [{ amplitude: 6, phase: Math.PI / 3 }],
      azimuthalSegments: 8,
      polarSegments: 4,
    })

    expect(() => geometries.geom3.validate(geometry)).not.toThrow()
    const bounds = measurements.measureBoundingBox(geometry)
    bounds[0].forEach((coordinate) => expect(coordinate).toBeCloseTo(-6))
    bounds[1].forEach((coordinate) => expect(coordinate).toBeCloseTo(6))
    expect(measurements.measureVolume(geometry)).toBeGreaterThan(600)
    expect(measurements.measureVolume(geometry)).toBeLessThan((4 / 3) * Math.PI * 6 ** 3)
  })

  it('samples azimuthal and polar modes and uses theta zero at both poles', () => {
    const geometry = createCurvedSurfaceSphereGeometry({
      azimuthalCurve: [
        { amplitude: 3, phase: 0 },
        { amplitude: 1, phase: 0 },
      ],
      polarCurve: [
        { amplitude: 2, phase: 0 },
        { amplitude: 1, phase: 0 },
      ],
      azimuthalSegments: 4,
      polarSegments: 2,
    })
    const points = geometries.geom3.toPoints(geometry).flat()

    expect(points.some(([x, y, z]) => Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 && Math.abs(z - 12) < 1e-9)).toBe(true)
    expect(points.some(([x, y, z]) => Math.abs(x - 8) < 1e-9 && Math.abs(y) < 1e-9 && Math.abs(z) < 1e-9)).toBe(true)
    expect(points.some(([x, y, z]) => Math.abs(x) < 1e-9 && Math.abs(y - 6) < 1e-9 && Math.abs(z) < 1e-9)).toBe(true)
    expect(points.some(([x, y, z]) => Math.abs(x + 4) < 1e-9 && Math.abs(y) < 1e-9 && Math.abs(z) < 1e-9)).toBe(true)
    expect(points.some(([x, y, z]) => Math.abs(x) < 1e-9 && Math.abs(y + 6) < 1e-9 && Math.abs(z) < 1e-9)).toBe(true)
    expect(points.some(([x, y, z]) => Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 && Math.abs(z + 4) < 1e-9)).toBe(true)
  })

  it('inherits Material and participates in transforms and same-Material CSG', () => {
    const material = new Material('Curved Sphere', { color: '#be123c' })
    function CurvedSphere() {
      return h('curvedSurfaceSphere', validAttributes)
    }

    const [translated] = evaluateCad(
      h(CurvedSphere, { id: 'sphere', position: [3, 0, 0], materials: { body: material } }),
    )
    const [combined] = evaluateCad(
      h(
        () =>
          h(
            'union',
            null,
            h(CurvedSphere, { id: 'first', materials: { body: material } }),
            h(CurvedSphere, { id: 'second', position: [1, 0, 0], materials: { body: material } }),
          ),
        { id: 'combined' },
      ),
    )

    const bounds = measurements.measureBoundingBox(translated.geometry)
    expect(bounds[0][0]).toBeCloseTo(2)
    expect(bounds[1][0]).toBeCloseTo(4)
    expect(translated.material?.name).toBe('Curved Sphere')
    expect(translated.surfaces.map((surface) => surface.name)).toEqual(['Outer'])
    expect(combined.material?.name).toBe('Curved Sphere')
    expect(measurements.measureVolume(combined.geometry)).toBeGreaterThan(0)
  })
})

describe('curved surface sphere validation', () => {
  it('rejects invalid segment counts', () => {
    expect(() => createCurvedSurfaceSphereGeometry({ ...validAttributes, azimuthalSegments: 3 })).toThrow(
      '<curvedSurfaceSphere> azimuthalSegments',
    )
    expect(() => createCurvedSurfaceSphereGeometry({ ...validAttributes, azimuthalSegments: 4.5 })).toThrow(
      '<curvedSurfaceSphere> azimuthalSegments',
    )
    expect(() => createCurvedSurfaceSphereGeometry({ ...validAttributes, polarSegments: 1 })).toThrow(
      '<curvedSurfaceSphere> polarSegments',
    )
    expect(() => createCurvedSurfaceSphereGeometry({ ...validAttributes, polarSegments: Number.NaN })).toThrow(
      '<curvedSurfaceSphere> polarSegments',
    )
  })

  it('rejects empty or malformed Fourier curves', () => {
    expect(() => createCurvedSurfaceSphereGeometry({ ...validAttributes, azimuthalCurve: [] })).toThrow(
      '<curvedSurfaceSphere> azimuthalCurve',
    )
    expect(() =>
      createCurvedSurfaceSphereGeometry({
        ...validAttributes,
        polarCurve: null as unknown as CurvedSurfaceSphereAttributes['polarCurve'],
      }),
    ).toThrow('<curvedSurfaceSphere> polarCurve')
    expect(() =>
      createCurvedSurfaceSphereGeometry({
        ...validAttributes,
        polarCurve: [null] as unknown as CurvedSurfaceSphereAttributes['polarCurve'],
      }),
    ).toThrow('<curvedSurfaceSphere> polarCurve[0]')
    expect(() =>
      createCurvedSurfaceSphereGeometry({
        ...validAttributes,
        azimuthalCurve: [{ amplitude: -1, phase: 0 }],
      }),
    ).toThrow('<curvedSurfaceSphere> azimuthalCurve[0].amplitude')
    expect(() =>
      createCurvedSurfaceSphereGeometry({
        ...validAttributes,
        polarCurve: [{ amplitude: 1, phase: Number.POSITIVE_INFINITY }],
      }),
    ).toThrow('<curvedSurfaceSphere> polarCurve[0].phase')
  })

  it('rejects non-positive or non-finite sampled product radii', () => {
    expect(() =>
      createCurvedSurfaceSphereGeometry({
        ...validAttributes,
        azimuthalCurve: [{ amplitude: 0, phase: 0 }],
      }),
    ).toThrow('<curvedSurfaceSphere> radius must be finite and positive')
    expect(() =>
      createCurvedSurfaceSphereGeometry({
        ...validAttributes,
        polarCurve: [{ amplitude: 1, phase: Math.PI }],
      }),
    ).toThrow('<curvedSurfaceSphere> radius must be finite and positive')
    expect(() =>
      createCurvedSurfaceSphereGeometry({
        ...validAttributes,
        azimuthalCurve: [{ amplitude: Number.MAX_VALUE, phase: 0 }],
        polarCurve: [{ amplitude: Number.MAX_VALUE, phase: 0 }],
      }),
    ).toThrow('<curvedSurfaceSphere> radius must be finite and positive')
  })
})
