import { measurements } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { evaluateWithVars, Material } from '../model/core'
import { Fragment, evaluateCad, evaluateCadScene, h } from '../index'

const size = [2, 2, 2]

function Box() {
  return h('box', { size })
}

function OffsetBox() {
  return h('box', { size, pos: [2, 0, 0] })
}

describe('CAD transforms-materials', () => {
  it('applies child geometry, then scale, axis-angle rotate, and pos', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const rotated = evaluateCad(
      h(OffsetBox, {
        id: 'offset',
        rotate: { axis: [0, 0, 5], angle: Math.PI / 2 },
        pos: [10, 0, 0],
        materials: [core],
      }),
    )[0]
    const scaled = evaluateCad(h(OffsetBox, { id: 'offset', scale: [2, 1, 1], pos: [10, 0, 0], materials: [core] }))[0]

    expect(measurements.measureBoundingBox(rotated.geometry)).toEqual([
      [9, 1, -1],
      [11, 3, 1],
    ])
    expect(measurements.measureBoundingBox(scaled.geometry)).toEqual([
      [12, -1, -1],
      [16, 1, 1],
    ])
  })

  it('applies scale, rotate, and pos to primitive and completed boolean results', () => {
    const core = new Material('Core', { color: '#2563eb' })
    function Primitive() {
      return h('box', {
        size: [2, 4, 2],
        scale: [2, 1, 1],
        rotate: { axis: [0, 0, 1], angle: Math.PI / 2 },
        pos: [10, 0, 0],
      })
    }

    function Combined() {
      return h(
        'union',
        {
          scale: [2, 1, 1],
          rotate: { axis: [0, 0, 5], angle: Math.PI / 2 },
          pos: [5, 0, 0],
        },
        h(Box, { id: 'first' }),
        h(Box, { id: 'second', pos: [2, 0, 0] }),
      )
    }

    const [primitive] = evaluateCad(h(Primitive, { id: 'primitive', materials: [core] }))
    const [combined] = evaluateCad(h(Combined, { id: 'combined', materials: [core] }))

    expect(measurements.measureBoundingBox(primitive.geometry)).toEqual([
      [8, -2, -1],
      [12, 2, 1],
    ])
    expect(measurements.measureBoundingBox(combined.geometry)).toEqual([
      [4, -2, -1],
      [6, 6, 1],
    ])
  })

  it('treats proportional axis vectors as the same rotation', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const evaluate = (axis: number[]) =>
      evaluateCad(h(OffsetBox, { id: 'offset', rotate: { axis, angle: Math.PI / 2 }, materials: [core] }))[0].geometry

    expect(measurements.measureBoundingBox(evaluate([0, 0, 5]))).toEqual(
      measurements.measureBoundingBox(evaluate([0, 0, 1])),
    )
  })

  it('inherits materials through nested Geometry without registration', () => {
    const core = new Material('Core', { color: '#2563eb' })

    function Parent() {
      return h(Box, { id: 'child' })
    }

    const parts = evaluateCad(h(Parent, { id: 'parent', materials: [core] }))

    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      material: { name: 'Core', variables: { color: '#2563eb' } },
    })
  })

  it('allows a materialless Geometry to group children with their own Materials', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const cladding = new Material('Cladding', { color: '#f59e0b' })
    let groupMaterials: unknown = 'not evaluated'

    function Group(input: Record<string, unknown>) {
      groupMaterials = input.materials
      return h(
        Fragment,
        null,
        h(Box, { id: 'core', materials: [core] }),
        h(Box, { id: 'cladding', pos: [3, 0, 0], materials: [cladding] }),
      )
    }

    const parts = evaluateCad(h(Group, { id: 'group' }))

    expect(groupMaterials).toBeUndefined()
    expect(parts.map((part) => part.material?.name)).toEqual(['Core', 'Cladding'])
  })

  it('allows a primitive to create an unassigned scene part', () => {
    function MateriallessBox() {
      return h('box', { size })
    }

    const [part] = evaluateCad(h(MateriallessBox, { id: 'box' }))

    expect(part.id).toBe('box')
    expect(part).not.toHaveProperty('material')
    expect(part.surfaces.length).toBeGreaterThan(0)
  })

  it('replaces the complete materials array and uses index zero', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const cladding = new Material('Cladding', { color: '#f59e0b' })
    const root = h(
      Fragment,
      null,
      h(Box, { id: 'core', materials: [core, cladding] }),
      h(Box, { id: 'cladding', materials: [cladding, core] }),
    )

    expect(evaluateCad(root).map((part) => part.material?.name)).toEqual(['Core', 'Cladding'])
  })

  it('preserves different Material parts under positioned Geometry', () => {
    const core = new Material('Core', { color: '#2563eb' })
    const cladding = new Material('Cladding', { color: '#f59e0b' })
    const root = h(
      Fragment,
      null,
      h(Box, { id: 'core', pos: [0, 0, 2], materials: [core] }),
      h(Box, { id: 'cladding', materials: [cladding] }),
    )

    expect(evaluateCad(root).map((part) => part.material?.name)).toEqual(['Core', 'Cladding'])
  })

  it('rejects empty material arrays and allows duplicate name/source instances', () => {
    expect(() => evaluateCad(h(Box, { id: 'box', materials: [] }))).toThrow('non-empty array of Material instances')

    const first = new Material('Core', 'measured', { color: '#2563eb' })
    const second = new Material('Core', 'measured', { color: '#f59e0b' })
    const root = h(
      Fragment,
      null,
      h(Box, { id: 'first', materials: [first] }),
      h(Box, { id: 'second', materials: [second] }),
    )

    const parts = evaluateCad(root)
    expect(parts.map((part) => part.material?.name)).toEqual(['Core', 'Core'])
    expect(parts.map((part) => part.material?.source)).toEqual(['measured', 'measured'])
    expect(parts[0].material).not.toBe(parts[1].material)
  })

  it('shares one serializable snapshot for parts using the same Material instance', () => {
    const shared = new Material('Core', 'Kittel_1988', {
      'general.mass_density': {
        dtype: 'float64',
        value: 2.7,
        errorRate: 0,
        unit: 'g.cm-3',
      },
      color: '#2563eb',
    })
    const parts = evaluateCad(
      h(Fragment, null, h(Box, { id: 'first', materials: [shared] }), h(Box, { id: 'second', materials: [shared] })),
    )
    const cloned = structuredClone(parts)

    expect(parts[0].material).toBe(parts[1].material)
    expect(parts[0].material).toEqual({
      name: 'Core',
      source: 'Kittel_1988',
      errorRate: 0.001,
      variables: {
        'general.mass_density': {
          dtype: 'float64',
          value: 2.7,
          errorRate: 0,
          unit: 'g.cm-3',
          quantityKind: 'MassDensity',
        },
        color: '#2563eb',
      },
    })
    expect(cloned[0].material).toBe(cloned[1].material)
  })

  it('preserves uncertainty metadata and shared Material identity until material resolution', () => {
    const shared = new Material('Shared', {
      'general.mass_density': {
        dtype: 'float64',
        value: 10,
        errorRate: 0.2,
        unit: 'kg.m-3',
      },
    })
    const first = new Material('Separate', {
      'general.mass_density': {
        dtype: 'float64',
        value: 10,
        errorRate: 0.2,
        unit: 'kg.m-3',
      },
    })
    const second = new Material('Separate', {
      'general.mass_density': {
        dtype: 'float64',
        value: 10,
        errorRate: 0.2,
        unit: 'kg.m-3',
      },
    })
    const scene = evaluateWithVars({}, () =>
      evaluateCadScene(
        h(
          Fragment,
          null,
          h(Box, { id: 'shared-first', materials: [shared] }),
          h(Box, { id: 'shared-second', pos: [3, 0, 0], materials: [shared] }),
          h(Box, { id: 'separate-first', pos: [6, 0, 0], materials: [first] }),
          h(Box, { id: 'separate-second', pos: [9, 0, 0], materials: [second] }),
        ),
      ),
    )
    const applied = scene.parts.map(
      (part) => part.material?.variables['general.mass_density'] as { value: number; errorRate: number },
    )

    expect(scene.parts[0].material).toBe(scene.parts[1].material)
    expect(applied[0]).toEqual(applied[1])
    expect(applied[2].value).toBe(applied[3].value)
    applied.forEach((density) => expect(density.errorRate).toBe(0.2))
  })
})
