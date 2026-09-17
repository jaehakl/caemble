// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  evaluateContinuousSurface as evaluate,
  normalizeContinuousPrimitive as normalize,
  tessellateContinuousPrimitive as mesh,
  scaleContinuousParameters,
  transformSurface,
  type ContinuousPrimitive,
  type IndexedSurface,
} from './continuous'
import { evaluateFiber, normalizeFiber, tessellateFiber } from './fiber'
import { canonicalGeometryScene } from '../evaluation/canonical'
import { evaluateCadScene } from '../evaluation/evaluator'
import { h } from '../evaluation/jsx'
import { renderCanonicalGeometryScene } from '../execution/manifoldRender'

const fixtures = JSON.parse(
  readFileSync(new URL('../../../../../slaves/cae/tests/fixtures/continuous-geometry.json', import.meta.url), 'utf8'),
) as { kind: ContinuousPrimitive; parameters: Record<string, number>; surfaces: number[] }[]
function signedVolume(value: IndexedSurface) {
  return value.triangles.reduce((sum, [i, j, k]) => {
    const a = value.points[i],
      b = value.points[j],
      c = value.points[k]
    return (
      sum +
      (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    )
  }, 0)
}

describe('continuous primitive contracts', () => {
  for (const [index, fixture] of fixtures.entries())
    it(`${fixture.kind} ${index}: closed oriented mesh, continuous derivatives and units`, () => {
      const { kind, surfaces } = fixture,
        p = normalize(kind, fixture.parameters),
        value = mesh(kind, p, { radialSegments: 24, meridianSegments: 12 })
      const edges = new Map<string, number>()
      for (const face of value.triangles)
        for (let i = 0; i < 3; i++) {
          const key = [face[i], face[(i + 1) % 3]].sort((a, b) => a - b).join(',')
          edges.set(key, (edges.get(key) ?? 0) + 1)
        }
      expect([...edges.values()].every((count) => count === 2)).toBe(true)
      expect([...new Set(value.surfaceIndices)].sort()).toEqual(surfaces)
      expect(signedVolume(value)).toBeGreaterThan(0)
      for (const surface of surfaces) {
        const at = evaluate(kind, p, surface, 0.37, 0.43),
          delta = 1e-6
        const next = evaluate(kind, p, surface, 0.37 + delta, 0.43),
          prev = evaluate(kind, p, surface, 0.37 - delta, 0.43)
        for (let i = 0; i < 3; i++)
          expect((next.position[i] - prev.position[i]) / (2 * delta)).toBeCloseTo(at.derivativeU[i], 7)
        expect(at.normal.reduce((s, x, i) => s + x * at.derivativeU[i], 0)).toBeCloseTo(0, 10)
        const converted = evaluate(kind, scaleContinuousParameters(kind, p, 0.001), surface, 0.37, 0.43)
        at.position.forEach((x, i) => expect(converted.position[i]).toBeCloseTo(x * 0.001, 12))
        const transformed = transformSurface(at, [-2, 0, 0, 4, 0, 3, 0, 5, 0, 0, 0.5, 6, 0, 0, 0, 1])
        expect(transformed.normal.reduce((s, x, i) => s + x * transformed.derivativeU[i], 0)).toBeCloseTo(0, 10)
        expect(transformed.normal.reduce((s, x, i) => s + x * transformed.derivativeV[i], 0)).toBeCloseTo(0, 10)
      }
    })

  it('uses focal definitions and exact maximum radius without recentering', () => {
    for (const { kind, parameters: p } of fixtures.slice(0, 4))
      for (const u of [0, 0.2, 0.7, 1]) {
        const at = evaluate(kind, p, kind === 'ellipsoid' ? 0 : 1, u, 0.23).position
        if (kind === 'ellipsoid' || kind === 'hyperboloid') {
          const near = Math.hypot(at[0], at[1], at[2] - p.focalDistance),
            far = Math.hypot(at[0], at[1], at[2] + p.focalDistance)
          expect(kind === 'ellipsoid' ? near + far : far - near).toBeCloseTo(2 * p.axialRadius, 12)
        } else expect(Math.hypot(at[0], at[1], at[2] - p.focalLength)).toBeCloseTo(at[2] + p.focalLength, 12)
        if (kind === 'hyperboloid' || kind === 'paraboloid') {
          const rim = evaluate(kind, p, 1, 1, 0.23).position,
            cap = evaluate(kind, p, 2, 1, 0.23).position
          expect(rim).toEqual(cap)
          expect(Math.hypot(rim[0], rim[1])).toBeCloseTo(p.radius, 12)
          expect(evaluate(kind, p, 1, 0, 0).position[2]).toBe(kind === 'hyperboloid' ? p.axialRadius : 0)
        }
      }
  })

  it('rejects removed inputs and invalid full-aperture aspheres', () => {
    expect(() => normalize('paraboloid', { focalLength: 1, radius: 2, zMax: 3 })).toThrow('zMax')
    expect(() => normalize('hyperboloid', { focalDistance: 2, axialRadius: 2, radius: 1 })).toThrow()
    expect(() =>
      normalize('asphericCylinder', {
        radius: 2,
        centerThickness: 1,
        top: { curvature: 1, conic: 0, coefficients: [] },
      }),
    ).toThrow('domain')
    // Positive at both ends, negative in the middle: vertex/rim checks are insufficient.
    expect(() =>
      normalize('asphericCylinder', {
        radius: 1,
        centerThickness: 0.1,
        top: {
          curvature: 0,
          conic: 0,
          coefficients: [
            { order: 4, value: -4 },
            { order: 6, value: 4 },
          ],
        },
      }),
    ).toThrow('intersect')
    expect(() => evaluateCadScene(h('shell', { offsets: { body: 1 } }, h('sphere', {})))).toThrow()
    expect(() => normalizeFiber({ basePath: () => [0, 0, 0] })).toThrow('removed')
  })

  it('preserves semantic surfaces through Boolean, mirror transform and Manifold rendering', async () => {
    const runtime = evaluateCadScene(
      h(
        'subtract',
        { id: 'bowl', scale: [-1, 2, 1] },
        h('paraboloid', {
          id: 'outer',
          focalLength: 2,
          radius: 4,
          tessellation: { radialSegments: 24, meridianSegments: 8 },
        }),
        h('box', { id: 'cut', size: [2, 2, 6], position: [4, 0, 0] }),
      ),
      { surfaceGroup: { curve: ['bowl.outer/surface/1'], absent: ['bowl.outer/surface/0'] } },
    )
    const canonical = await canonicalGeometryScene(runtime)
    expect(canonical.surfaceGroups[0].missingMemberIds).toEqual([])
    expect(canonical.surfaceGroups[1].missingMemberIds).toEqual(['bowl.outer/surface/0'])
    const rendered = await renderCanonicalGeometryScene(canonical, runtime)
    expect(rendered.parts[0].surfaces.some((surface) => surface.id === 'bowl.outer/surface/1')).toBe(true)
    expect(rendered.parts[0].surfaces.some((surface) => surface.id === 'bowl.outer/surface/0')).toBe(false)
  })
})

describe('continuous Fiber', () => {
  it('matches cylinder/frustum volume and preserves taper creases', () => {
    const fiber = normalizeFiber({
      from: [0, 0, -2],
      to: [0, 0, 2],
      radiusProfile: [
        { s: 0, radius: 2 },
        { s: 2, radius: 1 },
        { s: 4, radius: 1 },
      ],
    })
    const value = tessellateFiber(fiber, { pathSegments: 3, radialSegments: 64 })
    expect(signedVolume(value)).toBeCloseTo(
      ((((Math.PI * 2) / 3) * (4 + 2 + 1) + Math.PI * 2) * Math.sin((2 * Math.PI) / 64)) / ((2 * Math.PI) / 64),
      9,
    )
    expect(evaluateFiber(fiber, 2, 0, 'left').outward).not.toEqual(evaluateFiber(fiber, 2, 0, 'right').outward)
    expect(value.points.some((p) => p[2] === 0)).toBe(true)
    const straight = normalizeFiber({ from: [0, 0, -2], to: [0, 0, 2], radius: 1 })
    expect(signedVolume(tessellateFiber(straight, { radialSegments: 64, pathSegments: 2 }))).toBeCloseTo(
      (4 * Math.PI * Math.sin((2 * Math.PI) / 64)) / ((2 * Math.PI) / 64),
      10,
    )
  })
  it('transports a frame over signed connected arcs and rejects closed self-intersections', () => {
    const fiber = normalizeFiber({
      path: {
        start: [0, 0, 0],
        direction: [0, 0, 1],
        segments: [
          { kind: 'line', length: 2 },
          { kind: 'arc', radius: 3, angle: Math.PI / 2, normal: [0, 1, 0] },
        ],
      },
      radius: 0.2,
    })
    const end = evaluateFiber(fiber, 2 + (3 * Math.PI) / 2)
    expect(end.center[0]).toBeCloseTo(3, 12)
    expect(end.center[2]).toBeCloseTo(5, 12)
    expect(evaluateFiber(fiber, 2, 0, 'left').normal).toEqual(evaluateFiber(fiber, 2, 0, 'right').normal)
    expect(() =>
      normalizeFiber({
        path: {
          start: [0, 0, 0],
          direction: [0, 0, 1],
          segments: Array.from({ length: 4 }, () => ({
            kind: 'arc',
            radius: 3,
            angle: Math.PI / 2,
            normal: [0, 1, 0],
          })),
        },
        radius: 0.2,
      }),
    ).toThrow('self-intersection')
  })
})
