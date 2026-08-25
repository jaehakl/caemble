import { describe, expect, it } from 'vitest'
import { Material } from '../model/core'
import { Fragment, evaluateCadScene, h } from '../index'
import type { CadSceneTreeNode } from './types'

function flattenTree(node: CadSceneTreeNode): CadSceneTreeNode[] {
  return [node, ...node.children.flatMap(flattenTree)]
}

describe('CAD scene identity and evaluated tree', () => {
  it('derives stable part, group, array cell, and surface IDs from explicit local Geometry IDs', () => {
    const material = new Material('Scene material', { color: '#2563eb' })

    function Cell() {
      return h('box', { size: [1, 1, 1] })
    }

    function Base() {
      return h('box', { size: [3, 3, 3] })
    }

    function Cutter() {
      return h('cylinder', { radius: 0.5, height: 4, segments: 16 })
    }

    function Root() {
      return h(
        Fragment,
        null,
        h('array', { shape: [2, 1, 1], period: [2, 0, 0] }, h(Cell, { id: 'particle' })),
        h('subtract', null, h(Base, { id: 'base' }), h(Cutter, { id: 'cutter' })),
      )
    }

    const first = evaluateCadScene(h(Root, { id: 'root', materials: { body: material } }))
    const second = evaluateCadScene(h(Root, { id: 'root', materials: { body: material } }))
    const nodes = flattenTree(first.tree)

    expect(first.parts.map((part) => part.id)).toEqual([
      'root.$cell-0-0-0.particle.box',
      'root.$cell-1-0-0.particle.box',
      'root.$part-1',
    ])
    expect(first.parts.map((part) => part.surfaces.length)).toEqual([6, 6, 7])
    expect(new Set(first.parts.flatMap((part) => [part.id, ...part.surfaces.map((surface) => surface.id)])).size).toBe(
      22,
    )
    expect(nodes.map((node) => node.label)).toEqual(
      expect.arrayContaining([
        'Experiment',
        'Root',
        '<array>',
        'Cell [0, 0, 0]',
        'Cell [1, 0, 0]',
        'Cell',
        '<box>',
        '<subtract>',
        'Base',
        'Cutter',
        '<cylinder>',
        'Part 1 · Scene material',
      ]),
    )
    expect(nodes.some((node) => node.label === 'Fragment')).toBe(false)
    expect(nodes.filter((node) => node.geometryId).map((node) => node.geometryId)).toEqual([
      'root.$cell-0-0-0.particle.box',
      'root.$cell-1-0-0.particle.box',
      'root.$part-1',
    ])
    expect(nodes.filter((node) => node.surfaceId).map((node) => node.surfaceId)).toEqual(
      first.parts.flatMap((part) => part.surfaces.map((surface) => surface.id)),
    )

    const rootNode = nodes.find((node) => node.globalId === 'root')!
    expect(rootNode).toMatchObject({
      groupId: 'root',
      geometryIds: ['root.$cell-0-0-0.particle.box', 'root.$cell-1-0-0.particle.box', 'root.$part-1'],
    })

    const arrayNode = nodes.find((node) => node.label === '<array>')!
    expect(arrayNode.groupId).toBeUndefined()
    expect(arrayNode.geometryIds).toBeUndefined()
    const cellNodes = nodes.filter((node) => node.label.startsWith('Cell ['))
    expect(cellNodes.every((node) => node.groupId === undefined)).toBe(true)

    const subtractNode = nodes.find((node) => node.label === '<subtract>')!
    const baseNode = subtractNode.children.find((node) => node.label === 'Base')!
    const cutterNode = subtractNode.children.find((node) => node.label === 'Cutter')!
    expect(baseNode).toMatchObject({ globalId: 'root.base' })
    expect(cutterNode).toMatchObject({ globalId: 'root.cutter' })
    expect(flattenTree(baseNode).some((node) => node.geometryId || node.groupId)).toBe(false)
    expect(flattenTree(cutterNode).some((node) => node.geometryId || node.groupId)).toBe(false)
    expect(subtractNode.groupId).toBeUndefined()

    expect(
      second.parts.map((part) => ({
        id: part.id,
        surfaceIds: part.surfaces.map((surface) => surface.id),
      })),
    ).toEqual(
      first.parts.map((part) => ({
        id: part.id,
        surfaceIds: part.surfaces.map((surface) => surface.id),
      })),
    )
    expect(second.tree).toEqual(first.tree)
  })

  it('labels unresolved scene parts with their required role', () => {
    function Pair() {
      return h(Fragment, null, h('box', { size: [1, 1, 1] }), h('box', { size: [1, 1, 1], position: [2, 0, 0] }))
    }

    const scene = evaluateCadScene(h(Pair, { id: 'pair' }))
    const nodes = flattenTree(scene.tree)

    expect(scene.parts).toHaveLength(2)
    expect(scene.parts.every((part) => part.material === undefined)).toBe(true)
    expect(scene.parts.map((part) => part.materialRole)).toEqual(['body', 'body'])
    expect(scene.parts.map((part) => part.id)).toEqual(['pair.box', 'pair.box-2'])
    expect(nodes.filter((node) => node.geometryId).map((node) => node.geometryId)).toEqual(['pair.box', 'pair.box-2'])
  })

  it('validates local IDs, sibling uniqueness, and the Geometry ownership boundary', () => {
    const material = new Material('Core', { color: '#2563eb' })

    function Box() {
      return h('box', { size: [1, 1, 1] })
    }

    expect(evaluateCadScene(h(Box, { materials: { body: material } })).parts[0].id).toBe('box.box')
    ;['', 'with space', 'with.dot', '$part-1'].forEach((id) => {
      expect(() => evaluateCadScene(h(Box, { id, materials: { body: material } }))).toThrow('Geometry Box id')
    })
    expect(() => evaluateCadScene(h(Box, { id: 1, materials: { body: material } }))).toThrow('Geometry Box id')
    expect(evaluateCadScene(h(Box, { id: '한글-1', materials: { body: material } })).parts[0].id).toBe('한글-1.box')

    function DuplicateChildren() {
      return h('union', null, h(Box, { id: 'same' }), h(Box, { id: 'same' }))
    }

    expect(() => evaluateCadScene(h(DuplicateChildren, { id: 'root', materials: { body: material } }))).toThrow(
      'must be unique within parent "root"',
    )
    expect(() =>
      evaluateCadScene(
        h(Fragment, null, h('box', { id: 'same', size: [1, 1, 1] }), h('sphere', { id: 'same', radius: 1 })),
      ),
    ).toThrow('must be unique within parent "Experiment"')

    function Parent() {
      return h(Box, { id: 'leaf' })
    }

    const separateParents = evaluateCadScene(
      h(
        Fragment,
        null,
        h(Parent, { id: 'left', materials: { body: material } }),
        h(Parent, { id: 'right', materials: { body: material } }),
      ),
    )
    expect(separateParents.parts.map((part) => part.id)).toEqual(['left.leaf.box', 'right.leaf.box'])
    expect(evaluateCadScene(h('box', { materials: { body: material } })).parts[0].id).toBe('box')
    expect(() =>
      evaluateCadScene(
        h(
          'union',
          null,
          h(Box, { id: 'first', materials: { body: material } }),
          h(Box, { id: 'second', materials: { body: material } }),
        ),
      ),
    ).toThrow('requires an explicit id on itself or an enclosing Geometry')
  })

  it('assigns intrinsic IDs and makes topology-changing operations own only their final result', () => {
    function Goal() {
      return h(
        Fragment,
        null,
        h('cylinder', { id: 'pole', radius: 1, height: 10 }),
        h('box', { id: 'backboard', size: [6, 1, 4], position: [0, 3, 4] }),
      )
    }

    expect(evaluateCadScene(h('box', { id: 'root-box', size: [1, 1, 1] })).parts[0].id).toBe('root-box')
    expect(evaluateCadScene(h(Goal, { id: 'goal' })).parts.map((part) => part.id)).toEqual([
      'goal.pole',
      'goal.backboard',
    ])

    const operation = evaluateCadScene(
      h(
        'subtract',
        { id: 'cut' },
        h('box', { id: 'base', size: [4, 4, 4] }),
        h('box', { id: 'cutter', size: [2, 2, 6], position: [1, 0, 0] }),
      ),
    )
    const operationNodes = flattenTree(operation.tree)
    expect(operation.parts.map((part) => part.id)).toEqual(['cut'])
    expect(operationNodes.find((node) => node.globalId === 'cut')).toMatchObject({ geometryId: 'cut' })
    for (const operandId of ['cut.base', 'cut.cutter']) {
      const operand = operationNodes.find((node) => node.globalId === operandId)!
      expect(flattenTree(operand).some((node) => node.geometryId || node.groupId)).toBe(false)
    }

    function EnclosingResult() {
      return h('subtract', null, h('box', { size: [4, 4, 4] }), h('box', { size: [2, 2, 6] }))
    }
    expect(evaluateCadScene(h(EnclosingResult, { id: 'enclosing' })).parts.map((part) => part.id)).toEqual([
      'enclosing',
    ])
    expect(() =>
      evaluateCadScene(
        h('subtract', null, h('box', { id: 'base', size: [4, 4, 4] }), h('box', { id: 'cutter', size: [2, 2, 6] })),
      ),
    ).toThrow('requires an explicit id on itself or an enclosing Geometry')
  })

  it('assigns deterministic sibling ordinals to automatic component and primitive IDs', () => {
    function Leaf() {
      return h('box', null)
    }

    function Assembly() {
      return h(
        Fragment,
        null,
        h(Leaf, null),
        h(Leaf, null),
        h('box', null),
        h('box', { id: 'box' }),
        h('box', { id: 'fixed' }),
      )
    }

    const first = evaluateCadScene(h(Assembly, null))
    const second = evaluateCadScene(h(Assembly, null))
    expect(first.parts.map((part) => part.id)).toEqual([
      'assembly.leaf.box',
      'assembly.leaf-2.box',
      'assembly.box-2',
      'assembly.box',
      'assembly.fixed',
    ])
    expect(second.parts.map((part) => part.id)).toEqual(first.parts.map((part) => part.id))
  })

  it('arrays accept an identified intrinsic child and preserve cell identity', () => {
    const scene = evaluateCadScene(
      h(
        'array',
        { id: 'posts', shape: [2, 1, 1], period: [3, 0, 0] },
        h('cylinder', { id: 'post', radius: 0.5, height: 4 }),
      ),
    )

    expect(scene.parts.map((part) => part.id)).toEqual(['posts.$cell-0-0-0.post', 'posts.$cell-1-0-0.post'])

    const automatic = evaluateCadScene(
      h('array', { id: 'posts', shape: [2, 1, 1], period: [3, 0, 0] }, h('cylinder', null)),
    )
    expect(automatic.parts.map((part) => part.id)).toEqual([
      'posts.$cell-0-0-0.cylinder',
      'posts.$cell-1-0-0.cylinder',
    ])
  })

  it('accumulates reserved cell segments for nested arrays', () => {
    const material = new Material('Particle', { color: '#2563eb' })

    function Particle() {
      return h('box', { size: [1, 1, 1] })
    }

    function Row() {
      return h('array', { shape: [1, 2, 1], period: [0, 2, 0] }, h(Particle, { id: 'particle' }))
    }

    function Assembly() {
      return h('array', { shape: [2, 1, 1], period: [2, 0, 0] }, h(Row, { id: 'row' }))
    }

    expect(
      evaluateCadScene(h(Assembly, { id: 'assembly', materials: { body: material } })).parts.map((part) => part.id),
    ).toEqual([
      'assembly.$cell-0-0-0.row.$cell-0-0-0.particle.box',
      'assembly.$cell-0-0-0.row.$cell-0-1-0.particle.box',
      'assembly.$cell-1-0-0.row.$cell-0-0-0.particle.box',
      'assembly.$cell-1-0-0.row.$cell-0-1-0.particle.box',
    ])
  })

  it('resolves named Geometry and Surface groups while preserving missing members', () => {
    const material = new Material('Grouped', { color: '#2563eb' })

    function Leaf() {
      return h('box', { size: [1, 1, 1] })
    }

    function Assembly() {
      return h(Fragment, null, h(Leaf, { id: 'left' }), h(Leaf, { id: 'right' }))
    }

    const scene = evaluateCadScene(h(Assembly, { id: 'assembly', materials: { body: material } }), {
      geometryGroup: {
        전체: ['assembly', 'assembly.left', 'missing.geometry'],
        empty: [],
        overlap: ['assembly.left'],
      },
      surfaceGroup: {
        contacts: ['assembly.left.box/surface/-X', 'assembly.right.box/surface/%2BX', 'missing/surface/-X'],
      },
    })

    expect(scene.geometryGroups[0]).toEqual({
      id: '@geometry-group/%EC%A0%84%EC%B2%B4',
      name: '전체',
      kind: 'geometry',
      memberIds: ['assembly', 'assembly.left', 'missing.geometry'],
      geometryIds: ['assembly.left.box', 'assembly.right.box'],
      surfaceIds: [],
      missingMemberIds: ['missing.geometry'],
    })
    expect(scene.geometryGroups[1].geometryIds).toEqual([])
    expect(scene.geometryGroups[2].geometryIds).toEqual(['assembly.left.box'])
    expect(scene.surfaceGroups[0]).toMatchObject({
      id: '@surface-group/contacts',
      geometryIds: ['assembly.left.box', 'assembly.right.box'],
      surfaceIds: ['assembly.left.box/surface/-X', 'assembly.right.box/surface/%2BX'],
      missingMemberIds: ['missing/surface/-X'],
    })
  })
})
