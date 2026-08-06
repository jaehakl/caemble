import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { DataDType, DataSchema, DataTensor, LegacyRecordedDataTensor } from './descriptor'
import {
  DATA_TENSOR_ATTACHMENT_SHARD_BYTES,
  createDataTensor,
  createDataTensorAccessor,
  persistDataSchema,
  persistDataTensor,
  registerDataTensorAttachment,
  releaseDataTensorAttachments,
  shardDataTensorBytes,
} from './dataTensor'

const goldenFixture = JSON.parse(
  readFileSync(new URL('./fixtures/data-schema-golden.v1.json', import.meta.url), 'utf8'),
) as Readonly<{
  fixtureVersion: number
  cases: readonly Readonly<{
    name: string
    schema: unknown
    input: unknown
    expected: Readonly<{
      shape: readonly number[]
      axes?: unknown
      rawHex: string
      materialized: unknown
    }>
  }>[]
  invalidCases: readonly Readonly<{
    name: string
    schema: unknown
    input: unknown
    issue: string
  }>[]
}>

function schema(dtype: DataDType, length?: number): DataSchema {
  const axes = length === undefined ? undefined : [{ length }]
  return (
    dtype.startsWith('float')
      ? { dtype, unit: '{fraction}', quantityKind: 'DimensionlessRatio', ...(axes ? { axes } : {}) }
      : { dtype, ...(axes ? { axes } : {}) }
  ) as DataSchema
}

function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('DataTensor codec', () => {
  it('matches the local UTF-8 DataSchema golden fixture', () => {
    expect(goldenFixture.fixtureVersion).toBe(1)

    goldenFixture.cases.forEach((fixture) => {
      const dataSchema = fixture.schema as DataSchema
      const tensor = createDataTensor(dataSchema, fixture.input as LegacyRecordedDataTensor, fixture.name)
      const accessor = createDataTensorAccessor(dataSchema, tensor, fixture.name)

      expect(accessor.shape, fixture.name).toEqual(fixture.expected.shape)
      expect(accessor.tensor.axes, fixture.name).toEqual(fixture.expected.axes)
      expect(hex(accessor.rawBytes()), fixture.name).toBe(fixture.expected.rawHex)
      expect(accessor.materialize(), fixture.name).toEqual(fixture.expected.materialized)
    })

    goldenFixture.invalidCases.forEach((fixture) => {
      expect(
        () =>
          createDataTensor(
            fixture.schema as DataSchema,
            fixture.input as LegacyRecordedDataTensor,
            fixture.name,
          ),
        fixture.name,
      ).toThrow(fixture.issue)
    })
  })

  it('persists scalar values as versioned inline tensors', () => {
    const dataSchema = schema('float64')
    const persisted = persistDataTensor(dataSchema, { value: 2.5 })

    expect(persisted).toEqual({
      tensorEncodingVersion: 1,
      shape: [],
      storage: { kind: 'inline', value: 2.5 },
    })
    expect(createDataTensorAccessor(dataSchema, persisted).get([])).toBe(2.5)
  })

  it('persists DataSchema metadata and keeps fixed axis ticks aligned with the DataTensor', () => {
    const dataSchema = {
      dtype: 'float32',
      unit: 'A.m-2',
      quantityKind: 'electromagnetism.ElectricCurrentDensity',
      basis: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      axes: [{ name: '위치', length: 2, unit: 'm', quantityKind: 'Length', ticks: ['앞', '뒤'] }],
    } as const satisfies DataSchema
    const tensor = persistDataTensor(dataSchema, {
      value: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    })

    expect(persistDataSchema(dataSchema)).toEqual({
      dtype: 'float32',
      unit: 'A.m-2',
      quantityKind: 'electromagnetism.ElectricCurrentDensity',
      basis: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      axes: [{ name: '위치', length: 2, unit: 'm', quantityKind: 'Length', ticks: ['앞', '뒤'] }],
    })
    expect(tensor.axes).toEqual([{ ticks: ['앞', '뒤'] }])
  })

  it.each([
    ['float16', [1.5, -2.25]],
    ['float32', [1.25, -3.5]],
    ['float64', [Math.PI, -Math.E]],
    ['int8', [-128, 127]],
    ['int16', [-32_768, 32_767]],
    ['int32', [-2_147_483_648, 2_147_483_647]],
    ['int64', [-(2 ** 53 - 1), 2 ** 53 - 1]],
    ['uint8', [0, 255]],
    ['uint16', [0, 65_535]],
    ['uint32', [0, 4_294_967_295]],
    ['uint64', [0, 2 ** 53 - 1]],
    ['bool', [true, false]],
    ['string', ['한글', 'tensor']],
  ] satisfies readonly [DataDType, readonly (boolean | number | string)[]][])(
    'round-trips %s values',
    (dtype, values) => {
      const dataSchema = schema(dtype, values.length)
      const persisted = persistDataTensor(dataSchema, { value: values })
      const accessor = createDataTensorAccessor(dataSchema, persisted)
      const actual = Array.from({ length: accessor.size }, (_, index) => accessor.at(index))

      if (dtype.startsWith('float')) {
        actual.forEach((value, index) => expect(value as number).toBeCloseTo(values[index] as number, 3))
      } else {
        expect(actual).toEqual(values)
      }
    },
  )

  it('reads little-endian raw bytes without a NumPy header', () => {
    const bytes = new Uint8Array(8)
    const view = new DataView(bytes.buffer)
    view.setFloat32(0, 1.5, true)
    view.setFloat32(4, -2.25, true)
    const tensor: DataTensor = {
      shape: [2],
      storage: { kind: 'base64', data: base64(bytes), byteLength: bytes.byteLength },
    }
    const accessor = createDataTensorAccessor(schema('float32', 2), tensor)

    expect(accessor.at(0)).toBe(1.5)
    expect(accessor.at(1)).toBe(-2.25)
  })

  it('validates dynamic axes and QuantityKind component shape', () => {
    const dataSchema = {
      dtype: 'float32',
      unit: 'A.m-2',
      quantityKind: 'electromagnetism.ElectricCurrentDensity',
      axes: [{ name: 'sample' }],
    } satisfies DataSchema
    const bytes = new Uint8Array(6 * 4)
    const view = new DataView(bytes.buffer)
    ;[1, 2, 3, 4, 5, 6].forEach((value, index) => view.setFloat32(index * 4, value, true))
    const tensor: DataTensor = {
      shape: [2, 3],
      axes: [{ ticks: ['앞', '뒤'] }],
      storage: { kind: 'base64', data: base64(bytes), byteLength: bytes.byteLength },
    }

    expect(createDataTensorAccessor(dataSchema, tensor).get([1, 2])).toBe(6)
    expect(() => createDataTensorAccessor(dataSchema, { ...tensor, shape: [2, 2] })).toThrow(
      /expected 3 from the DataSchema/,
    )
    expect(() => createDataTensorAccessor(dataSchema, { ...tensor, axes: [{ ticks: ['only'] }] })).toThrow(
      /exactly 2 values/,
    )
    expect(() => createDataTensorAccessor(dataSchema, { ...tensor, axes: undefined })).toThrow(
      /required for a dynamic DataSchema axis/,
    )
  })

  it('uses 16 MiB attachment shards and rejects malformed shard layouts', () => {
    const bytes = new Uint8Array(DATA_TENSOR_ATTACHMENT_SHARD_BYTES + 7)
    const shards = shardDataTensorBytes(bytes, 'run.record')
    expect(shards.map((shard) => shard.bytes.byteLength)).toEqual([DATA_TENSOR_ATTACHMENT_SHARD_BYTES, 7])

    registerDataTensorAttachment('bad.0', new Uint8Array([1]))
    registerDataTensorAttachment('bad.1', new Uint8Array([2]))
    try {
      expect(() =>
        createDataTensorAccessor(schema('uint8', 2), {
          shape: [2],
          storage: { kind: 'attachments', ids: ['bad.0', 'bad.1'], byteLength: 2 },
        }),
      ).toThrow(/must be a full 16777216-byte shard/)
    } finally {
      releaseDataTensorAttachments(['bad.0', 'bad.1'])
    }
  })

  it('rejects malformed byte length, bool values, non-finite data, and oversized persistence', () => {
    expect(() =>
      createDataTensorAccessor(schema('float64', 2), {
        shape: [2],
        storage: { kind: 'base64', data: base64(new Uint8Array(8)), byteLength: 8 },
      }),
    ).toThrow(/expected product\(shape\).*16/)
    expect(() =>
      createDataTensorAccessor(schema('bool', 1), {
        shape: [1],
        storage: { kind: 'base64', data: base64(new Uint8Array([2])), byteLength: 1 },
      }),
    ).toThrow(/bool bytes must be 0 or 1/)

    const nonFinite = new Uint8Array(8)
    new DataView(nonFinite.buffer).setFloat64(0, Number.NaN, true)
    expect(() =>
      createDataTensorAccessor(schema('float64', 1), {
        shape: [1],
        storage: { kind: 'base64', data: base64(nonFinite), byteLength: 8 },
      }),
    ).toThrow(/finite float64/)
    expect(() => createDataTensor(schema('uint8', 2), { value: [0, 256] })).toThrow(/uint8 safe integer/)

    const oversizedInline = Array.from({ length: 65_537 }, () => 0)
    expect(() =>
      createDataTensorAccessor(schema('uint8', oversizedInline.length), {
        shape: [oversizedInline.length],
        storage: { kind: 'inline', value: oversizedInline },
      }),
    ).toThrow(/inline data exceeds 65536 bytes/)
  })
})
