import { booleans, geometries, measurements, primitives } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { Fragment, evaluateCad, h } from '../../../index'
import { Material } from '../../../model/core'
import { createShellGeometries } from './runtime'

function expectBounds(geometry: unknown, expected: readonly [readonly number[], readonly number[]]) {
  const bounds = measurements.measureBoundingBox(geometry)
  bounds.forEach((corner, cornerIndex) => {
    corner.forEach((coordinate, axis) => {
      expect(coordinate).toBeCloseTo(expected[cornerIndex][axis], 6)
    })
  })
}

describe('shell geometry', () => {
  it('creates outward box layers from zero through each positive offset', () => {
    const layers = createShellGeometries(primitives.cuboid({ size: [10, 10, 10] }), [1, 3])

    expect(layers).toHaveLength(2)
    layers.forEach((layer) => expect(() => geometries.geom3.validate(layer)).not.toThrow())
    expectBounds(layers[0], [
      [-6, -6, -6],
      [6, 6, 6],
    ])
    expectBounds(layers[1], [
      [-8, -8, -8],
      [8, 8, 8],
    ])
    expect(measurements.measureVolume(layers[0])).toBeCloseTo(728, 4)
    expect(measurements.measureVolume(layers[1])).toBeCloseTo(2368, 4)
  })

  it('creates inward box layers in inner-to-outer order without returning the core', () => {
    const layers = createShellGeometries(primitives.cuboid({ size: [10, 10, 10] }), [-3, -1])

    expect(layers).toHaveLength(2)
    layers.forEach((layer) => expect(() => geometries.geom3.validate(layer)).not.toThrow())
    expectBounds(layers[0], [
      [-4, -4, -4],
      [4, 4, 4],
    ])
    expectBounds(layers[1], [
      [-5, -5, -5],
      [5, 5, 5],
    ])
    expect(measurements.measureVolume(layers[0])).toBeCloseTo(448, 4)
    expect(measurements.measureVolume(layers[1])).toBeCloseTo(488, 4)
    expect(measurements.measureVolume(layers[0])).not.toBeCloseTo(512, 4)
  })

  it('inserts zero between mixed signed offsets and returns every adjacent layer', () => {
    const layers = createShellGeometries(primitives.cuboid({ size: [10, 10, 10] }), [-2, -0.5, 1, 3])

    expect(layers).toHaveLength(4)
    layers.forEach((layer) => expect(() => geometries.geom3.validate(layer)).not.toThrow())
    expectBounds(layers[0], [
      [-4.5, -4.5, -4.5],
      [4.5, 4.5, 4.5],
    ])
    expectBounds(layers[1], [
      [-5, -5, -5],
      [5, 5, 5],
    ])
    expectBounds(layers[2], [
      [-6, -6, -6],
      [6, 6, 6],
    ])
    expectBounds(layers[3], [
      [-8, -8, -8],
      [8, 8, 8],
    ])
    expect(layers.map((layer) => measurements.measureVolume(layer))).toEqual([
      expect.closeTo(513, 4),
      expect.closeTo(271, 4),
      expect.closeTo(728, 4),
      expect.closeTo(2368, 4),
    ])
  })

  it('creates valid inward and outward multilayers on a torus', () => {
    const source = primitives.torus({
      innerRadius: 1,
      outerRadius: 4,
      innerSegments: 16,
      outerSegments: 24,
    })
    const layers = createShellGeometries(source, [-0.5, 0.5, 1])

    expect(layers).toHaveLength(3)
    layers.forEach((layer) => expect(() => geometries.geom3.validate(layer)).not.toThrow())
    const volumes = layers.map((layer) => measurements.measureVolume(layer))
    expect(volumes[0]).toBeGreaterThan(0)
    expect(volumes[1]).toBeGreaterThan(volumes[0])
    expect(volumes[2]).toBeGreaterThan(volumes[1])
  })

  it('normalizes T-junctions in a concave boolean solid before offsetting it', () => {
    const source = booleans.subtract(
      primitives.cuboid({ size: [10, 10, 10] }),
      primitives.cuboid({ size: [6, 6, 12], center: [3, 3, 0] }),
    )
    const layers = createShellGeometries(source, [-0.25, 0.5])

    expect(layers).toHaveLength(2)
    layers.forEach((layer) => {
      expect(() => geometries.geom3.validate(layer)).not.toThrow()
      expect(measurements.measureVolume(layer)).toBeGreaterThan(0)
    })
  })

  it('rejects signed offsets that collapse or invert a torus boundary', () => {
    const source = primitives.torus({
      innerRadius: 1,
      outerRadius: 4,
      innerSegments: 12,
      outerSegments: 16,
    })

    expect(() => createShellGeometries(source, [3])).toThrow(
      '<shell> offset 3 creates a degenerate or inverted surface',
    )
    expect(() => createShellGeometries(source, [-1.5])).toThrow(
      '<shell> offset -1.5 creates a degenerate or inverted surface',
    )
  })

  it('rejects invalid offset arrays and non-closed geometry', () => {
    const source = primitives.cuboid({ size: [2, 2, 2] })

    ;[undefined, null, 1, []].forEach((offsets) => {
      expect(() => createShellGeometries(source, offsets)).toThrow('<shell> offsets must be a non-empty array')
    })
    ;[[0], [Number.NaN], [Number.POSITIVE_INFINITY], ['1']].forEach((offsets) => {
      expect(() => createShellGeometries(source, offsets)).toThrow('must be a finite non-zero number')
    })
    ;[
      [1, 1],
      [2, 1],
      [-1, -2],
    ].forEach((offsets) => {
      expect(() => createShellGeometries(source, offsets)).toThrow(
        '<shell> offsets must be in strictly increasing order',
      )
    })

    const openGeometry = geometries.geom3.create([
      geometries.poly3.create([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ]),
    ])
    expect(() => createShellGeometries(openGeometry, [1])).toThrow(
      '<shell> child Geometry must be a valid closed geom3 solid',
    )
  })
})

describe('shell evaluation', () => {
  const innerMaterial = new Material('Inner shell', { color: '#0ea5e9' })
  const outerMaterial = new Material('Outer shell', { color: '#f97316' })

  it('maps inherited Materials inner-to-outer and applies transforms in the correct order', () => {
    const childMaterial = new Material('Ignored child', { color: '#22c55e' })

    function Child() {
      return h('box', { size: [4, 6, 8], pos: [1, 0, 0] })
    }

    const parts = evaluateCad(
      h(
        () => h('shell', { offsets: [-1, 1], pos: [10, 0, 0] }, h(Child, { id: 'child', materials: [childMaterial] })),
        { id: 'shell', materials: [innerMaterial, outerMaterial] },
      ),
    )

    expect(parts.map((part) => part.material?.name)).toEqual(['Inner shell', 'Outer shell'])
    expect(parts.map((part) => part.material?.variables.color)).toEqual(['#0ea5e9', '#f97316'])
    expect(parts.map((part) => part.id)).toEqual(['shell.$part-1', 'shell.$part-2'])
    expectBounds(parts[0].geometry, [
      [9, -3, -4],
      [13, 3, 4],
    ])
    expectBounds(parts[1].geometry, [
      [8, -4, -5],
      [14, 4, 5],
    ])
  })

  it('allows the same Material instance on multiple layers', () => {
    const shared = new Material('Shared shell', { color: '#a855f7' })
    const parts = evaluateCad(
      h(() => h('shell', { offsets: [-1, 1] }, h('box', { size: [4, 4, 4] })), {
        id: 'shell',
        materials: [shared, shared],
      }),
    )

    expect(parts).toHaveLength(2)
    expect(parts.map((part) => part.material?.name)).toEqual(['Shared shell', 'Shared shell'])
  })

  it('derives sharp box boundaries and smooth sphere boundaries', () => {
    const box = evaluateCad(
      h(() => h('shell', { offsets: [1] }, h('box', { size: [4, 4, 4] })), {
        id: 'box-shell',
        materials: [innerMaterial],
      }),
    )[0]
    const sphere = evaluateCad(
      h(() => h('shell', { offsets: [1] }, h('sphere', { radius: 3, segments: 16 })), {
        id: 'sphere-shell',
        materials: [innerMaterial],
      }),
    )[0]

    expect(box.surfaces).toHaveLength(12)
    expect(sphere.surfaces).toHaveLength(2)
  })

  it('preserves distinct Material instances sharing a symbol for generated layers', () => {
    const first = new Material('Duplicate shell', { color: '#2563eb' })
    const second = new Material('Duplicate shell', { color: '#dc2626' })

    const parts = evaluateCad(
      h(() => h('shell', { offsets: [-1, 1] }, h('box', { size: [4, 4, 4] })), {
        id: 'shell',
        materials: [first, second],
      }),
    )

    expect(parts.map((part) => part.material?.name)).toEqual(['Duplicate shell', 'Duplicate shell'])
    expect(parts.map((part) => part.material?.variables.color)).toEqual(['#2563eb', '#dc2626'])
    expect(parts[0].material).not.toBe(parts[1].material)
  })

  it('allows no Materials or requires exactly one inherited Material for every offset', () => {
    const shell = h('shell', { offsets: [-1, 1] }, h('box', { size: [4, 4, 4] }))

    const parts = evaluateCad(h(() => shell, { id: 'shell' }))
    expect(parts).toHaveLength(2)
    expect(parts.every((part) => part.material === undefined)).toBe(true)
    expect(() => evaluateCad(h(() => shell, { id: 'shell', materials: [innerMaterial] }))).toThrow(
      'requires exactly one inherited Material per offset',
    )
    expect(() =>
      evaluateCad(h(() => shell, { id: 'shell', materials: [innerMaterial, outerMaterial, innerMaterial] })),
    ).toThrow('requires exactly one inherited Material per offset')
  })

  it('participates in same-Material CSG with multiple layers', () => {
    const shared = new Material('Unified shell', { color: '#0284c7' })
    const [combined] = evaluateCad(
      h(
        () =>
          h(
            'union',
            null,
            h(() => h('box', { size: [10, 10, 10] }), { id: 'base', materials: [shared] }),
            h(() => h('shell', { offsets: [1, 2] }, h('box', { size: [10, 10, 10] })), {
              id: 'shell',
              materials: [shared, shared],
            }),
          ),
        { id: 'result' },
      ),
    )

    expect(() => geometries.geom3.validate(combined.geometry)).not.toThrow()
    expect(measurements.measureVolume(combined.geometry)).toBeCloseTo(2744, 4)
    expect(combined.material?.name).toBe('Unified shell')
  })

  it('requires one direct child that evaluates to one valid solid', () => {
    expect(() =>
      evaluateCad(h(() => h('shell', { offsets: [1] }), { id: 'shell', materials: [outerMaterial] })),
    ).toThrow('<shell> requires exactly one direct child Geometry')

    expect(() =>
      evaluateCad(
        h(
          () =>
            h('shell', { offsets: [1] }, h('box', { size: [2, 2, 2] }), h('box', { size: [2, 2, 2], pos: [3, 0, 0] })),
          { id: 'shell', materials: [outerMaterial] },
        ),
      ),
    ).toThrow('<shell> requires exactly one direct child Geometry')

    expect(() =>
      evaluateCad(
        h(
          () =>
            h(
              'shell',
              { offsets: [1] },
              h(Fragment, null, h('box', { size: [2, 2, 2] }), h('box', { size: [2, 2, 2], pos: [3, 0, 0] })),
            ),
          { id: 'shell', materials: [outerMaterial] },
        ),
      ),
    ).toThrow('<shell> child Geometry must evaluate to exactly one solid')
  })
})
