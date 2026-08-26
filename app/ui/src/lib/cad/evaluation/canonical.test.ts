import { describe, expect, it } from 'vitest'
import { renderCanonicalGeometryScene } from '../execution/manifoldRender'
import { Fragment, h } from './jsx'
import { assertCanonicalGeometryScene, canonicalGeometryScene, registerCanonicalGeometryScene } from './canonical'
import { evaluateCadScene } from './evaluator'
import type { CanonicalGeometryNodeV1 } from './canonicalTypes'
import { MAX_CANONICAL_RENDER_TYPED_ARRAY_BYTES } from './canonicalTypes'

describe('Canonical Geometry evaluation and local rendering', () => {
  it('preserves explicit Boolean leaf provenance for numeric surface selection', async () => {
    function NotchedConductor() {
      return h(
        'subtract',
        null,
        h('box', { id: 'body', size: [10, 4, 4] }),
        h('box', { id: 'notch', size: [2, 2, 6], position: [0, 2, 0] }),
      )
    }

    const runtimeScene = evaluateCadScene(h(NotchedConductor, { id: 'conductor' }), {
      surfaceGroup: {
        terminals: ['conductor.body/surface/0', 'conductor.body/surface/1'],
      },
    })
    const scene = await canonicalGeometryScene(runtimeScene)

    expect(scene.surfaceGroups[0]).toMatchObject({
      selectors: [
        { rootId: 'conductor', sourceNodeId: 'conductor.body', surfaceIndex: 0 },
        { rootId: 'conductor', sourceNodeId: 'conductor.body', surfaceIndex: 1 },
      ],
      missingMemberIds: [],
    })
    const renderScene = await renderCanonicalGeometryScene(scene, runtimeScene)
    expect(renderScene.surfaceGroups[0].surfaceIds).toEqual([
      'conductor.body/surface/0',
      'conductor.body/surface/1',
    ])
    expect(renderScene.parts[0].surfaces.map((surface) => surface.id)).toEqual(
      expect.arrayContaining(['conductor.body/surface/0', 'conductor.body/surface/1']),
    )
  })

  it('executes function-valued Fiber props and arrays but emits only sampled numeric IR', async () => {
    function Strand() {
      return h('fiber', {
        from: [0, 0, 0],
        to: [0, 0, 4],
        basePath: (t: number) => [0.25 * Math.sin(Math.PI * t), 0, 4 * t],
        radius: (s: number) => 0.3 - 0.05 * s,
        pathSegments: 8,
        radialSegments: 6,
      })
    }

    const runtimeScene = evaluateCadScene(
      h('array', { shape: [2, 1, 1], period: [2, 0, 0] }, h(Strand, { id: 'strand' })),
    )
    const scene = await canonicalGeometryScene(runtimeScene)
    const encoded = JSON.stringify(scene)

    expect(scene.roots).toHaveLength(2)
    expect(encoded).toContain('"kind":"instance"')
    expect(encoded).toContain('"kind":"fiber"')
    expect(encoded).not.toContain('basePath')
    expect(scene.roots.every((root) => root.node.kind === 'instance')).toBe(true)
    const renderScene = await renderCanonicalGeometryScene(scene, runtimeScene)
    expect(renderScene.parts).toHaveLength(2)
    expect(renderScene.parts.every((part) => part.geometry.kind === 'mesh')).toBe(true)
  })

  it('selects generated shell boundaries by their direct root source ids', async () => {
    function Coating() {
      return h('shell', { offsets: { inner: -0.5, outer: 0.5 } }, h('box', { id: 'body', size: [4, 4, 4] }))
    }

    const runtimeScene = evaluateCadScene(h(Coating, { id: 'coat' }), {
      surfaceGroup: {
        boundaries: [
          'coat.$part-1/surface/0',
          'coat.$part-1/surface/1',
          'coat.$part-2/surface/0',
          'coat.$part-2/surface/1',
        ],
      },
    })
    const scene = await canonicalGeometryScene(runtimeScene)

    expect(scene.surfaceGroups[0].missingMemberIds).toEqual([])
    expect(scene.surfaceGroups[0].selectors.map((selector) => selector.rootId)).toEqual([
      'coat.$part-1',
      'coat.$part-1',
      'coat.$part-2',
      'coat.$part-2',
    ])
    expect(scene.surfaceGroups[0].selectors.map((selector) => selector.sourceNodeId)).toEqual([
      'coat.$part-1',
      'coat.$part-1',
      'coat.$part-2',
      'coat.$part-2',
    ])
    const renderScene = await renderCanonicalGeometryScene(scene, runtimeScene)
    expect(renderScene.surfaceGroups[0].surfaceIds).toEqual(scene.surfaceGroups[0].memberIds)
    expect(renderScene.parts.flatMap((part) => part.surfaces.map((surface) => surface.id))).toEqual(
      expect.arrayContaining([...scene.surfaceGroups[0].memberIds]),
    )
  })

  it('rejects the same malformed numeric, cardinality, identity, and reference shapes as the Slave', () => {
    const box = (nodeId: string) => ({
      kind: 'primitive',
      nodeId,
      primitive: 'box',
      parameters: { size: [1, 1, 1] },
    })
    const scene = () => ({
      geometryFormatVersion: 2,
      geometryHash: 'a'.repeat(64),
      lengthUnit: 'm',
      roots: [{ id: 'body', materialRole: 'body', node: box('body') }],
      geometryGroups: [],
      surfaceGroups: [],
    })

    expect(() => assertCanonicalGeometryScene(scene())).not.toThrow()
    expect(() =>
      assertCanonicalGeometryScene({
        ...scene(),
        roots: [...scene().roots, { id: 'second', materialRole: 'body', node: box('body') }],
      }),
    ).not.toThrow()
    expect(() =>
      assertCanonicalGeometryScene({ ...scene(), roots: [...scene().roots, { ...scene().roots[0] }] }),
    ).toThrow('root ids must be unique')
    expect(() =>
      assertCanonicalGeometryScene({
        ...scene(),
        roots: [
          {
            id: 'body',
            materialRole: 'body',
            node: { kind: 'boolean', nodeId: 'result', operation: 'subtract', children: [box('body')] },
          },
        ],
      }),
    ).toThrow('Boolean operation is invalid')
    expect(() =>
      assertCanonicalGeometryScene({
        ...scene(),
        roots: [
          {
            id: 'body',
            materialRole: 'body',
            node: { kind: 'boolean', nodeId: 'result', operation: 'union', children: [box('leaf'), box('leaf')] },
          },
        ],
      }),
    ).toThrow('duplicated within its root')
    expect(() =>
      assertCanonicalGeometryScene({
        ...scene(),
        roots: [
          {
            id: 'body',
            materialRole: 'body',
            node: {
              kind: 'primitive',
              nodeId: 'body',
              primitive: 'cylinder',
              parameters: { radius: Number.POSITIVE_INFINITY, radius_2: 1, height: 1, segments: 8 },
            },
          },
        ],
      }),
    ).toThrow('invalid for cylinder')
    expect(() =>
      assertCanonicalGeometryScene({
        ...scene(),
        roots: [
          {
            id: 'body',
            materialRole: 'body',
            node: {
              kind: 'fiber',
              nodeId: 'body',
              points: [
                [0, 0],
                [0, 0, 1],
              ],
              radii: [1, 1],
              frames: [
                { tangent: [0, 0, 1], normal: [1, 0, 0], binormal: [0, 1, 0] },
                { tangent: [0, 0, 1], normal: [1, 0, 0], binormal: [0, 1, 0] },
              ],
              radialSegments: 6,
            },
          },
        ],
      }),
    ).toThrow('exactly three finite numbers')
  })

  it('rejects invalid group strings, missing references, and ordinal surface migration ids', () => {
    const base = {
      geometryFormatVersion: 2,
      geometryHash: 'a'.repeat(64),
      lengthUnit: 'm',
      roots: [
        {
          id: 'body',
          materialRole: 'body',
          node: { kind: 'primitive', nodeId: 'body', primitive: 'box', parameters: { size: [1, 1, 1] } },
        },
      ],
      geometryGroups: [],
      surfaceGroups: [],
    }
    expect(() =>
      assertCanonicalGeometryScene({
        ...base,
        geometryGroups: [
          {
            id: 'geometry',
            name: 'Geometry',
            kind: 'geometry',
            memberIds: ['body'],
            rootIds: ['missing'],
            missingMemberIds: [],
          },
        ],
      }),
    ).toThrow('references a missing root')
    expect(() =>
      assertCanonicalGeometryScene({
        ...base,
        surfaceGroups: [
          {
            id: 'surface',
            name: 'Surface',
            kind: 'surface',
            memberIds: ['body/surface-1'],
            selectors: [],
            missingMemberIds: ['body/surface-1'],
          },
        ],
      }),
    ).toThrow('must use canonical /surface/<non-negative-index> references')
    expect(() =>
      assertCanonicalGeometryScene({
        ...base,
        surfaceGroups: [
          {
            id: 'surface',
            name: 'Surface',
            kind: 'surface',
            memberIds: ['body/surface/6'],
            selectors: [{ rootId: 'body', sourceNodeId: 'body', surfaceIndex: 6 }],
            missingMemberIds: [],
          },
        ],
      }),
    ).toThrow('does not identify a source surface slot')
  })

  it('rejects forged group accounting, ordering, names, and duplicate selector triples', () => {
    const primitive = { kind: 'primitive', nodeId: 'body', primitive: 'box', parameters: { size: [1, 1, 1] } }
    const base = {
      geometryFormatVersion: 2,
      geometryHash: 'a'.repeat(64),
      lengthUnit: 'm',
      roots: [{ id: 'body', materialRole: 'body', node: primitive }],
      geometryGroups: [],
      surfaceGroups: [],
    }
    const geometryGroup = {
      id: 'first',
      name: 'same',
      kind: 'geometry',
      memberIds: ['body'],
      rootIds: ['body'],
      missingMemberIds: [],
    }
    expect(() =>
      assertCanonicalGeometryScene({
        ...base,
        geometryGroups: [geometryGroup, { ...geometryGroup, id: 'second' }],
      }),
    ).toThrow('geometry group names must be unique')
    expect(() =>
      assertCanonicalGeometryScene({
        ...base,
        geometryGroups: [{ ...geometryGroup, missingMemberIds: ['not-a-member'] }],
      }),
    ).toThrow('must be a subset of memberIds')

    const surfaceGroup = {
      id: 'surface',
      name: 'surface',
      kind: 'surface',
      memberIds: ['body/surface/0'],
      selectors: [{ rootId: 'body', sourceNodeId: 'body', surfaceIndex: 0 }],
      missingMemberIds: [],
    }
    expect(() =>
      assertCanonicalGeometryScene({ ...base, surfaceGroups: [{ ...surfaceGroup, selectors: [] }] }),
    ).toThrow('correspond exactly')
    expect(() =>
      assertCanonicalGeometryScene({
        ...base,
        surfaceGroups: [
          {
            ...surfaceGroup,
            memberIds: ['body/surface/1'],
            selectors: [{ rootId: 'body', sourceNodeId: 'body', surfaceIndex: 0 }],
          },
        ],
      }),
    ).toThrow('does not match its positional surface memberId')

    expect(() =>
      assertCanonicalGeometryScene({
        ...base,
        roots: [{ ...base.roots[0], id: '\ud800' }],
      }),
    ).toThrow('identity is invalid')

    const shellBase = {
      ...base,
      roots: [
        {
          id: 'shell',
          materialRole: 'coat',
          node: { kind: 'shell', nodeId: 'layer', innerOffset: 0, outerOffset: 1, child: primitive },
        },
      ],
    }
    const repeated = { rootId: 'shell', sourceNodeId: 'layer', surfaceIndex: 0 }
    expect(() =>
      assertCanonicalGeometryScene({
        ...shellBase,
        surfaceGroups: [
          {
            ...surfaceGroup,
            memberIds: ['layer/surface/0', 'layer/surface/0'],
            selectors: [repeated, repeated],
          },
        ],
      }),
    ).toThrow('values must be unique')
  })

  it('indexes numeric surfaces and group membership without repeated linear scans', () => {
    let generationKindReads = 0
    const instrumentedNode = {
      get kind() {
        generationKindReads += 1
        return 'primitive' as const
      },
      nodeId: 'body',
      primitive: 'box' as const,
      parameters: { size: [1, 1, 1] as const },
    }
    const runtimeScene = evaluateCadScene(h('box', { id: 'runtime-body', size: [1, 1, 1] }))
    const missingSurfaces = Array.from({ length: 500 }, (_, index) => `missing-${index}/surface/0`)
    const draft = registerCanonicalGeometryScene(
      runtimeScene,
      [{ id: 'body', materialRole: 'body', node: instrumentedNode }],
      { surfaceGroup: { missing: missingSurfaces } },
    )
    expect(draft.surfaceGroups[0].missingMemberIds).toHaveLength(missingSurfaces.length)
    expect(generationKindReads).toBeLessThan(10)

    const rejectIncludes = (items: string[]) =>
      new Proxy(items, {
        get(target, property, receiver) {
          if (property === 'includes') throw new Error('group validation performed a linear membership scan')
          return Reflect.get(target, property, receiver)
        },
      })
    const memberIds = rejectIncludes(['missing/surface/0'])
    const absentIds = rejectIncludes(['missing/surface/0'])
    expect(() =>
      assertCanonicalGeometryScene({
        geometryFormatVersion: 2,
        geometryHash: 'a'.repeat(64),
        lengthUnit: 'm',
        roots: [{ id: 'body', materialRole: 'body', node: instrumentedNode }],
        geometryGroups: [
          { id: 'geometry', name: 'geometry', kind: 'geometry', memberIds, rootIds: [], missingMemberIds: absentIds },
        ],
        surfaceGroups: [
          { id: 'surface', name: 'surface', kind: 'surface', memberIds, selectors: [], missingMemberIds: absentIds },
        ],
      }),
    ).not.toThrow()

    let validationKindReads = 0
    const leaves = Array.from(
      { length: 64 },
      (_, index) =>
        new Proxy(
          {
            kind: 'primitive' as const,
            nodeId: `leaf-${index}`,
            primitive: 'box' as const,
            parameters: { size: [1, 1, 1] },
          },
          {
            get(target, property, receiver) {
              if (property === 'kind') validationKindReads += 1
              return Reflect.get(target, property, receiver)
            },
          },
        ),
    )
    assertCanonicalGeometryScene({
      geometryFormatVersion: 2,
      geometryHash: 'a'.repeat(64),
      lengthUnit: 'm',
      roots: [
        {
          id: 'body',
          materialRole: 'body',
          node: { kind: 'boolean', nodeId: 'union', operation: 'union', children: leaves },
        },
      ],
      geometryGroups: [],
      surfaceGroups: [
        {
          id: 'surfaces',
          name: 'surfaces',
          kind: 'surface',
          memberIds: leaves.map((leaf) => `${leaf.nodeId}/surface/0`),
          selectors: leaves.map((leaf) => ({ rootId: 'body', sourceNodeId: leaf.nodeId, surfaceIndex: 0 })),
          missingMemberIds: [],
        },
      ],
    })
    expect(validationKindReads).toBeLessThan(1_000)
  })

  it('allows ordinary sphere Booleans while bounding operand count and aggregate Boolean work', () => {
    const scene = (node: CanonicalGeometryNodeV1) => ({
      geometryFormatVersion: 2,
      geometryHash: 'a'.repeat(64),
      lengthUnit: 'm',
      roots: [{ id: 'body', materialRole: 'body', node }],
      geometryGroups: [],
      surfaceGroups: [],
    })
    const box = (index: number): CanonicalGeometryNodeV1 => ({
      kind: 'primitive',
      nodeId: `box-${index}`,
      primitive: 'box',
      parameters: { size: [1, 1, 1] },
    })
    let unionIndex = 0
    const balancedUnion = (nodes: readonly CanonicalGeometryNodeV1[]): CanonicalGeometryNodeV1 => {
      if (nodes.length === 1) return nodes[0]
      const middle = Math.floor(nodes.length / 2)
      unionIndex += 1
      return {
        kind: 'boolean',
        nodeId: `balanced-union-${unionIndex}`,
        operation: 'union',
        children: [balancedUnion(nodes.slice(0, middle)), balancedUnion(nodes.slice(middle))],
      }
    }

    expect(() =>
      assertCanonicalGeometryScene(
        scene({
          kind: 'boolean',
          nodeId: 'sphere-union',
          operation: 'union',
          children: [
            { kind: 'primitive', nodeId: 'left', primitive: 'sphere', parameters: { radius: 1, segments: 32 } },
            { kind: 'primitive', nodeId: 'right', primitive: 'sphere', parameters: { radius: 1, segments: 32 } },
          ],
        }),
      ),
    ).not.toThrow()
    expect(() =>
      assertCanonicalGeometryScene(
        scene({
          kind: 'boolean',
          nodeId: 'flat',
          operation: 'union',
          children: Array.from({ length: 129 }, (_, i) => box(i)),
        }),
      ),
    ).toThrow('at most 128 operands')
    expect(() =>
      assertCanonicalGeometryScene(scene(balancedUnion(Array.from({ length: 2048 }, (_, index) => box(index))))),
    ).toThrow('Boolean triangle-pair work limit')
  })

  it('rejects root aliases when a shell surface member does not name its direct source node', async () => {
    const runtimeScene = evaluateCadScene(
      h(Fragment, null, h('box', { id: 'left', size: [1, 1, 1] }), h('box', { id: 'right', size: [1, 1, 1] })),
    )
    const evaluated = await canonicalGeometryScene(runtimeScene)
    const scene = {
      ...evaluated,
      roots: evaluated.roots.map((root) => ({
        ...root,
        node: {
          kind: 'shell' as const,
          nodeId: 'shared-layer',
          innerOffset: 0,
          outerOffset: 0.1,
          child: { ...root.node, nodeId: 'shared-leaf' },
        },
      })),
      surfaceGroups: [{
        id: '@surface-group/left-face',
        name: 'left-face',
        kind: 'surface' as const,
        memberIds: ['left/surface/0'],
        selectors: [{ rootId: 'left', sourceNodeId: 'shared-layer', surfaceIndex: 0 }],
        missingMemberIds: [],
      }],
    }

    await expect(renderCanonicalGeometryScene(scene, runtimeScene)).rejects.toThrow(
      'does not match its positional surface memberId',
    )
  })

  it('rejects shell thickness below the portable Float32 precision envelope', async () => {
    const runtimeScene = evaluateCadScene(h('box', { id: 'body', size: [2, 2, 2] }))
    const evaluated = await canonicalGeometryScene(runtimeScene)
    const scene = {
      ...evaluated,
      roots: evaluated.roots.map((root) => ({
        ...root,
        node: {
          kind: 'shell' as const,
          nodeId: 'thin-layer',
          innerOffset: 0,
          outerOffset: 5e-8,
          child: root.node,
        },
      })),
    }

    await expect(renderCanonicalGeometryScene(scene, runtimeScene)).rejects.toThrow(
      'portable Float32 shell precision envelope',
    )
  })

  it('rejects shell thickness lost at its translated Float64 mesh coordinates', async () => {
    const runtimeScene = evaluateCadScene(h('box', { id: 'body', size: [2, 2, 2], position: [1e12, 0, 0] }))
    const evaluated = await canonicalGeometryScene(runtimeScene)
    const scene = {
      ...evaluated,
      roots: evaluated.roots.map((root) => ({
        ...root,
        node: {
          kind: 'shell' as const,
          nodeId: 'translated-thin-layer',
          innerOffset: 0,
          outerOffset: 1e-5,
          child: root.node,
        },
      })),
    }

    await expect(renderCanonicalGeometryScene(scene, runtimeScene)).rejects.toThrow(
      'portable Float64 mesh precision envelope',
    )
  })

  it('reserves the shared render-output budget before allocating mesh snapshots', async () => {
    const runtimeScene = evaluateCadScene(h('box', { id: 'body', size: [2, 2, 2] }))
    const scene = await canonicalGeometryScene(runtimeScene)
    const usage = { triangles: 0, typedArrayBytes: MAX_CANONICAL_RENDER_TYPED_ARRAY_BYTES - 1 }

    await expect(renderCanonicalGeometryScene(scene, runtimeScene, usage)).rejects.toThrow('typed-array limit')
    expect(usage).toEqual({ triangles: 0, typedArrayBytes: MAX_CANONICAL_RENDER_TYPED_ARRAY_BYTES - 1 })
  })

  it('classifies a squat pointed frustum side by endpoint planes instead of normal angle', async () => {
    const runtimeScene = evaluateCadScene(
      h('cylinder', { id: 'cone', radius: 2, radius_2: 0, height: 1, segments: 16 }),
      {
        surfaceGroup: { valid: ['cone/surface/0', 'cone/surface/1'], missing: ['cone/surface/2'] },
      },
    )
    const scene = await canonicalGeometryScene(runtimeScene)
    expect(scene.surfaceGroups[0].missingMemberIds).toEqual([])
    expect(scene.surfaceGroups[1].missingMemberIds).toEqual(['cone/surface/2'])
    const renderScene = await renderCanonicalGeometryScene(scene, runtimeScene)
    const surfaces = Object.fromEntries(
      renderScene.parts[0].surfaces.map((surface) => [surface.surfaceIndex, surface.polygonIndices.length]),
    )

    expect(surfaces).toEqual({ 0: 14, 1: 16 })
  })

  it('rejects a numerically collapsed tiny frustum instead of labeling every face as a cap', async () => {
    const runtimeScene = evaluateCadScene(
      h('cylinder', { id: 'tiny', radius: 1, radius_2: 2, height: 1e-13, segments: 16 }),
    )

    await expect(
      renderCanonicalGeometryScene(await canonicalGeometryScene(runtimeScene), runtimeScene),
    ).rejects.toThrow('ambiguous Manifold face provenance')
  })

  it('keeps side provenance when custom end planes are much closer than the radius', async () => {
    const runtimeScene = evaluateCadScene(
      h('curvedEdgeCylinder', {
        id: 'thin',
        height: 1e-6,
        azimuthalCurve: [{ amplitude: 1, phase: 0 }],
        verticalCurve: { origin: 0, coefficients: [1] },
        azimuthalSegments: 8,
        verticalSegments: 1,
      }),
    )
    const renderScene = await renderCanonicalGeometryScene(await canonicalGeometryScene(runtimeScene), runtimeScene)
    const surfaces = Object.fromEntries(
      renderScene.parts[0].surfaces.map((surface) => [surface.surfaceIndex, surface.polygonIndices.length]),
    )

    expect(surfaces).toEqual({ 0: 8, 1: 16, 2: 8 })
  })

  it('preserves small Fiber cross-sections at large scene coordinates', async () => {
    const runtimeScene = evaluateCadScene(
      h('fiber', {
        id: 'far-fiber',
        from: [1e8, 0, 0],
        to: [1e8, 0, 4],
        radius: 0.1,
        up: [1, 0, 0],
        pathSegments: 8,
        radialSegments: 8,
      }),
    )
    const renderScene = await renderCanonicalGeometryScene(await canonicalGeometryScene(runtimeScene), runtimeScene)
    const positions = renderScene.parts[0].geometry.positions
    const x = Array.from({ length: positions.length / 3 }, (_, index) => positions[index * 3])

    expect(renderScene.parts[0].geometry.polygonOffsets).toHaveLength(145)
    expect(x.every(Number.isFinite)).toBe(true)
    expect(Math.max(...x) - Math.min(...x)).toBeCloseTo(0.2, 5)
  })

  it('rejects custom indexed meshes whose span exceeds their Float32 feature precision', async () => {
    const runtimeScene = evaluateCadScene(
      h('fiber', {
        id: 'long-thin',
        from: [0, 0, 0],
        to: [1e8, 0, 0],
        radius: 0.1,
        up: [0, 1, 0],
        pathSegments: 8,
        radialSegments: 8,
      }),
    )

    await expect(
      renderCanonicalGeometryScene(await canonicalGeometryScene(runtimeScene), runtimeScene),
    ).rejects.toThrow('exceeds the Float32 indexed-mesh precision envelope and is invalid')
  })

  it('uses center cap fans for concave star-shaped curved cylinder sections', async () => {
    const runtimeScene = evaluateCadScene(
      h('curvedEdgeCylinder', {
        id: 'star',
        height: 1,
        azimuthalCurve: [
          { amplitude: 1, phase: 0 },
          { amplitude: 0, phase: 0 },
          { amplitude: 0, phase: 0 },
          { amplitude: 0, phase: 0 },
          { amplitude: 0, phase: 0 },
          { amplitude: 0.8, phase: 0 },
        ],
        verticalCurve: { origin: 0, coefficients: [1] },
        azimuthalSegments: 32,
        verticalSegments: 1,
      }),
    )
    const renderScene = await renderCanonicalGeometryScene(await canonicalGeometryScene(runtimeScene), runtimeScene)

    expect(renderScene.parts[0].surfaces.find((surface) => surface.surfaceIndex === 0)?.polygonIndices).toHaveLength(32)
    expect(renderScene.parts[0].surfaces.find((surface) => surface.surfaceIndex === 2)?.polygonIndices).toHaveLength(32)
    expect(renderScene.parts[0].surfaces.find((surface) => surface.surfaceIndex === 1)?.polygonIndices).toHaveLength(64)
  })

  it('rejects conservatively oversized derived meshes before Manifold allocation', async () => {
    const runtimeScene = evaluateCadScene(h('sphere', { id: 'sphere', radius: 1, segments: 8 }))
    const evaluated = await canonicalGeometryScene(runtimeScene)
    const oversized = {
      ...evaluated,
      roots: [
        {
          ...evaluated.roots[0],
          node: {
            kind: 'primitive' as const,
            nodeId: 'sphere',
            primitive: 'sphere' as const,
            parameters: { radius: 1, segments: 2_000 },
          },
        },
      ],
    }

    expect(() => assertCanonicalGeometryScene(oversized)).toThrow('2,000,000 triangle preview limit')
    await expect(renderCanonicalGeometryScene(oversized, runtimeScene)).rejects.toThrow(
      '2,000,000 triangle preview limit',
    )
  })
})
