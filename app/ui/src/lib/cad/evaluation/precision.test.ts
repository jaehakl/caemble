// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { geometries } from '@jscad/modeling'
import { evaluateCadScene } from './evaluator'
import { canonicalGeometryScene } from './canonical'
import { h } from './jsx'
import { analysisGeometryProfile } from './precision'
import { evaluateFiber } from '../geometry/fiber'

describe('analysis canonical sampling', () => {
  it('preserves continuous Fiber definitions and separates mesh resolution from identity', async () => {
    const root = h('fiber', {
      id: 'curve',
      from: [0, 0, 0],
      to: [0, 0, 1],
      tessellation: { pathSegments: 8, radialSegments: 8 },
      radiusProfile: [
        { s: 0, radius: 0.03 },
        { s: 1, radius: 0.04 },
      ],
    })
    const preview = evaluateCadScene(root)
    const analysis = evaluateCadScene(root, {}, 'Experiment', 'm', analysisGeometryProfile)
    const before = await canonicalGeometryScene(preview)
    const after = await canonicalGeometryScene(analysis)
    expect(after.evaluationProfile).toEqual(analysisGeometryProfile)
    expect(after.roots[0].id).toBe(before.roots[0].id)
    const original = before.roots[0].node
    const dense = after.roots[0].node
    expect(original.kind).toBe('fiber')
    expect(dense.kind).toBe('fiber')
    if (original.kind !== 'fiber' || dense.kind !== 'fiber') throw new Error('Expected Fiber nodes')
    expect(original.tessellation?.pathSegments).toBe(8)
    expect(dense.tessellation?.pathSegments).toBe(512)
    expect(dense.tessellation?.radialSegments).toBe(128)
    expect(dense.path).toEqual(original.path)
    expect(dense.radiusProfile).toEqual(original.radiusProfile)
    expect(evaluateFiber(dense, 0.5).radius).toBeCloseTo(0.035)
    expect(evaluateFiber(dense, 1).center).toEqual([0, 0, 1])
    expect(
      geometries.geom3.toPolygons(analysis.parts[0].geometry as Parameters<typeof geometries.geom3.toPolygons>[0]),
    ).toHaveLength(
      geometries.geom3.toPolygons(preview.parts[0].geometry as Parameters<typeof geometries.geom3.toPolygons>[0])
        .length,
    )
    expect(after.geometryHash).toBe(before.geometryHash)
    expect(after.meshHash).not.toBe(before.meshHash)
  })

  it('densifies Boolean cutters while retaining stable semantic surface selectors', async () => {
    const root = h(
      'subtract',
      { id: 'bracket' },
      h('box', { id: 'body', size: [2, 2, 1] }),
      h('cylinder', { id: 'hole', radius: 0.25, height: 2, segments: 8 }),
    )
    const groups = { surfaceGroup: { hole: ['bracket.hole/surface/1'] } }
    const before = await canonicalGeometryScene(evaluateCadScene(root, groups))
    const authored = before.roots[0].node
    expect(authored.kind).toBe('boolean')
    if (authored.kind !== 'boolean') throw new Error('Expected Boolean node')
    expect(authored.children[1]).toMatchObject({ kind: 'primitive', tessellation: { segments: 8 } })
    const after = await canonicalGeometryScene(
      evaluateCadScene(root, groups, 'Experiment', 'm', analysisGeometryProfile),
    )
    expect(after.surfaceGroups).toEqual(before.surfaceGroups)
    expect(after.surfaceGroups[0].missingMemberIds).toEqual([])
    const node = after.roots[0].node
    expect(node.kind).toBe('boolean')
    if (node.kind !== 'boolean') throw new Error('Expected Boolean node')
    expect(node.children[1]).toMatchObject({
      kind: 'primitive',
      nodeId: 'bracket.hole',
      tessellation: { segments: 128 },
    })
    const repeat = await canonicalGeometryScene(
      evaluateCadScene(root, groups, 'Experiment', 'm', analysisGeometryProfile),
    )
    expect(repeat.geometryHash).toBe(after.geometryHash)
    const refined = await canonicalGeometryScene(
      evaluateCadScene(root, groups, 'Experiment', 'm', { ...analysisGeometryProfile, angularSegments: 256 }),
    )
    expect(refined.geometryHash).toBe(after.geometryHash)
    expect(refined.meshHash).not.toBe(after.meshHash)
  })
})
