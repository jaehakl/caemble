import { geometries, measurements } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { Material } from '../../../model/core'
import { evaluateCad, h } from '../../../index'
import { createFiberGeometry } from './runtime'
import { sampleFiber } from './sampling'

describe('procedural fiber sampling', () => {
  it('samples a straight centerline with exact endpoints and final-arc-length radius values', () => {
    const sampledS: number[] = []
    const fiber = sampleFiber({
      from: [0, 0, 0],
      to: [0, 0, 10],
      radius: (s) => {
        sampledS.push(s)
        return 2 - s
      },
      pathSegments: 8,
      radialSegments: 6,
    })

    expect(fiber.points).toHaveLength(9)
    expect(fiber.points[0]).toEqual([0, 0, 0])
    expect(fiber.points[8]).toEqual([0, 0, 10])
    expect(fiber.radii).toEqual([2, 1.875, 1.75, 1.625, 1.5, 1.375, 1.25, 1.125, 1])
    expect(sampledS).toEqual([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1])
  })

  it('arc-length reparameterizes a curved base path and preserves its endpoints', () => {
    const fiber = sampleFiber({
      from: [0, 0, 0],
      to: [10, 0, 0],
      basePath: (t) => [10 * t, 4 * Math.sin(Math.PI * t), 0],
      radius: 0.5,
      pathSegments: 16,
      radialSegments: 8,
    })

    expect(fiber.points[0]).toEqual([0, 0, 0])
    expect(fiber.points[16]).toEqual([10, 0, 0])
    expect(fiber.points[8][0]).toBeCloseTo(5)
    expect(fiber.points[8][1]).toBeCloseTo(4)
  })

  it('uses polar Fourier modes in the base Bishop frame', () => {
    const fiber = sampleFiber({
      from: [0, 0, 0],
      to: [0, 0, 10],
      radius: 0.25,
      helix: { turns: 0, phase: 0, radius: 2 },
      fourier: [{ amplitude: 0.5, phase: 0 }],
      envelopePower: 2,
      up: [1, 0, 0],
      pathSegments: 8,
      radialSegments: 6,
    })

    expect(fiber.points[4][0]).toBeCloseTo(2.5, 4)
    expect(fiber.points[4][1]).toBeCloseTo(0, 4)
    expect(fiber.points[4][2]).toBeCloseTo(5, 4)
  })

  it('supports a functional helix radius and opposite handedness for negative turns', () => {
    const create = (turns: number) =>
      sampleFiber({
        from: [0, 0, 0],
        to: [0, 0, 12],
        radius: 0.25,
        helix: { turns, radius: (_u, theta) => 1 + 0.1 * Math.cos(theta) },
        up: [1, 0, 0],
        pathSegments: 16,
        radialSegments: 6,
      })

    const rightHanded = create(1)
    const leftHanded = create(-1)
    expect(rightHanded.points[4][1]).toBeLessThan(0)
    expect(leftHanded.points[4][1]).toBeGreaterThan(0)
  })
})

describe('procedural fiber geometry', () => {
  it('creates a valid capped tapered solid', () => {
    const geometry = createFiberGeometry({
      from: [-5, 0, 0],
      to: [5, 0, 0],
      basePath: (t) => [-5 + 10 * t, 0, 2 * Math.sin(Math.PI * t)],
      radius: (s) => 1 - 0.6 * s,
      helix: { turns: 2, radius: 0.75 },
      fourier: [{ amplitude: 0.2, phase: 0.4 }],
      up: [0, 1, 0],
      pathSegments: 24,
      radialSegments: 8,
    })

    expect(() => geometries.geom3.validate(geometry)).not.toThrow()
    expect(measurements.measureVolume(geometry)).toBeGreaterThan(0)
  })

  it('inherits Material and participates in transforms and same-Material CSG', () => {
    const material = new Material('Fiber', { color: '#7c3aed' })
    const props = {
      from: [0, 0, 0],
      to: [0, 0, 4],
      radius: 0.5,
      pathSegments: 8,
      radialSegments: 6,
    }
    function Fiber() {
      return h('fiber', props)
    }

    const [translated] = evaluateCad(h(Fiber, { id: 'fiber', position: [3, 0, 0], materials: { body: material } }))
    const [combined] = evaluateCad(
      h(
        () =>
          h(
            'union',
            null,
            h(Fiber, { id: 'first', materials: { body: material } }),
            h(Fiber, { id: 'second', position: [2, 0, 0], materials: { body: material } }),
          ),
        { id: 'combined' },
      ),
    )

    const bounds = measurements.measureBoundingBox(translated.geometry)
    expect(bounds[0][0]).toBeCloseTo(2.5)
    expect(bounds[1][0]).toBeCloseTo(3.5)
    expect(translated.surfaces.map((surface) => surface.name)).toEqual(['Start cap', 'Side', 'End cap'])
    expect(combined.material?.name).toBe('Fiber')
    expect(measurements.measureVolume(combined.geometry)).toBeGreaterThan(0)
  })
})

describe('procedural fiber validation', () => {
  const valid = {
    from: [0, 0, 0] as const,
    to: [0, 0, 10] as const,
    radius: 1,
    pathSegments: 8,
    radialSegments: 6,
  }

  it('rejects endpoint mismatches and degenerate paths', () => {
    expect(() => sampleFiber({ ...valid, basePath: (t) => [1, 0, 10 * t] })).toThrow('basePath(0) must match from')
    expect(() => sampleFiber({ ...valid, basePath: (t) => (t < 0.5 ? [0, 0, 0] : [0, 0, 10]) })).toThrow(
      'duplicate or zero-length segment',
    )
    expect(() => sampleFiber({ ...valid, up: [0, 0, 2] })).toThrow('up must not be parallel')
  })

  it('rejects invalid physical and helix radii', () => {
    expect(() => sampleFiber({ ...valid, radius: (s) => (s === 1 ? 0 : 1) })).toThrow(
      'radius must return a positive finite number',
    )
    expect(() => sampleFiber({ ...valid, helix: { turns: 1, radius: () => -1 } })).toThrow(
      'helix.radius returned an invalid value',
    )
  })

  it('rejects invalid Fourier modes and resolutions', () => {
    expect(() => sampleFiber({ ...valid, fourier: [{ amplitude: -1, phase: 0 }] })).toThrow(
      'amplitude must be a finite non-negative number',
    )
    expect(() => sampleFiber({ ...valid, pathSegments: 7 })).toThrow('pathSegments must be an integer from 8 to 2048')
    expect(() => sampleFiber({ ...valid, radialSegments: 65 })).toThrow(
      'radialSegments must be an integer from 3 to 64',
    )
  })
})
