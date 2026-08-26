import { geometries, measurements } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { CadModelError, Material } from '../../model/core'
import { evaluateCad, h } from '../../index'

const material = new Material('Primitive', { color: '#2563eb' })

function evaluate(tag: string, props: Record<string, unknown>) {
  return evaluateCad(h(() => h(tag, props), { id: 'primitive', materials: { body: material } }))[0]
}

describe('CAD primitives', () => {
  it('evaluates every primitive with canonical defaults and treats undefined as omission', () => {
    for (const tag of ['box', 'cylinder', 'sphere', 'curvedEdgeCylinder', 'curvedSurfaceSphere', 'fiber']) {
      const omitted = evaluate(tag, {}).geometry
      const undefinedOverride = evaluate(tag, { radius: undefined, size: undefined }).geometry
      expect(geometries.geom3.isA(omitted)).toBe(true)
      expect(measurements.measureVolume(omitted)).toBeGreaterThan(0)
      expect(measurements.measureBoundingBox(undefinedOverride)).toEqual(measurements.measureBoundingBox(omitted))
    }
  })

  it('creates valid box, cylinder, and sphere geom3 solids', () => {
    expect(geometries.geom3.isA(evaluate('box', { size: [1, 2, 3] }).geometry)).toBe(true)
    expect(geometries.geom3.isA(evaluate('cylinder', { radius: 1, height: 2, segments: 8 }).geometry)).toBe(true)
    expect(geometries.geom3.isA(evaluate('sphere', { radius: 1, segments: 8 }).geometry)).toBe(true)
  })

  it('applies radius and radius_2 to the local -Z and +Z ends', () => {
    const uniformGeometry = evaluate('cylinder', { radius: 2, height: 4, segments: 8 }).geometry
    const uniformVertices = geometries.geom3
      .toPolygons(uniformGeometry as Parameters<typeof geometries.geom3.toPolygons>[0])
      .flatMap((polygon) => polygon.vertices)
    const uniformStartRadii = uniformVertices
      .filter((vertex) => vertex[2] === -2)
      .map((vertex) => Math.hypot(vertex[0], vertex[1]))
    const uniformEndRadii = uniformVertices
      .filter((vertex) => vertex[2] === 2)
      .map((vertex) => Math.hypot(vertex[0], vertex[1]))

    expect(Math.max(...uniformStartRadii)).toBeCloseTo(2)
    expect(Math.max(...uniformEndRadii)).toBeCloseTo(2)

    const geometry = evaluate('cylinder', { radius: 2, radius_2: 1, height: 4, segments: 8 }).geometry
    const polygons = geometries.geom3.toPolygons(geometry as Parameters<typeof geometries.geom3.toPolygons>[0])
    const vertices = polygons.flatMap((polygon) => polygon.vertices)
    const startRadii = vertices.filter((vertex) => vertex[2] === -2).map((vertex) => Math.hypot(vertex[0], vertex[1]))
    const endRadii = vertices.filter((vertex) => vertex[2] === 2).map((vertex) => Math.hypot(vertex[0], vertex[1]))

    expect(Math.max(...startRadii)).toBeCloseTo(2)
    expect(Math.max(...endRadii)).toBeCloseTo(1)
  })

  it('creates a valid cone when exactly one end radius is zero', () => {
    const geometry = evaluate('cylinder', { radius: 0, radius_2: 2, height: 4, segments: 16 }).geometry
    const cone = geometry as Parameters<typeof geometries.geom3.validate>[0]

    expect(() => geometries.geom3.validate(cone)).not.toThrow()
    expect(measurements.measureVolume(cone)).toBeGreaterThan(0)
  })

  it('assigns deterministic numeric surface slots to basic primitives', () => {
    const box = evaluate('box', { size: [1, 2, 3], rotation: [0, 0.4, 0] })
    const cylinder = evaluate('cylinder', { radius: 2, radius_2: 1, height: 4, segments: 8 })
    const startTip = evaluate('cylinder', { radius: 0, radius_2: 2, height: 4, segments: 8 })
    const endTip = evaluate('cylinder', { radius: 2, radius_2: 0, height: 4, segments: 8 })
    const sphere = evaluate('sphere', { radius: 1, segments: 8 })

    expect(box.id).toBe('primitive.box')
    expect(box.surfaces.map((surface) => surface.surfaceIndex)).toEqual([0, 1, 2, 3, 4, 5])
    expect(box.surfaces.map((surface) => surface.id)).toEqual([
      'primitive.box/surface/0',
      'primitive.box/surface/1',
      'primitive.box/surface/2',
      'primitive.box/surface/3',
      'primitive.box/surface/4',
      'primitive.box/surface/5',
    ])
    expect(cylinder.surfaces.map((surface) => surface.surfaceIndex)).toEqual([0, 1, 2])
    expect(startTip.surfaces.map((surface) => surface.surfaceIndex)).toEqual([1, 2])
    expect(endTip.surfaces.map((surface) => surface.surfaceIndex)).toEqual([0, 1])
    expect(sphere.surfaces.map((surface) => surface.surfaceIndex)).toEqual([0])

    const boxPolygonCount = geometries.geom3.toPolygons(
      box.geometry as Parameters<typeof geometries.geom3.toPolygons>[0],
    ).length
    expect(box.surfaces.flatMap((surface) => [...surface.polygonIndices]).sort((a, b) => a - b)).toEqual(
      Array.from({ length: boxPolygonCount }, (_value, index) => index),
    )
  })

  it('validates box size before invoking JSCAD', () => {
    for (const size of [null, [1, 2], [1, 2, 0], [1, Number.NaN, 3]]) {
      expect(() => evaluate('box', { size })).toThrowError(CadModelError)
      expect(() => evaluate('box', { size })).toThrow('<box> size')
    }
  })

  it('validates cylinder radius, height, and segments with prop paths', () => {
    expect(() => evaluate('cylinder', { radius: -1, height: 2 })).toThrow('<cylinder> radius')
    expect(() => evaluate('cylinder', { radius: 1, radius_2: -1, height: 2 })).toThrow('<cylinder> radius_2')
    expect(() => evaluate('cylinder', { radius: 1, radius_2: Number.NaN, height: 2 })).toThrow('<cylinder> radius_2')
    expect(() => evaluate('cylinder', { radius: 0, radius_2: 0, height: 2 })).toThrow('cannot both be zero')
    expect(() => evaluate('cylinder', { radius: 1, height: Number.POSITIVE_INFINITY })).toThrow('<cylinder> height')
    expect(() => evaluate('cylinder', { radius: 1, height: 2, segments: 3 })).toThrow('<cylinder> segments')
    expect(() => evaluate('cylinder', { radius: 1, height: 2, segments: 4.5 })).toThrow('<cylinder> segments')
  })

  it('validates sphere radius and segments with prop paths', () => {
    expect(() => evaluate('sphere', { radius: -1 })).toThrow('<sphere> radius')
    expect(() => evaluate('sphere', { radius: 1, segments: Number.MAX_SAFE_INTEGER + 1 })).toThrow('<sphere> segments')
  })
})
