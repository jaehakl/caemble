// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RecordedResultContracts } from '@/contracts/results'
import type { DataSchema, RecordedData, RecordedDataRule } from '@/lib/cad/model'
import {
  createAttachmentDataTensor,
  createDataTensor,
  isDataTensor,
  registerDataTensorAttachment,
  releaseDataTensorAttachments,
} from '@/lib/cad/model/dataTensor'
import { resultVisualizationSchema } from '@/contracts/resultValidators'
import {
  createMeshTransformRenderData,
  meshTransformAtTime,
  parseRecordedMeshTransforms,
  prepareMeshTransform,
} from './meshTransforms'

function fixture(samples = 2) {
  const bodyIds = ['body-90', 'body-2']
  const times = Array.from({ length: samples }, (_, index) => index / Math.max(1, samples - 1))
  const poses = times.map((time) => [
    [5 + time * 2, 0, 0],
    [0, 3, 0],
  ])
  const rotations = times.map((time) => [
    [Math.cos((time * Math.PI) / 2), 0, 0, Math.sin((time * Math.PI) / 2)],
    [-1, 0, 0, 0],
  ])
  const entries: [string, unknown, number[], string | undefined, (number | string)[][]?][] = [
    ['bodyIds', bodyIds, [2], undefined],
    ['times', times, [samples], 's'],
    [
      'vertices',
      [
        [10, 0, 0],
        [11, 0, 0],
        [10, 2, 0],
        [10, 0, 3],
        [0, 0, 0],
        [1, 0, 0],
        [0, 2, 0],
        [0, 0, 3],
      ],
      [8, 3],
      'm',
    ],
    [
      'triangles',
      [
        [0, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
        [1, 2, 3],
        [4, 6, 5],
        [4, 5, 7],
        [4, 7, 6],
        [5, 6, 7],
      ],
      [8, 3],
      undefined,
    ],
    ['vertexOffsets', [0, 4, 8], [3], undefined],
    ['triangleOffsets', [0, 4, 8], [3], undefined],
    [
      'localCenters',
      [
        [10, 0, 0],
        [0, 0, 0],
      ],
      [2, 3],
      'm',
      [bodyIds],
    ],
    ['positions', poses, [samples, 2, 3], 'm', [times, bodyIds]],
    ['orientations', rotations, [samples, 2, 4], '1', [times, bodyIds]],
  ]
  const rules: RecordedDataRule[] = []
  const data: Record<string, unknown> = {}
  const attachments: string[] = []
  for (const [member, value, shape, unit, ticks] of entries) {
    const schema = {
      dtype: member === 'bodyIds' ? 'string' : unit ? 'float64' : 'int32',
      ...(unit ? { unit, quantityKind: unit === 'm' ? 'Length' : unit === 's' ? 'Time' : 'Dimensionless' } : {}),
      axes: shape.map((length, axis) => ({
        length,
        ...(ticks?.length === 2 && axis === 0 ? { name: 'time', quantityKind: 'Time', unit: 's' } : {}),
      })),
    } as DataSchema
    const recorded = {
      value: value as Parameters<typeof createDataTensor>[1]['value'],
      axes: shape.map((_, axis) => (ticks?.[axis] ? { ticks: ticks[axis] } : { implicitOrdinal: true as const })),
    }
    const result = createAttachmentDataTensor(schema, recorded, `transform-${member}`)
    for (const attachment of result.attachments) {
      registerDataTensorAttachment(attachment.id, attachment.bytes)
      attachments.push(attachment.id)
    }
    rules.push({ label: `motion.${member}`, methodId: 'test', target: [], parameters: {}, result: schema })
    data[`motion.${member}`] = result.tensor
  }
  const contracts: RecordedResultContracts = {
    motion: {
      task: 'movement',
      output: 'arbitraryName',
      solver: { name: 'fixture', version: '1' },
      artifactType: 'fixture/motion@1',
      catalogRevision: 'fixture',
      schema: {},
      visualization: {
        kind: 'mesh-transform',
        coordinateSpace: 'experiment',
        meshTransform: {
          bodyIds: 'bodyIds',
          times: 'times',
          vertices: 'vertices',
          triangles: 'triangles',
          vertexOffsets: 'vertexOffsets',
          triangleOffsets: 'triangleOffsets',
          localCenters: 'localCenters',
          positions: 'positions',
          orientations: 'orientations',
          quaternionOrder: 'wxyz',
        },
      },
    },
  }
  return { rules, data: data as RecordedData, contracts, attachments }
}

describe('mesh transforms', () => {
  it.each([2, 1200])('restores %i samples with body IDs and the existing attachment decoder', (samples) => {
    const input = fixture(samples)
    try {
      const parsed = parseRecordedMeshTransforms(input.rules, input.data, input.contracts)
      expect(parsed.errors).toEqual([])
      expect(input.attachments.length > 0).toBe(samples === 1200)
      const motion = parsed.motions[0]
      expect(motion.bodyIds).toEqual(['body-90', 'body-2'])
      expect(motion.times.length).toBe(samples)
      expect(meshTransformAtTime(motion, 0).vertices.slice(0, 6)).toEqual(new Float64Array([5, 0, 0, 6, 0, 0]))
      expect(meshTransformAtTime(motion, 1).vertices.slice(12, 18)).toEqual(new Float64Array([0, 3, 0, 1, 3, 0]))
    } finally {
      releaseDataTensorAttachments(input.attachments)
    }
  })

  it('SLERPs a 180 degree turn without shrinking an asymmetric mesh and respects its local COM', () => {
    const input = fixture()
    const motion = parseRecordedMeshTransforms(input.rules, input.data, input.contracts).motions[0]
    const middle = meshTransformAtTime(motion, 0.5)
    expect(middle.centers.slice(0, 3)).toEqual(new Float64Array([6, 0, 0]))
    expect(middle.vertices[3]).toBeCloseTo(6)
    expect(middle.vertices[4]).toBeCloseTo(1)
    for (let body = 0; body < 2; body++) {
      for (let left = body * 4; left < (body + 1) * 4; left++) {
        for (let right = left + 1; right < (body + 1) * 4; right++) {
          const before = Math.hypot(
            ...[0, 1, 2].map((axis) => motion.vertices[left * 3 + axis] - motion.vertices[right * 3 + axis]),
          )
          const after = Math.hypot(
            ...[0, 1, 2].map((axis) => middle.vertices[left * 3 + axis] - middle.vertices[right * 3 + axis]),
          )
          expect(after).toBeCloseTo(before, 12)
        }
      }
    }
    const opposite = {
      ...motion,
      orientations: motion.orientations.map((value, index) => (index >= 8 ? -value : value)),
    }
    expect(Array.from(meshTransformAtTime(opposite, 0.5).vertices)).toEqual(Array.from(middle.vertices))
  })

  it('retains static topology and conservative camera bounds for every interpolated frame', () => {
    const input = fixture()
    const motion = parseRecordedMeshTransforms(input.rules, input.data, input.contracts).motions[0]
    const prepared = prepareMeshTransform(motion, 'mm')
    const initial = createMeshTransformRenderData(motion, 0, prepared)
    const middle = createMeshTransformRenderData(motion, 0.5, prepared)
    expect(middle.bounds).toBe(initial.bounds)
    expect(middle.geometries[0].indices).toBe(initial.geometries[0].indices)
    expect(middle.geometries[0].colors.every(Number.isFinite)).toBe(true)
    expect(middle.geometries[0].positions[0]).toBe(6000)
    for (const geometry of middle.geometries) {
      geometry.positions.forEach((coordinate, index) => {
        expect(coordinate).toBeGreaterThanOrEqual(middle.bounds.min[index % 3])
        expect(coordinate).toBeLessThanOrEqual(middle.bounds.max[index % 3])
      })
    }
  })

  it('renders a single snapshot at the stored pose', () => {
    const input = fixture(1)
    const parsed = parseRecordedMeshTransforms(input.rules, input.data, input.contracts)
    expect(parsed.errors).toEqual([])
    const posed = meshTransformAtTime(parsed.motions[0], 0)
    expect(posed.vertices[3]).toBe(6)
    expect(posed.vertices.every(Number.isFinite)).toBe(true)
  })

  it('rejects missing time units and invalid quaternions without changing input tensors', () => {
    const input = fixture()
    const before = JSON.stringify(input.data)
    const noTimeUnit = input.rules.map((rule) =>
      rule.label === 'motion.positions'
        ? {
            ...rule,
            result: {
              ...rule.result,
              axes: rule.result.axes?.map((axis, index) => (index === 0 ? { length: 2, name: 'time' } : axis)),
            },
          }
        : rule,
    )
    expect(parseRecordedMeshTransforms(noTimeUnit, input.data, input.contracts).errors[0].message).toContain(
      'units are not comparable',
    )
    const orientation = input.data['motion.orientations']
    if (!isDataTensor(orientation)) throw new Error('Fixture orientation is missing.')
    const invalid = {
      ...input.data,
      'motion.orientations': {
        ...orientation,
        storage: {
          kind: 'inline' as const,
          value: [
            [
              [0, 0, 0, 0],
              [-1, 0, 0, 0],
            ],
            [
              [0, 0, 0, 1],
              [-1, 0, 0, 0],
            ],
          ],
        },
      },
    }
    expect(parseRecordedMeshTransforms(input.rules, invalid, input.contracts).errors[0].message).toContain(
      'unit quaternions',
    )
    expect(JSON.stringify(input.data)).toBe(before)
  })

  it('rejects mismatched IDs and cross-body connectivity instead of applying another body pose', () => {
    const input = fixture()
    const pose = input.data['motion.positions']
    if (!isDataTensor(pose)) throw new Error('Fixture pose tensor is missing.')
    const mismatched = {
      ...input.data,
      'motion.positions': {
        ...pose,
        axes: [{ ticks: [0, 1] }, { ticks: ['body-2', 'body-90'] }, { implicitOrdinal: true as const }],
      },
    }
    expect(parseRecordedMeshTransforms(input.rules, mismatched, input.contracts).errors[0].message).toContain(
      'body coordinates',
    )
    const triangleRule = input.rules.find((rule) => rule.label === 'motion.triangles')!
    const triangles = createDataTensor(triangleRule.result, {
      value: [
        [4, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
        [1, 2, 3],
        [4, 6, 5],
        [4, 5, 7],
        [4, 7, 6],
        [5, 6, 7],
      ],
    })
    expect(
      parseRecordedMeshTransforms(input.rules, { ...input.data, 'motion.triangles': triangles }, input.contracts)
        .errors[0].message,
    ).toContain('different body')
  })

  it('requires complete semantic paths and the declared quaternion order', () => {
    const input = fixture()
    const semantic = input.contracts.motion.visualization
    expect(resultVisualizationSchema.safeParse(semantic).success).toBe(true)
    expect(resultVisualizationSchema.safeParse({ kind: 'mesh-transform' }).success).toBe(false)
    expect(
      resultVisualizationSchema.safeParse({
        ...semantic,
        meshTransform: { ...semantic.meshTransform, quaternionOrder: 'xyzw' },
      }).success,
    ).toBe(false)
    expect(resultVisualizationSchema.safeParse({ ...semantic, kind: 'mesh-field' }).success).toBe(false)
  })
})
