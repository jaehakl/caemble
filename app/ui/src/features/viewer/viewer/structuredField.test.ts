import { describe, expect, it } from 'vitest'
import {
  createAttachmentDataTensor,
  createDataTensor,
  createDataTensorAccessor,
  persistDataTensor,
  registerDataTensorAttachment,
  releaseDataTensorAttachments,
} from '@/lib/cad/model/dataTensor'
import type { DataSchema } from '@/lib/cad/model/descriptor'
import { executeCalculation } from '@/lib/calculation/execute'
import { fieldRange, fieldScalar, fieldSlice, structuredField } from './structuredField'

const schema: DataSchema = {
  dtype: 'complex64',
  quantityKind: 'electromagnetism.ElectricFieldStrength',
  unit: 'V.m-1',
  axes: [
    { name: 'frequency', quantityKind: 'Frequency', unit: 'Hz' },
    ...['z', 'y', 'x'].map((name) => ({ name, quantityKind: 'Length', unit: 'm' })),
  ],
}

describe('complex field records', () => {
  it('round trips inline, attachments and offline base64 with eight bytes per logical element', () => {
    const vector: DataSchema = { dtype: 'complex64', quantityKind: 'Length', unit: 'm', axes: [{ name: 'sample' }] }
    const scalar = { re: 1.2, im: -3.4 }
    const small = createDataTensor(vector, { value: [scalar] })
    expect(small.shape).toEqual([1])
    expect(createDataTensorAccessor(vector, small).at(0)).toEqual({ re: Math.fround(1.2), im: Math.fround(-3.4) })
    const large = createAttachmentDataTensor(
      vector,
      { value: Array.from({ length: 9000 }, () => scalar) },
      'complex-test',
    )
    large.attachments.forEach(({ id, bytes }) => registerDataTensorAttachment(id, bytes))
    try {
      const exported = JSON.parse(JSON.stringify(persistDataTensor(vector, large.tensor)))
      expect(exported.storage.byteLength).toBe(9000 * 8)
      const accessor = createDataTensorAccessor(vector, exported)
      expect(accessor.at(8999)).toEqual({ re: Math.fround(1.2), im: Math.fround(-3.4) })
      expect(new DataView(accessor.rawBytes().buffer).getFloat32(4, true)).toBe(Math.fround(-3.4))
    } finally {
      releaseDataTensorAttachments(large.attachments.map(({ id }) => id))
    }
    expect(() => createDataTensor(vector, { value: [2] })).toThrow(/re, im/)
  })

  it('passes Math.js Complex to Calculation and requires an explicit real output projection', () => {
    const input = {
      field: { dtype: 'complex64' as const, shape: [], data: { re: 3, im: 4 }, axes: [], tensorOrder: 0 },
    }
    const result = executeCalculation(
      {
        sourceHash: 'fixture',
        code: `module.exports.default = (record) => { if (!record.field.data.isComplex) throw Error('Not Complex'); return { dtype: 'float64', data: require('mathjs').abs(record.field.data) } }`,
      },
      input,
      () => {},
    )
    expect(result.data).toBe(5)
    expect(() =>
      executeCalculation(
        {
          sourceHash: 'fixture',
          code: `module.exports.default = (record) => ({ dtype: 'float64', data: record.field.data })`,
        },
        input,
        () => {},
      ),
    ).toThrow()
  })

  it('preserves frequency order, all components, spatial units and the recorded slice plane', () => {
    const value = createDataTensor(schema, {
      value: [
        [
          [
            [
              [
                { re: 3, im: 4 },
                { re: 0, im: 2 },
                { re: 0, im: 0 },
              ],
            ],
          ],
        ],
        [
          [
            [
              [
                { re: 7, im: 0 },
                { re: 0, im: 0 },
                { re: 0, im: 1 },
              ],
            ],
          ],
        ],
      ],
      axes: [
        { ticks: [3e14, 2e14] },
        { ticks: [-1e-6], bounds: [-1.1e-6, -0.9e-6] },
        { ticks: [0], bounds: [-2e-6, 2e-6] },
        { ticks: [0], bounds: [-3e-6, 3e-6] },
      ],
    })
    const field = structuredField(
      schema,
      value,
      {
        kind: 'structured-field',
        components: ['Ex', 'Ey', 'Ez'],
        grid: { xyzAxes: [3, 2, 1], sampleAxis: 0, sampleKind: 'frequency', componentAxis: 4 },
      },
      'um',
    )
    expect(field.sampleTicks).toEqual([3e14, 2e14])
    expect(fieldScalar(field, [0, 0, 0], 0, -1, 'abs')).toBeCloseTo(Math.sqrt(29))
    expect(fieldScalar(field, [0, 0, 0], 1, 2, 'im')).toBe(1)
    expect(fieldScalar(field, [0, 0, 0], 0, 2, 'arg')).toBeNaN()
    expect(fieldRange(field, 1, 0, 're')).toEqual([7, 7])
    const slice = fieldSlice(field, 'arbitrary', 2, 0, 1, 0, 're', [0, 7], 0.8)
    expect([...slice.geometries[0].positions]).toEqual([-3, -2, -1, 3, -2, -1, 3, 2, -1, -3, 2, -1])
    expect(slice.geometries[0].colors[3]).toBeCloseTo(0.8)
    expect(fieldSlice(field, 'arbitrary', 2, 0, 0, 2, 'arg', [-Math.PI, Math.PI], 0.8).geometries).toHaveLength(0)
  })
})
