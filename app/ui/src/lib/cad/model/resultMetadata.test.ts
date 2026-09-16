// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertResultMetadata, type ResultMetadataSchema } from '@/contracts/resultMetadata'
import { BOX_GRID_AXES } from '@/contracts/boxGrid'
import {
  createAttachmentDataTensor,
  createDataTensorAccessor,
  persistDataTensor,
  registerDataTensorAttachment,
  releaseDataTensorAttachments,
} from '@/lib/cad/model/dataTensor'
import type { DataSchema, RecordedDataRule } from '@/lib/cad/model/descriptor'
import { createCalculationInput } from '@/lib/calculation/input'
import { assertCalculationInput } from '@/lib/calculation/validation'

const metadataSchema: ResultMetadataSchema = {
  pressureOffset: { dtype: 'float64', quantityKind: 'Pressure', unit: 'Pa' },
  momentOrigin: { dtype: 'float64', quantityKind: 'Length', unit: 'm', shape: [3] },
  contribution: { dtype: 'string', values: ['total', 'pressure', 'viscous'] },
  surfaceTargets: { dtype: 'string', shape: [null] },
}

describe('declared result metadata', () => {
  it.each([2, 20000])(
    'retains resolved metadata through %i-cell transport, persistence and Calculation copying',
    (count) => {
      const metadata = {
        pressureOffset: -14,
        momentOrigin: [0.2, -0.3, 1],
        contribution: 'total',
        surfaceTargets: ['experiment.surface.wall'],
      }
      const profile = {
        version: 1,
        sampling: 'point',
        components: ['scalar'],
        channels: ['value'],
        channelUnits: ['1'],
      } as const
      const schema = {
        dtype: 'float64',
        quantityKind: 'Dimensionless',
        unit: '1',
        tensorOrder: 0,
        metadata: metadataSchema,
        boxGrid: profile,
        axes: BOX_GRID_AXES.map((name, axis) => ({ name, length: axis === 0 ? count : 1 })),
      } as DataSchema
      const boxGrid = {
        ...profile,
        origin: [0, 0, 0],
        size: [1, 1, 1],
        rotation: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        lengthUnit: 'm',
        gridShape: [count, 1, 1],
        source: 'experiment',
        rootId: 'probe',
      } as const
      const value = Array.from({ length: count }, () => [[[[[[-2]]]]]])
      const prepared = createAttachmentDataTensor(schema, { value, boxGrid, metadata }, `metadata-${count}`)
      const ids = prepared.attachments.map(({ id, bytes }) => {
        registerDataTensorAttachment(id, bytes)
        return id
      })
      try {
        expect(prepared.tensor.storage.kind).toBe(count > 2 ? 'attachments' : 'inline')
        metadata.momentOrigin[0] = 99
        expect(prepared.tensor.metadata?.momentOrigin).toEqual([0.2, -0.3, 1])
        const saved = JSON.parse(JSON.stringify(persistDataTensor(schema, prepared.tensor)))
        const restored = createDataTensorAccessor(schema, saved)
        expect(restored.at(count - 1)).toBe(-2)
        expect(restored.tensor.metadata).toEqual(prepared.tensor.metadata)
        const rule: RecordedDataRule = {
          label: 'load',
          result: schema,
          methodId: 'fixture',
          target: [],
          parameters: {},
        }
        const input = createCalculationInput([rule], { load: saved })
        expect(input.load.metadata).toEqual(prepared.tensor.metadata)
        expect(input.load.metadataSchema).toEqual(metadataSchema)
        expect(Object.isFrozen(input.load.metadata?.momentOrigin)).toBe(true)
        expect(Object.isFrozen(input.load.metadataSchema?.momentOrigin.shape)).toBe(true)
        saved.metadata.momentOrigin[0] = 50
        expect(input.load.metadata?.momentOrigin).toEqual([0.2, -0.3, 1])
        const offline = JSON.parse(JSON.stringify(input))
        assertCalculationInput(offline)
        const invalid = {
          ...offline,
          load: { ...offline.load, metadata: { ...offline.load.metadata, pressureOffset: Number.NaN } },
        }
        expect(() => assertCalculationInput(invalid)).toThrow('metadata')
      } finally {
        releaseDataTensorAttachments(ids)
      }
    },
  )

  it.each([
    {},
    { pressureOffset: 0, momentOrigin: [0, 0], contribution: 'total', surfaceTargets: [] },
    { pressureOffset: 0, momentOrigin: [0, 0, 0], contribution: 'unknown', surfaceTargets: [] },
    { pressureOffset: 0, momentOrigin: [0, 0, 0], contribution: 'total', surfaceTargets: [1] },
    { pressureOffset: 0, momentOrigin: [0, 0, 0], contribution: 'total', surfaceTargets: [], extra: true },
  ])('rejects missing, malformed and undeclared metadata', (value) => {
    expect(() => assertResultMetadata(metadataSchema, value)).toThrow('metadata')
  })
})
