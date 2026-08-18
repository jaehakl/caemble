import { measurements } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { Material } from '../model/core'
import { Fragment, evaluateCad, h } from '../index'

const size = [2, 2, 2]

function Box() {
  return h('box', { size })
}

describe('CAD evaluator', () => {
  it('passes normalized frozen transforms to Geometry with identity defaults', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const received: Record<string, unknown>[] = []

    function Positioned(input: Record<string, unknown>) {
      received.push(input)
      return h('box', { size })
    }

    const [part] = evaluateCad(h(Positioned, { id: 'positioned', materials: { body: core } }))
    evaluateCad(
      h(Positioned, {
        id: 'positioned',
        position: [2, 3, 4],
        rotation: [0, 0, Math.PI / 2],
        scale: [2, 3, 4],
        materials: { body: core },
      }),
    )

    expect(received[0]).toMatchObject({ position: [0, 0, 0], rotation: undefined, scale: [1, 1, 1] })
    expect(received[1]).toMatchObject({
      position: [2, 3, 4],
      rotation: [0, 0, Math.PI / 2],
      scale: [2, 3, 4],
    })
    expect(Object.isFrozen(received[0].position)).toBe(true)
    expect(Object.isFrozen(received[0].scale)).toBe(true)
    expect(Object.isFrozen(received[1].rotation)).toBe(true)
    expect(measurements.measureBoundingBox(part.geometry)).toEqual([
      [-1, -1, -1],
      [1, 1, 1],
    ])
  })

  it('accumulates primitive and nested Geometry positions relative to their parents', () => {
    const core = new Material('Core', { color: '#2563eb' })

    function Child() {
      return h('box', { size, position: [1, 1, 1] })
    }

    function Parent() {
      return h(Child, { id: 'child', position: [4, 5, 6] })
    }

    const [part] = evaluateCad(h(Parent, { id: 'parent', position: [1, 2, 3], materials: { body: core } }))

    expect(measurements.measureBoundingBox(part.geometry)).toEqual([
      [5, 7, 9],
      [7, 9, 11],
    ])
  })

  it('preserves custom props used to derive child-local transforms before applying the parent once', () => {
    const core = new Material('Core', { color: '#2563eb' })
    let parentInput: Record<string, unknown> | undefined
    let childInput: Record<string, unknown> | undefined

    function Child(input: Record<string, unknown>) {
      childInput = input
      return h('box', { size: input.size })
    }

    function Parent(input: Record<string, unknown>) {
      parentInput = input
      const position = input.position as readonly number[]
      const rotation = input.rotation as readonly number[]
      const scale = input.scale as readonly number[]
      const gap = input.gap as number
      const profileScale = input.profileScale as number

      return h(Child, {
        id: 'child',
        size: [2 * scale[0], 2, 2],
        position: [gap + position[0] * 0.1, 0, 0],
        rotation: [rotation[0] / 2, rotation[1] / 2, rotation[2] / 2],
        scale: [profileScale, 1, 1],
      })
    }

    const [part] = evaluateCad(
      h(Parent, {
        id: 'parent',
        position: [10, 0, 0],
        rotation: [0, 0, Math.PI / 2],
        scale: [2, 1, 1],
        gap: 1,
        profileScale: 0.5,
        materials: { body: core },
      }),
    )

    expect(parentInput).toMatchObject({ gap: 1, profileScale: 0.5 })
    expect(childInput).toMatchObject({
      size: [4, 2, 2],
      position: [2, 0, 0],
      rotation: [0, 0, Math.PI / 4],
      scale: [0.5, 1, 1],
    })

    const bounds = measurements.measureBoundingBox(part.geometry)
    expect(bounds[0][0]).toBeCloseTo(10 - Math.SQRT2)
    expect(bounds[1][0]).toBeCloseTo(10 + Math.SQRT2)
    expect(bounds[0][1]).toBeCloseTo(4 - 2 * Math.SQRT2)
    expect(bounds[1][1]).toBeCloseTo(4 + 2 * Math.SQRT2)
  })

  it('rejects invalid transforms, Fragment transforms, and removed transform elements', () => {
    const core = new Material('Core', { color: '#2563eb' })

    ;[null, 1, [1, 2], [1, 2, 3, 4], [1, '2', 3], [1, Number.NaN, 3], [1, Number.POSITIVE_INFINITY, 3]].forEach(
      (position) => {
        expect(() => evaluateCad(h('box', { id: 'box', size, position, materials: { body: core } }))).toThrow(
          'position must be an array of exactly three finite numbers',
        )
      },
    )

    expect(() =>
      evaluateCad(h(Fragment, { position: [1, 2, 3] }, h(Box, { id: 'box', materials: { body: core } }))),
    ).toThrow('Fragment only accepts children')

    expect(() => evaluateCad(h('box', { id: 'box', size, position: [0, 0, 0], pos: [0, 0, 0] }))).toThrow(
      'cannot mix position/rotation with deprecated pos/rotate',
    )
    expect(() => evaluateCad(h('box', { id: 'box', size, translation: [0, 0, 0] }))).toThrow(
      'does not support translation. Use position',
    )

    ;[null, 1, [1, 2, 3], { axis: [0, 0, 1] }].forEach((rotate) => {
      expect(() => evaluateCad(h(Box, { id: 'box', rotate, materials: { body: core } }))).toThrow()
    })
    ;[
      [0, 0, 0],
      [1, 2],
      [1, Number.NaN, 0],
    ].forEach((axis) => {
      expect(() => evaluateCad(h(Box, { id: 'box', rotate: { axis, angle: 1 }, materials: { body: core } }))).toThrow(
        'rotate.axis',
      )
    })
    ;[Number.NaN, Number.POSITIVE_INFINITY, '1'].forEach((angle) => {
      expect(() =>
        evaluateCad(h(Box, { id: 'box', rotate: { axis: [0, 0, 1], angle }, materials: { body: core } })),
      ).toThrow('rotate.angle must be a finite number')
    })
    ;[
      [1, 2],
      [1, 2, 3, 4],
      [1, Number.NaN, 1],
    ].forEach((scale) => {
      expect(() => evaluateCad(h(Box, { id: 'box', scale, materials: { body: core } }))).toThrow(
        'scale must be an array of exactly three finite numbers',
      )
    })

    expect(() =>
      evaluateCad(h('translate', { pos: [1, 2, 3], materials: { body: core } }, h(Box, { id: 'box' }))),
    ).toThrow('Use the relative position attribute instead')
    expect(() => evaluateCad(h('rotate', null, h(Box, { id: 'box', materials: { body: core } })))).toThrow(
      'Use the XYZ Euler rotation attribute instead',
    )
    expect(() => evaluateCad(h('scale', null, h(Box, { id: 'box', materials: { body: core } })))).toThrow(
      'Use the scale attribute instead',
    )
  })

  it('matches Three/R3F intrinsic XYZ Euler order for a compound rotation', () => {
    const [part] = evaluateCad(h('box', { id: 'rotated', size: [2, 4, 6], rotation: [0.3, -0.4, 0.5] }))
    const bounds = measurements.measureBoundingBox(part.geometry)

    expect(bounds[0][0]).toBeCloseTo(-2.8597224199746085)
    expect(bounds[0][1]).toBeCloseTo(-2.9607148650390913)
    expect(bounds[0][2]).toBeCloseTo(-3.2699022589285516)
    expect(bounds[1][0]).toBeCloseTo(2.8597224199746085)
    expect(bounds[1][1]).toBeCloseTo(2.9607148650390913)
    expect(bounds[1][2]).toBeCloseTo(3.2699022589285516)
  })
})
