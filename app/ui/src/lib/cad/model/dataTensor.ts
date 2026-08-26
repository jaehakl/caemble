import type {
  DataDType,
  DataSchema,
  DataTensor,
  DataTensorInput,
  PersistedDataTensor,
  RecordedDataAxis,
  RecordedDataTensor,
} from './descriptor'

export const DATA_TENSOR_INLINE_BYTES = 64 * 1024
export const DATA_TENSOR_ATTACHMENT_SHARD_BYTES = 16 * 1024 * 1024

const attachmentBytes = new Map<string, Uint8Array>()
const numericByteWidths: Readonly<Record<Exclude<DataDType, 'string'>, number>> = Object.freeze({
  bool: 1,
  int8: 1,
  int16: 2,
  int32: 4,
  int64: 8,
  uint8: 1,
  uint16: 2,
  uint32: 4,
  uint64: 8,
  float16: 2,
  float32: 4,
  float64: 8,
})

export type DataTensorAccessor = Readonly<{
  tensor: DataTensor
  shape: readonly number[]
  strides: readonly number[]
  size: number
  byteLength: number
  at: (flatIndex: number) => boolean | string | number
  get: (indices: readonly number[]) => boolean | string | number
  materialize: () => boolean | string | number | readonly unknown[]
  rawBytes: () => Uint8Array
}>

export function isDataTensor(value: unknown): value is DataTensor {
  return typeof value === 'object' && value !== null && 'storage' in value
}

export function registerDataTensorAttachment(id: string, value: ArrayBuffer | Uint8Array): void {
  attachmentBytes.set(id, value instanceof Uint8Array ? value : new Uint8Array(value))
}

export function releaseDataTensorAttachments(ids: readonly string[]): void {
  ids.forEach((id) => attachmentBytes.delete(id))
}

function tensorStrides(shape: readonly number[]): readonly number[] {
  const strides = Array(shape.length).fill(1) as number[]
  for (let index = shape.length - 2; index >= 0; index -= 1) {
    strides[index] = strides[index + 1] * shape[index + 1]
  }
  return Object.freeze(strides)
}

function inferShape(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return Object.freeze([])
  return Object.freeze([value.length, ...(value.length === 0 ? [] : inferShape(value[0]))])
}

function flattenValue(value: unknown, shape: readonly number[]): readonly (boolean | string | number)[] {
  const flat: (boolean | string | number)[] = []
  const visit = (item: unknown, depth: number) => {
    if (depth === shape.length) flat.push(item as boolean | string | number)
    else (item as readonly unknown[]).forEach((child) => visit(child, depth + 1))
  }
  visit(value, 0)
  return flat
}

function float16Bits(value: number): number {
  const float32 = new Float32Array(1)
  const bits = new Uint32Array(float32.buffer)
  float32[0] = value
  const raw = bits[0]
  const sign = (raw >>> 16) & 0x8000
  const exponent = ((raw >>> 23) & 0xff) - 127 + 15
  const mantissa = raw & 0x7fffff
  if (exponent <= 0) {
    if (exponent < -10) return sign
    const shifted = (mantissa | 0x800000) >>> (1 - exponent)
    return sign | ((shifted + 0x1000) >>> 13)
  }
  if (exponent >= 31) return sign | 0x7c00
  return sign | (exponent << 10) | ((mantissa + 0x1000) >>> 13)
}

function float16Number(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1
  const exponent = (bits >>> 10) & 0x1f
  const fraction = bits & 0x03ff
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 31) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

function encodeRaw(value: unknown, shape: readonly number[], dtype: DataDType): Uint8Array {
  if (dtype === 'string') return new TextEncoder().encode(JSON.stringify(value))
  const values = flattenValue(value, shape)
  const width = numericByteWidths[dtype]
  const bytes = new Uint8Array(values.length * width)
  const view = new DataView(bytes.buffer)
  values.forEach((item, index) => {
    const offset = index * width
    const number = dtype === 'bool' ? Number(item) : (item as number)
    switch (dtype) {
      case 'bool':
      case 'uint8': view.setUint8(offset, number); break
      case 'int8': view.setInt8(offset, number); break
      case 'int16': view.setInt16(offset, number, true); break
      case 'uint16': view.setUint16(offset, number, true); break
      case 'int32': view.setInt32(offset, number, true); break
      case 'uint32': view.setUint32(offset, number, true); break
      case 'int64': view.setBigInt64(offset, BigInt(number), true); break
      case 'uint64': view.setBigUint64(offset, BigInt(number), true); break
      case 'float16': view.setUint16(offset, float16Bits(number), true); break
      case 'float32': view.setFloat32(offset, number, true); break
      case 'float64': view.setFloat64(offset, number, true); break
    }
  })
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 32_768)))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function tensorAxes(schema: DataSchema, value: DataTensorInput, shape: readonly number[]): readonly RecordedDataAxis[] {
  return Object.freeze(
    (schema.axes ?? []).map((axis, index) =>
      Object.freeze(value.axes?.[index] ?? { ticks: axis.ticks ?? Array.from({ length: shape[index] }, (_item, tick) => tick) }),
    ),
  )
}

function tensorInput(schema: DataSchema, value: DataTensorInput) {
  const shape = inferShape(value.value)
  const axes = tensorAxes(schema, value, shape)
  const rawBytes = encodeRaw(value.value, shape, schema.dtype)
  return { shape, axes, value: value.value, rawBytes }
}

export function createDataTensor(schema: DataSchema, value: DataTensorInput, _path = 'DataTensor'): DataTensor {
  const normalized = tensorInput(schema, value)
  return Object.freeze({
    shape: normalized.shape,
    ...(normalized.axes.length === 0 ? {} : { axes: normalized.axes }),
    storage: normalized.shape.length === 0 || normalized.rawBytes.byteLength <= DATA_TENSOR_INLINE_BYTES
      ? Object.freeze({ kind: 'inline' as const, value: normalized.value })
      : Object.freeze({ kind: 'base64' as const, data: bytesToBase64(normalized.rawBytes), byteLength: normalized.rawBytes.byteLength }),
  })
}

export function createAttachmentDataTensor(
  schema: DataSchema,
  value: DataTensorInput,
  idPrefix: string,
  _path = 'DataTensor',
): Readonly<{ tensor: DataTensor; attachments: readonly Readonly<{ id: string; bytes: Uint8Array }>[] }> {
  const normalized = tensorInput(schema, value)
  if (normalized.shape.length === 0 || normalized.rawBytes.byteLength <= DATA_TENSOR_INLINE_BYTES) {
    return Object.freeze({
      tensor: Object.freeze({
        shape: normalized.shape,
        ...(normalized.axes.length === 0 ? {} : { axes: normalized.axes }),
        storage: Object.freeze({ kind: 'inline' as const, value: normalized.value }),
      }),
      attachments: Object.freeze([]),
    })
  }
  const attachments = shardDataTensorBytes(normalized.rawBytes, idPrefix)
  return Object.freeze({
    tensor: Object.freeze({
      shape: normalized.shape,
      ...(normalized.axes.length === 0 ? {} : { axes: normalized.axes }),
      storage: Object.freeze({ kind: 'attachments' as const, ids: Object.freeze(attachments.map(({ id }) => id)), byteLength: normalized.rawBytes.byteLength }),
    }),
    attachments,
  })
}

export function shardDataTensorBytes(bytes: Uint8Array, idPrefix: string): readonly Readonly<{ id: string; bytes: Uint8Array }>[] {
  return Object.freeze(
    Array.from({ length: Math.ceil(bytes.byteLength / DATA_TENSOR_ATTACHMENT_SHARD_BYTES) }, (_, index) => Object.freeze({
      id: `${idPrefix}.${index}`,
      bytes: bytes.subarray(index * DATA_TENSOR_ATTACHMENT_SHARD_BYTES, Math.min(bytes.byteLength, (index + 1) * DATA_TENSOR_ATTACHMENT_SHARD_BYTES)),
    })),
  )
}

function concatenateBytes(shards: readonly Uint8Array[]): Uint8Array {
  if (shards.length === 1) return shards[0]
  const result = new Uint8Array(shards.reduce((sum, shard) => sum + shard.byteLength, 0))
  let offset = 0
  shards.forEach((shard) => { result.set(shard, offset); offset += shard.byteLength })
  return result
}

function tensorBytes(tensor: DataTensor, dtype: DataDType): Uint8Array {
  if (tensor.storage.kind === 'inline') return encodeRaw(tensor.storage.value, tensor.shape, dtype)
  if (tensor.storage.kind === 'base64') return base64ToBytes(tensor.storage.data)
  return concatenateBytes(tensor.storage.ids.map((id) => attachmentBytes.get(id)!))
}

function inlineAt(value: unknown, shape: readonly number[], strides: readonly number[], flatIndex: number) {
  let item = value
  let remaining = flatIndex
  shape.forEach((_length, index) => {
    const coordinate = Math.floor(remaining / strides[index])
    remaining %= strides[index]
    item = (item as readonly unknown[])[coordinate]
  })
  return item as boolean | string | number
}

function readRawNumber(dtype: Exclude<DataDType, 'string'>, bytes: Uint8Array, index: number) {
  const width = numericByteWidths[dtype]
  const view = new DataView(bytes.buffer, bytes.byteOffset + index * width, width)
  switch (dtype) {
    case 'bool': return view.getUint8(0) !== 0
    case 'int8': return view.getInt8(0)
    case 'uint8': return view.getUint8(0)
    case 'int16': return view.getInt16(0, true)
    case 'uint16': return view.getUint16(0, true)
    case 'int32': return view.getInt32(0, true)
    case 'uint32': return view.getUint32(0, true)
    case 'int64': return Number(view.getBigInt64(0, true))
    case 'uint64': return Number(view.getBigUint64(0, true))
    case 'float16': return float16Number(view.getUint16(0, true))
    case 'float32': return view.getFloat32(0, true)
    case 'float64': return view.getFloat64(0, true)
  }
}

export function createDataTensorAccessor(schema: DataSchema, value: RecordedDataTensor, _path = 'DataTensor'): DataTensorAccessor {
  const tensor = value
  const rawBytes = tensorBytes(tensor, schema.dtype)
  const strides = tensorStrides(tensor.shape)
  const size = tensor.shape.reduce((product, length) => product * length, 1)
  const inlineValue = tensor.storage.kind === 'inline'
    ? tensor.storage.value
    : schema.dtype === 'string'
      ? JSON.parse(new TextDecoder().decode(rawBytes))
      : undefined
  const at = (flatIndex: number): boolean | string | number => inlineValue === undefined
    ? readRawNumber(schema.dtype as Exclude<DataDType, 'string'>, rawBytes, flatIndex)
    : inlineAt(inlineValue, tensor.shape, strides, flatIndex)
  const get = (indices: readonly number[]) => at(indices.reduce((flatIndex, index, dimension) => flatIndex + index * strides[dimension], 0))
  const materialize = (depth = 0, indices: number[] = []): boolean | string | number | readonly unknown[] => {
    if (depth === tensor.shape.length) return get(indices)
    return Object.freeze(Array.from({ length: tensor.shape[depth] }, (_, index) => materialize(depth + 1, [...indices, index])))
  }
  return Object.freeze({ tensor, shape: tensor.shape, strides, size, byteLength: rawBytes.byteLength, at, get, materialize, rawBytes: () => rawBytes })
}

export function persistDataTensor(schema: DataSchema, value: RecordedDataTensor | DataTensorInput, path = 'DataTensor'): PersistedDataTensor {
  const accessor = createDataTensorAccessor(schema, isDataTensor(value) ? value : createDataTensor(schema, value, path), path)
  return Object.freeze({
    shape: accessor.shape,
    ...(accessor.tensor.axes === undefined ? {} : { axes: accessor.tensor.axes }),
    storage: accessor.shape.length === 0 || accessor.byteLength <= DATA_TENSOR_INLINE_BYTES
      ? Object.freeze({ kind: 'inline' as const, value: accessor.materialize() })
      : Object.freeze({ kind: 'base64' as const, data: bytesToBase64(accessor.rawBytes()), byteLength: accessor.byteLength }),
  })
}

export function persistDataSchema(schema: DataSchema): DataSchema {
  return structuredClone(schema)
}
