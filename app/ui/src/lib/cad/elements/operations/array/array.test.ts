import { measurements } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { Material } from '../../../model/core'
import { Fragment, evaluateCad, h } from '../../../index'

const size = [2, 2, 2]

function Box() {
  return h('box', { size })
}

describe('CAD array', () => {
  it('centers array cells and supports normalized non-orthogonal lattice axes', () => {
    const core = new Material('Core', { color: '#2563eb' })

    function Cell() {
      return h('box', { size })
    }

    function Parent() {
      return h('array', { shape: [2, 1, 1], period: [4, 0, 0] }, h(Cell, { id: 'cell' }))
    }

    const centered = evaluateCad(h(Parent, { id: 'parent', materials: { body: core } }))
    const oriented = evaluateCad(
      h(
        'array',
        {
          shape: [2, 2, 1],
          period: [4, 2, 0],
          axes: { x: [0, 2, 0], y: [1, 1, 0], z: [0, 0, 3] },
        },
        h(Cell, { id: 'cell', materials: { body: core } }),
      ),
    )

    expect(centered.map((part) => measurements.measureBoundingBox(part.geometry))).toEqual([
      [
        [-3, -1, -1],
        [-1, 1, 1],
      ],
      [
        [1, -1, -1],
        [3, 1, 1],
      ],
    ])
    expect(centered.map((part) => part.id)).toEqual(['parent.$cell-0-0-0.cell', 'parent.$cell-1-0-0.cell'])
    expect(oriented).toHaveLength(4)

    const centers = oriented.map((part) => {
      const bounds = measurements.measureBoundingBox(part.geometry)
      return bounds[0].map((minimum, axis) => (minimum + bounds[1][axis]) / 2)
    })
    const diagonal = 1 / Math.sqrt(2)
    const expected = [
      [-diagonal, -2 - diagonal, 0],
      [diagonal, -2 + diagonal, 0],
      [-diagonal, 2 - diagonal, 0],
      [diagonal, 2 + diagonal, 0],
    ]

    centers.forEach((center, cell) => {
      center.forEach((coordinate, axis) => expect(coordinate).toBeCloseTo(expected[cell][axis]))
    })
  })

  it('injects multiple custom and transform tensors over the child base props', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const received: Record<string, unknown>[] = []

    function Cell(input: Record<string, unknown>) {
      received.push(input)
      return h('box', { size: input.size })
    }

    const parts = evaluateCad(
      h(
        'array',
        {
          shape: [2, 1, 1],
          period: [10, 0, 0],
          inject: {
            size: [[[[2, 2, 2]]], [[[4, 2, 2]]]],
            holeRadius: [[[1]], [[2]]],
            pos: [[[[1, 0, 0]]], [[[-1, 0, 0]]]],
            scale: [[[[1, 1, 1]]], [[[0.5, 2, 1]]]],
            rotate: {
              axis: [[[[0, 0, 1]]], [[[0, 0, 5]]]],
              angle: [[[0]], [[Math.PI / 2]]],
            },
          },
        },
        h(Cell, {
          id: 'cell',
          size: [1, 1, 1],
          holeRadius: 0,
          label: 'preserved',
          pos: [99, 0, 0],
          materials: { body: core },
        }),
      ),
    )

    expect(received).toHaveLength(2)
    expect(received[0]).toMatchObject({
      size: [2, 2, 2],
      holeRadius: 1,
      label: 'preserved',
      pos: [1, 0, 0],
      scale: [1, 1, 1],
      rotate: { axis: [0, 0, 1], angle: 0 },
    })
    expect(received[1]).toMatchObject({
      size: [4, 2, 2],
      holeRadius: 2,
      pos: [-1, 0, 0],
      scale: [0.5, 2, 1],
      rotate: { axis: [0, 0, 1], angle: Math.PI / 2 },
    })
    expect(parts.map((part) => part.material?.name)).toEqual(['Core', 'Core'])

    const centers = parts.map((part) => {
      const bounds = measurements.measureBoundingBox(part.geometry)
      return bounds[0].map((minimum, axis) => (minimum + bounds[1][axis]) / 2)
    })
    expect(centers).toEqual([
      [-4, 0, 0],
      [4, 0, 0],
    ])
  })

  it('applies child transforms, lattice offset, array transforms, and parent transforms in order', () => {
    const core = new Material('Core', { color: '#2563eb' })

    function Cell() {
      return h('box', { size })
    }

    function Parent() {
      return h(
        'array',
        {
          shape: [2, 1, 1],
          period: [4, 0, 0],
          inject: { pos: [[[[1, 0, 0]]], [[[1, 0, 0]]]] },
          scale: [2, 1, 1],
          rotate: { axis: [0, 0, 1], angle: Math.PI / 2 },
          pos: [10, 0, 0],
        },
        h(Cell, { id: 'cell' }),
      )
    }

    const parts = evaluateCad(h(Parent, { id: 'parent', pos: [0, 5, 0], materials: { body: core } }))
    const centers = parts.map((part) => {
      const bounds = measurements.measureBoundingBox(part.geometry)
      return bounds[0].map((minimum, axis) => (minimum + bounds[1][axis]) / 2)
    })

    expect(centers[0][0]).toBeCloseTo(10)
    expect(centers[0][1]).toBeCloseTo(3)
    expect(centers[1][0]).toBeCloseTo(10)
    expect(centers[1][1]).toBeCloseTo(11)
  })

  it('rejects invalid array shape, period, and axes', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const child = h(Box, { id: 'box', materials: { body: core } })

    ;[null, [1, 1], [1, 1, 0], [1, 1, 1.5], [1, 1, Number.NaN]].forEach((shape) => {
      expect(() => evaluateCad(h('array', { shape, period: [1, 1, 1] }, child))).toThrow(
        '<array> shape must be an array of exactly three positive integers',
      )
    })

    ;[
      [0, 0, 0],
      [-1, 0, 0],
      [1, Number.NaN, 0],
      [1, 0],
    ].forEach((period) => {
      expect(() => evaluateCad(h('array', { shape: [2, 1, 1], period }, child))).toThrow('<array> period')
    })

    ;[
      null,
      { x: [1, 0, 0], z: [0, 0, 1] },
      { x: [0, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      { x: [1, 0, 0], y: [0, Number.POSITIVE_INFINITY, 0], z: [0, 0, 1] },
    ].forEach((axes) => {
      expect(() => evaluateCad(h('array', { shape: [1, 1, 1], period: [0, 0, 0], axes }, child))).toThrow(
        '<array> axes',
      )
    })
  })

  it('rejects malformed or forbidden array injection tensors', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const child = h(Box, { id: 'box', materials: { body: core } })
    const evaluate = (inject: unknown) =>
      evaluateCad(h('array', { shape: [2, 1, 1], period: [2, 0, 0], inject }, child))

    expect(() => evaluate(null)).toThrow('<array> inject must be an object')
    expect(() => evaluate({ materials: [[[1]], [[1]]] })).toThrow('inject.materials is not supported')
    expect(() => evaluate({ children: [[[1]], [[1]]] })).toThrow('inject.children is not supported')
    expect(() => evaluate({ id: [[[1]], [[2]]] })).toThrow('inject.id is not supported')
    expect(() => evaluate({ radius: [[[1]]] })).toThrow('must start with shape [2, 1, 1]')
    expect(() => evaluate({ radius: [[[1]], [[1, 2]]] })).toThrow('dense rectangular tensor')
    expect(() => evaluate({ radius: [[[1]], [[Number.NaN]]] })).toThrow('finite numbers')
    expect(() => evaluate({ pos: [[[[0, 0]]], [[[0, 0]]]] })).toThrow('must have shape [2, 1, 1, 3]')
    expect(() => evaluate({ rotate: { axis: [[[[0, 0, 1]]], [[[0, 0, 1]]]], angle: [[[0]]] } })).toThrow(
      'inject.rotate.angle must have shape [2, 1, 1]',
    )
    expect(() => evaluate({ rotate: [[[[0, 0, 1, 0]]], [[[0, 0, 1, 0]]]] })).toThrow(
      'inject.rotate must be an object with axis and angle tensors',
    )
  })

  it('requires exactly one direct function Geometry child for array', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const props = { shape: [1, 1, 1], period: [0, 0, 0] }

    expect(() => evaluateCad(h('array', props))).toThrow('exactly one direct child Geometry')
    expect(() =>
      evaluateCad(
        h(
          'array',
          props,
          h(Box, { id: 'first', materials: { body: core } }),
          h(Box, { id: 'second', materials: { body: core } }),
        ),
      ),
    ).toThrow('exactly one direct child Geometry')
    expect(() => evaluateCad(h('array', props, h('box', { size, materials: { body: core } })))).toThrow(
      'exactly one direct child Geometry',
    )
    expect(() =>
      evaluateCad(h('array', props, h(Fragment, null, h(Box, { id: 'box', materials: { body: core } })))),
    ).toThrow('exactly one direct child Geometry')
  })

  it('keeps array cells independent and preserves existing Material boolean rules', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const cladding = new Material('Cladding', { color: '#f59e0b' })
    const arrayProps = { shape: [2, 1, 1], period: [3, 0, 0] }

    expect(evaluateCad(h('array', arrayProps, h(Box, { id: 'box', materials: { body: core } })))).toHaveLength(2)
    expect(
      evaluateCad(
        h(() => h('union', null, h('array', arrayProps, h(Box, { id: 'box', materials: { body: core } }))), {
          id: 'result',
        }),
      ),
    ).toHaveLength(1)

    function MixedCell() {
      return h(
        Fragment,
        null,
        h(Box, { id: 'core', materials: { body: core } }),
        h(Box, { id: 'cladding', pos: [1, 0, 0], materials: { body: cladding } }),
      )
    }

    expect(() =>
      evaluateCad(
        h(() => h('union', null, h('array', { shape: [1, 1, 1], period: [0, 0, 0] }, h(MixedCell, { id: 'cell' }))), {
          id: 'result',
        }),
      ),
    ).toThrow('cannot combine Geometry with different Materials')
  })

  it('preserves a remapped canonical Material role in every array cell', () => {
    const wheel = new Material('Wheel', { color: '#2563eb' })

    function Cell(input: Record<string, unknown>) {
      const materials = input.materials as Readonly<Record<string, Material>>
      return h(Box, { id: 'body', materials: { body: materials.wheel_A } })
    }

    function Parent() {
      return h('array', { shape: [2, 1, 1], period: [3, 0, 0] }, h(Cell, { id: 'cell' }))
    }

    const parts = evaluateCad(h(Parent, { id: 'array', materials: { wheel_A: wheel } }))

    expect(parts.map((part) => part.materialRole)).toEqual(['wheel_A', 'wheel_A'])
    expect(parts.map((part) => part.material?.name)).toEqual(['Wheel', 'Wheel'])
  })
})
