// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertBoxGridData } from '@/contracts/boxGrid'
import type { CanonicalGeometryNodeV1, CanonicalGeometrySceneDraftV1 } from '../evaluation/canonicalTypes'
import { createDataTensor, persistDataTensor } from '../model/dataTensor'
import type { DataSchema } from '../model/descriptor'
import { resolveBoxGridGeometry } from './boxGrid'
import type { KernelOutputRequest } from './kernelContract'

const box: CanonicalGeometryNodeV1 = {
  kind: 'primitive',
  nodeId: 'box',
  primitive: 'box',
  parameters: { size: [2, 4, 6] },
}
function scene(node: CanonicalGeometryNodeV1): CanonicalGeometrySceneDraftV1 {
  return {
    lengthUnit: 'mm',
    roots: [{ id: 'box', materialRole: 'body', node }],
    geometryGroups: [
      { id: 'probe', name: 'probe', kind: 'geometry', memberIds: ['box'], rootIds: ['box'], missingMemberIds: [] },
    ],
    surfaceGroups: [],
  }
}
const request: KernelOutputRequest = {
  key: 'field',
  methodId: 'field',
  target: ['task.geometry.probe'],
  parameters: { gridShape: [2, 1, 3] },
}
const profile = {
  version: 1,
  sampling: 'point',
  channels: ['value'],
  components: ['value'],
  channelUnits: ['K'],
} as const

describe('Box target resolution', () => {
  it('composes rotation, translation and scale in local axes without using a world bounding box', () => {
    const task = scene({
      kind: 'transform',
      nodeId: 'rotate',
      matrix: [0, -3, 0, 10, 2, 0, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1],
      child: box,
    })
    const grid = resolveBoxGridGeometry(request, { experiment: scene(box), task }, 'm')
    expect(grid.rotation).toEqual([
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ])
    expect(grid.origin).toEqual([0.016, 0.018000000000000002, 0.027])
    expect(grid.size).toEqual([0.004, 0.012, 0.006])
    expect(grid.gridShape).toEqual([2, 1, 3])
    assertBoxGridData({ ...profile, ...grid }, [2, 1, 3, 1, 1, 1, 1])
  })
  it('keeps Experiment and Task geometry independent even when groups have the same name', () => {
    const experiment = scene(box)
    const task = scene({ ...box, parameters: { size: [8, 10, 12] } })
    expect(resolveBoxGridGeometry(request, { experiment, task }, 'mm').size).toEqual([8, 10, 12])
    expect(
      resolveBoxGridGeometry({ ...request, target: ['experiment.geometry.probe'] }, { experiment, task }, 'mm').size,
    ).toEqual([2, 4, 6])
  })
  it('rejects Boolean targets, multiple Boxes, shear and missing gridShape', () => {
    const boolean = scene({ kind: 'boolean', nodeId: 'union', operation: 'union', children: [box, box] })
    expect(() => resolveBoxGridGeometry(request, { experiment: boolean, task: boolean }, 'mm')).toThrow(/Box primitive/)
    const multiple = {
      ...scene(box),
      geometryGroups: [{ ...scene(box).geometryGroups[0], rootIds: ['box', 'second'] }],
    }
    expect(() => resolveBoxGridGeometry(request, { experiment: multiple, task: multiple }, 'mm')).toThrow(
      /exactly one Box/,
    )
    const shear = scene({
      kind: 'transform',
      nodeId: 'shear',
      matrix: [1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      child: box,
    })
    expect(() => resolveBoxGridGeometry(request, { experiment: shear, task: shear }, 'mm')).toThrow(/shear/)
    expect(() =>
      resolveBoxGridGeometry({ ...request, parameters: {} }, { experiment: scene(box), task: scene(box) }, 'mm'),
    ).toThrow(/gridShape/)
  })
  it('preserves Box geometry and call provenance through inline persistence', () => {
    const grid = resolveBoxGridGeometry(
      { ...request, parameters: { gridShape: [1, 1, 1] } },
      { experiment: scene(box), task: scene(box) },
      'mm',
    )
    const schema: DataSchema = {
      dtype: 'float64',
      quantityKind: 'Temperature',
      unit: 'K',
      boxGrid: profile,
      axes: ['x', 'y', 'z', 'time', 'frequency', 'amplitudePhase', 'component'].map((name) => ({ name, length: 1 })),
    }
    const provenance = {
      task: 'solve',
      solver: { name: 'heat', version: '2.0.0' },
      stateRevision: 1,
      invocation: 2,
      catalogRevision: 'revision',
    }
    const tensor = createDataTensor(schema, { value: [[[[[[[-4]]]]]]], boxGrid: { ...profile, ...grid }, provenance })
    const persisted = persistDataTensor(schema, tensor)
    expect(persisted.boxGrid).toEqual({ ...profile, ...grid })
    expect(persisted.provenance).toEqual(provenance)
    expect(persisted.storage).toEqual({ kind: 'inline', value: [[[[[[[-4]]]]]]] })
  })
})
