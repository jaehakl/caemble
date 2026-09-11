// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { geometries } from '@jscad/modeling'
import { evaluateCadScene } from './evaluator'
import { canonicalGeometryScene } from './canonical'
import { h } from './jsx'
import { analysisGeometryProfile } from './precision'

describe('analysis canonical sampling', () => {
  it('preserves preview resolution, CSG identities and original Fiber functions', async () => {
    const inputs: number[] = []
    const root = h('fiber', {
      id: 'curve',
      from: [0, 0, 0],
      to: [0, 0, 1],
      pathSegments: 8,
      radialSegments: 8,
      basePath: (t: number) => {
        inputs.push(t)
        return [0.1 * Math.sin(Math.PI * 2 * t), 0, t]
      },
      radius: (s: number) => 0.03 + s * 0.01,
    })
    const preview = evaluateCadScene(root)
    inputs.length = 0
    const analysis = evaluateCadScene(root, {}, 'Experiment', 'm', analysisGeometryProfile)
    expect(inputs).toContain(1 / (analysisGeometryProfile.pathSegments * 4))
    const before = await canonicalGeometryScene(preview)
    const after = await canonicalGeometryScene(analysis)
    expect(after.evaluationProfile).toEqual(analysisGeometryProfile)
    expect(after.roots[0].id).toBe(before.roots[0].id)
    const original = before.roots[0].node
    const dense = after.roots[0].node
    expect(original.kind).toBe('fiber')
    expect(dense.kind).toBe('fiber')
    if (original.kind !== 'fiber' || dense.kind !== 'fiber') throw new Error('Expected Fiber nodes')
    expect(original.points).toHaveLength(9)
    expect(dense.points).toHaveLength(513)
    expect(dense.radialSegments).toBe(128)
    expect(dense.radii[256]).toBeCloseTo(0.035)
    expect(dense.points[0]).toEqual([0, 0, 0])
    expect(dense.points[512]).toEqual([0, 0, 1])
    expect(
      geometries.geom3.toPolygons(analysis.parts[0].geometry as Parameters<typeof geometries.geom3.toPolygons>[0]),
    ).toHaveLength(
      geometries.geom3.toPolygons(preview.parts[0].geometry as Parameters<typeof geometries.geom3.toPolygons>[0])
        .length,
    )
    expect(after.geometryHash).not.toBe(before.geometryHash)
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
    expect(authored.children[1]).toMatchObject({ kind: 'primitive', parameters: { segments: 8 } })
    const after = await canonicalGeometryScene(
      evaluateCadScene(root, groups, 'Experiment', 'm', analysisGeometryProfile),
    )
    expect(after.surfaceGroups).toEqual(before.surfaceGroups)
    expect(after.surfaceGroups[0].missingMemberIds).toEqual([])
    const node = after.roots[0].node
    expect(node.kind).toBe('boolean')
    if (node.kind !== 'boolean') throw new Error('Expected Boolean node')
    expect(node.children[1]).toMatchObject({ kind: 'primitive', nodeId: 'bracket.hole', parameters: { segments: 128 } })
    const repeat = await canonicalGeometryScene(
      evaluateCadScene(root, groups, 'Experiment', 'm', analysisGeometryProfile),
    )
    expect(repeat.geometryHash).toBe(after.geometryHash)
    const refined = await canonicalGeometryScene(
      evaluateCadScene(root, groups, 'Experiment', 'm', { ...analysisGeometryProfile, angularSegments: 256 }),
    )
    expect(refined.geometryHash).not.toBe(after.geometryHash)
  })
})
