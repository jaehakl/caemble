import { geometries, measurements } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { Material } from '../../../model/core'
import { Fragment, evaluateCad, h } from '../../../index'

const size = [2, 2, 2]

function Box() {
  return h('box', { size })
}

describe('CAD booleans', () => {
  it('allows same-Material union and rejects cross-Material union and intersect', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const cladding = new Material('Cladding', { color: '#f59e0b' })

    expect(
      evaluateCad(
        h(() => h('union', null, h(Box, { id: 'first' }), h(Box, { id: 'second' })), {
          id: 'result',
          materials: { body: core },
        }),
      ),
    ).toHaveLength(1)
    expect(() =>
      evaluateCad(
        h(
          () =>
            h(
              'union',
              null,
              h(Box, { id: 'first', materials: { body: core } }),
              h(Box, { id: 'second', materials: { body: cladding } }),
            ),
          { id: 'result' },
        ),
      ),
    ).toThrow('cannot combine Geometry with different Materials')
    expect(() =>
      evaluateCad(
        h(
          () =>
            h(
              'intersect',
              null,
              h(Box, { id: 'first', materials: { body: core } }),
              h(Box, { id: 'second', materials: { body: cladding } }),
            ),
          { id: 'result' },
        ),
      ),
    ).toThrow('cannot combine Geometry with different Materials')
  })

  it('allows fully materialless booleans and rejects mixed union or intersect inputs', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const materiallessUnion = evaluateCad(
      h(() => h('union', null, h(Box, { id: 'first' }), h(Box, { id: 'second', position: [1, 0, 0] })), {
        id: 'union',
      }),
    )[0]
    const materiallessIntersect = evaluateCad(
      h(() => h('intersect', null, h(Box, { id: 'first' }), h(Box, { id: 'second', position: [1, 0, 0] })), {
        id: 'intersect',
      }),
    )[0]

    expect(materiallessUnion).not.toHaveProperty('material')
    expect(materiallessIntersect).not.toHaveProperty('material')
    for (const operation of ['union', 'intersect'] as const) {
      expect(() =>
        evaluateCad(
          h(() => h(operation, null, h(Box, { id: 'plain' }), h(Box, { id: 'core', materials: { body: core } })), {
            id: operation,
          }),
        ),
      ).toThrow('cannot combine Geometry with different Materials')
    }
  })

  it('does not merge unresolved parts that require different canonical roles', () => {
    function ByRole(input: Record<string, unknown>) {
      const materials = input.materials as Readonly<Record<string, Material>>
      const role = input.role as string
      return h(Box, { id: 'box', materials: { body: materials[role] } })
    }

    expect(() =>
      evaluateCad(
        h(() => h('union', null, h(ByRole, { id: 'left', role: 'left' }), h(ByRole, { id: 'right', role: 'right' })), {
          id: 'result',
        }),
      ),
    ).toThrow('cannot combine Geometry with different Materials')
  })

  it('subtracts every cutter from each base part while preserving Material and order', () => {
    const first = new Material('First', { color: '#2563eb' })
    const second = new Material('Second', { color: '#f59e0b' })
    const cutter = new Material('Cutter', { color: '#64748b' })
    const parts = evaluateCad(
      h(
        () =>
          h(
            'subtract',
            null,
            h(
              Fragment,
              null,
              h(Box, { id: 'first', position: [-2, 0, 0], scale: [2, 2, 2], materials: { body: first } }),
              h(Box, { id: 'second', position: [2, 0, 0], scale: [2, 2, 2], materials: { body: second } }),
            ),
            h(Box, { id: 'cutter', position: [0, -2, 0], scale: [6, 2, 3], materials: { body: cutter } }),
          ),
        { id: 'result' },
      ),
    )

    expect(parts.map((part) => part.material?.name)).toEqual(['First', 'Second'])
    expect(parts.map((part) => part.materialRole)).toEqual(['body', 'body'])
    parts.forEach((part) => {
      expect(() => geometries.geom3.validate(part.geometry)).not.toThrow()
      expect(measurements.measureVolume(part.geometry)).toBeCloseTo(32, 6)
      expect(measurements.measureBoundingBox(part.geometry)[0][1]).toBeCloseTo(0, 6)
    })
  })

  it('preserves an unassigned subtract base when the cutter has a Material', () => {
    const cutter = new Material('Cutter', { color: '#64748b' })
    const [part] = evaluateCad(
      h(
        () =>
          h(
            'subtract',
            null,
            h(Box, { id: 'base', scale: [2, 2, 2] }),
            h(Box, { id: 'cutter', materials: { body: cutter } }),
          ),
        { id: 'result' },
      ),
    )

    expect(part).not.toHaveProperty('material')
    expect(() => geometries.geom3.validate(part.geometry)).not.toThrow()
  })

  it('derives six outer box surfaces and one cylindrical cut surface', () => {
    const material = new Material('Machined', { color: '#2563eb' })

    function Base() {
      return h('box', { size: [3, 3, 3] })
    }

    function Cutter() {
      return h('cylinder', { radius: 0.5, height: 4, segments: 32 })
    }

    function Result() {
      return h('subtract', null, h(Base, { id: 'base' }), h(Cutter, { id: 'cutter' }))
    }

    const [part] = evaluateCad(h(Result, { id: 'result', materials: { body: material } }))

    expect(part.surfaces).toHaveLength(7)
    expect(part.surfaces.map((surface) => surface.name)).toEqual([
      'Surface 1',
      'Surface 2',
      'Surface 3',
      'Surface 4',
      'Surface 5',
      'Surface 6',
      'Surface 7',
    ])
  })
})
