import { measurements } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { evaluateCad, evaluateCadScene, h } from '../../../index'
import { radians } from '../../../model/core'

const size = [2, 4, 6]

function bounds(value: unknown) {
  return measurements.measureBoundingBox(evaluateCad(value)[0].geometry)
}

describe('transform operations', () => {
  it('matches direct translate, single-axis rotation, and scale transforms', () => {
    expect(bounds(h('translate', { offset: [10, 20, 30] }, h('box', { id: 'body', size })))).toEqual(
      bounds(h('box', { id: 'body', size, position: [10, 20, 30] })),
    )
    const rotated = bounds(h('rotate', { axis: [0, 0, 1], angle: Math.PI / 2 }, h('box', { id: 'body', size })))
    const directRotation = bounds(h('box', { id: 'body', size, rotation: [0, 0, Math.PI / 2] }))
    rotated.flat().forEach((value, index) => expect(value).toBeCloseTo(directRotation.flat()[index]))
    expect(bounds(h('scale', { x: 2, y: 3, z: 4 }, h('box', { id: 'body', size })))).toEqual(
      bounds(h('box', { id: 'body', size, scale: [2, 3, 4] })),
    )
  })

  it('applies nested wrappers from the inside out and preserves grouped child identity', () => {
    const nested = evaluateCadScene(
      h(
        'translate',
        { id: 'assembly', offset: [10, 0, 0] },
        h('rotate', { axis: [0, 0, 1], angle: Math.PI / 2 }, h('scale', { x: 3, y: 1, z: 1 }, h('box', { size }))),
      ),
    )
    const nestedBounds = measurements.measureBoundingBox(nested.parts[0].geometry)
    expect(nested.parts.map((part) => part.id)).toEqual(['assembly.box'])
    expect(nestedBounds.flat()).toHaveLength(6)
    expect(nestedBounds[0][0]).toBeCloseTo(8)
    expect(nestedBounds[1][0]).toBeCloseTo(12)
    expect(nestedBounds[0][1]).toBeCloseTo(-3)
    expect(nestedBounds[1][1]).toBeCloseTo(3)

    const grouped = evaluateCadScene(
      h(
        'translate',
        { id: 'moved', offset: [5, 0, 0] },
        h('box', { id: 'left', size: [1, 1, 1] }),
        h('box', { id: 'right', size: [1, 1, 1], position: [2, 0, 0] }),
      ),
    )
    expect(grouped.parts.map((part) => part.id)).toEqual(['moved.left', 'moved.right'])
    expect(grouped.tree.children[0]).toMatchObject({ globalId: 'moved', groupId: 'moved' })
  })

  it('rejects missing children, malformed values, and direct transform props on wrappers', () => {
    expect(() => evaluateCad(h('translate', { offset: [1, 2, 3] }))).toThrow('at least one child Geometry')
    expect(() => evaluateCad(h('translate', { offset: [1, 2] }, h('box', { id: 'body', size })))).toThrow(
      '<translate> offset',
    )
    expect(() => evaluateCad(h('rotate', { axis: [0, 0, 0], angle: 1 }, h('box', { id: 'body', size })))).toThrow(
      '<rotate> axis must not be the zero vector',
    )
    expect(() =>
      evaluateCad(h('rotate', { axis: [0, 0, 1], angle: Number.NaN }, h('box', { id: 'body', size }))),
    ).toThrow('<rotate> angle must be a finite number')
    expect(() => evaluateCad(h('scale', { x: 1, y: 1 }, h('box', { id: 'body', size })))).toThrow(
      '<scale> z must be a finite number',
    )
    expect(() =>
      evaluateCad(h('translate', { offset: [1, 2, 3], rotation: [0, 0, 1] }, h('box', { id: 'body', size }))),
    ).toThrow('does not accept rotation')
  })
})

describe('radians', () => {
  it('converts finite scalar and Vec3 degree values', () => {
    expect(radians(180)).toBe(Math.PI)
    const vector = radians([0, 90, 180])
    expect(vector[0]).toBe(0)
    expect(vector[1]).toBe(Math.PI / 2)
    expect(vector[2]).toBe(Math.PI)
    expect(Object.isFrozen(vector)).toBe(true)
  })

  it('rejects non-finite scalars and malformed vectors', () => {
    expect(() => radians(Number.POSITIVE_INFINITY)).toThrow('finite number')
    expect(() => (radians as (value: unknown) => unknown)([0, 90])).toThrow('exactly three finite numbers')
  })
})
