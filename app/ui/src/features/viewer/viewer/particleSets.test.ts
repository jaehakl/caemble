// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { RecordedResultContracts } from '@/contracts/results'
import type { DataSchema, RecordedData, RecordedDataRule } from '@/lib/cad/model'
import {
  createAttachmentDataTensor,
  createDataTensor,
  registerDataTensorAttachment,
  releaseDataTensorAttachments,
} from '@/lib/cad/model/dataTensor'
import { resultVisualizationSchema } from '@/contracts/resultValidators'
import { createParticleRenderData, parseRecordedParticleSets, particleFrameValues } from './particleSets'

function fixture(samples = 2) {
  const ids = [90, 2]
  const times = Array.from({ length: samples }, (_, i) => i)
  const tensorComponents = ['xx', 'xy', 'xz', 'yx', 'yy', 'yz', 'zx', 'zy', 'zz']
  const entries: [string, unknown, number[], string?, string?][] = [
    ['particleIds', ids, [2]],
    ['materialIndices', [1, 0], [2]],
    ['materialNames', ['Fluid', 'Steel'], [2]],
    ['times', times, [samples], 's', 'Time'],
    [
      'positions',
      times.map((t) => [
        [1000 + t, 0, 0],
        [0, 0, 0],
      ]),
      [samples, 2, 3],
      'mm',
      'Length',
    ],
    [
      'velocity',
      times.map(() => [
        [3, 4, 0],
        [0, 0, 2],
      ]),
      [samples, 2, 3],
      'm.s-1',
      'kinematics.Velocity',
    ],
    ['radius', times.map(() => [0.1, 0.2]), [samples, 2], 'm', 'Length'],
    [
      'stress',
      times.map(() => [Array.from({ length: 9 }, (_, i) => i + 1), Array(9).fill(0)]),
      [samples, 2, 9],
      'Pa',
      'mechanics.Stress',
    ],
  ]
  const rules: RecordedDataRule[] = []
  const data: Record<string, RecordedData[string]> = {}
  const attachments: string[] = []
  for (const [member, value, shape, unit, quantityKind] of entries) {
    const sampled = ['positions', 'velocity', 'radius', 'stress'].includes(member)
    const schema = {
      dtype: member === 'materialNames' ? 'string' : unit ? 'float64' : 'int32',
      ...(unit ? { unit, quantityKind } : {}),
      axes: shape.map((length, axis) => ({
        length,
        ...(sampled && axis === 0 ? { name: 'time', quantityKind: 'Time', unit: 's' } : {}),
      })),
    } as DataSchema
    const result = createAttachmentDataTensor(
      schema,
      {
        value: value as Parameters<typeof createDataTensor>[1]['value'],
        axes: shape.map((_, axis) =>
          sampled && axis < 2
            ? { ticks: axis === 0 ? times : ids }
            : axis === 2 && member === 'velocity'
              ? { ticks: ['x', 'y', 'z'] }
              : axis === 2 && member === 'stress'
                ? { ticks: tensorComponents }
                : { implicitOrdinal: true },
        ),
      },
      `particles-${member}`,
    )
    for (const part of result.attachments) {
      registerDataTensorAttachment(part.id, part.bytes)
      attachments.push(part.id)
    }
    rules.push({ label: `particles.${member}`, target: [], methodId: 'fixture', parameters: {}, result: schema })
    data[`particles.${member}`] = result.tensor
  }
  const contracts: RecordedResultContracts = {
    particles: {
      task: 'motion',
      output: 'particles',
      solver: { name: 'fixture', version: '1' },
      artifactType: 'fixture@1',
      catalogRevision: 'fixture',
      schema: {},
      visualization: {
        kind: 'particle-set',
        coordinateSpace: 'experiment',
        particleSet: {
          positions: 'positions',
          particleIds: 'particleIds',
          materialIndices: 'materialIndices',
          materialNames: 'materialNames',
          times: 'times',
          attributes: {
            velocity: { path: 'velocity', components: ['x', 'y', 'z'] },
            radius: { path: 'radius' },
            stress: { path: 'stress', components: tensorComponents },
          },
          radius: 'radius',
        },
      },
    },
  }
  return { rules, data: data as RecordedData, contracts, attachments }
}

describe('particle visualization contracts', () => {
  it.each([2, 2000])('restores %i time samples through inline and attachment tensors', (samples) => {
    const input = fixture(samples)
    try {
      const result = parseRecordedParticleSets(input.rules, input.data, input.contracts)
      expect(result.errors).toEqual([])
      expect(input.attachments.length > 0).toBe(samples === 2000)
      const particles = result.particles[0]
      expect(particles.particleIds).toEqual([90, 2])
      expect(particles.materialNames[particles.materialIndices[0]]).toBe('Steel')
      expect(particles.attributes.velocity.quantityKind).toBe('kinematics.Velocity')
      expect([...particleFrameValues(particles, 'velocity', 'magnitude', 0)]).toEqual([5, 2])
      expect(particles.attributes.stress.components).toEqual(['xx', 'xy', 'xz', 'yx', 'yy', 'yz', 'zx', 'zy', 'zz'])
      expect([...particleFrameValues(particles, 'stress', 5, samples - 1)]).toEqual([6, 0])
      const stressNorm = particleFrameValues(particles, 'stress', 'magnitude', 0)
      expect(stressNorm[0]).toBeCloseTo(Math.sqrt(285), 12)
      expect(stressNorm[1]).toBe(0)
      const spheres = createParticleRenderData(particles, 0, 'm')
      expect(spheres.bounds.min[0]).toBeCloseTo(-0.2)
      expect(spheres.bounds.max[0]).toBeCloseTo(1.1)
      expect(spheres.geometries[0].primitive).toBe('triangles')
      const points = createParticleRenderData({ ...particles, radius: undefined }, 0, 'm', undefined, 9)
      expect(points.geometries[0].primitive).toBe('points')
      expect([...points.geometries[0].pointSizes!]).toEqual([9, 9])
      expect([...points.geometries[0].positions]).toEqual([1, 0, 0, 0, 0, 0])
    } finally {
      releaseDataTensorAttachments(input.attachments)
    }
  })

  it('rejects mismatched particle IDs without discarding another valid result', () => {
    const input = fixture()
    const bad = {
      ...input.data['particles.velocity'],
      axes: [{ ticks: [0, 1] }, { ticks: [2, 90] }, { ticks: ['x', 'y', 'z'] }],
    }
    const result = parseRecordedParticleSets(
      input.rules,
      { ...input.data, 'particles.velocity': bad } as RecordedData,
      input.contracts,
    )
    expect(result.particles).toHaveLength(0)
    expect(result.errors[0].message).toMatch(/declared IDs/)
    expect(parseRecordedParticleSets(input.rules, input.data, input.contracts).particles).toHaveLength(1)
  })

  it('rejects tensor component metadata that would relabel saved values', () => {
    const input = fixture()
    const tensor = input.data['particles.stress']
    const bad = {
      ...tensor,
      axes: [{ ticks: [0, 1] }, { ticks: [90, 2] }, { ticks: ['xx', 'yx', 'xz', 'xy', 'yy', 'yz', 'zx', 'zy', 'zz'] }],
    }
    const result = parseRecordedParticleSets(
      input.rules,
      { ...input.data, 'particles.stress': bad } as RecordedData,
      input.contracts,
    )
    expect(result.particles).toHaveLength(0)
    expect(result.errors[0].message).toMatch(/declared components/)
  })

  it('requires explicit particle paths and forbids particle semantics on another renderer', () => {
    const semantic = fixture().contracts.particles.visualization
    expect(resultVisualizationSchema.safeParse(semantic).success).toBe(true)
    expect(resultVisualizationSchema.safeParse({ kind: 'particle-set' }).success).toBe(false)
    expect(resultVisualizationSchema.safeParse({ ...semantic, kind: 'polyline' }).success).toBe(false)
  })
})
