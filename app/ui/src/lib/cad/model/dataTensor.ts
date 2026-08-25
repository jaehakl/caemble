import { getQuantityKindComponentShape } from '../../quantitykind/runtime'
import { CadModelError, normalizeDataElement, normalizeDataValue } from './core'
import type {
  DataDType,
  DataSchema,
  DataTensor,
  LegacyRecordedDataTensor,
  PersistedDataTensor,
  RecordedDataAxis,
  RecordedDataTensor,
} from './descriptor'

export const DATA_TENSOR_INLINE_BYTES = 64 * 1024
export const DATA_TENSOR_ATTACHMENT_SHARD_BYTES = 16 * 1024 * 1024
export const MAX_RECORDED_DATA_BYTES = 64 * 1024 * 1024

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
}

export function isDataTensor(value: unknown): value is DataTensor {
  return (
    isPlainObject(value) &&
    Array.isArray(value.shape) &&
    isPlainObject(value.storage) &&
    ['inline', 'attachments', 'base64'].includes(String(value.storage.kind))
  )
}

export function registerDataTensorAttachment(id: string, value: ArrayBuffer | Uint8Array): void {
  if (!id) throw new CadModelError('DataTensor attachment id must not be empty.')
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (bytes.byteLength > DATA_TENSOR_ATTACHMENT_SHARD_BYTES) {
    throw new CadModelError(
      `DataTensor attachment ${JSON.stringify(id)} is ${bytes.byteLength} bytes; maximum shard size is ${DATA_TENSOR_ATTACHMENT_SHARD_BYTES}.`,
    )
  }
  attachmentBytes.set(id, bytes)
}

export function releaseDataTensorAttachments(ids: readonly string[]): void {
  ids.forEach((id) => attachmentBytes.delete(id))
}

function tensorSize(shape: readonly number[], path: string): number {
  let size = 1
  shape.forEach((length, index) => {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new CadModelError(`${path}.shape[${index}] must be a non-negative safe integer.`)
    }
    size *= length
    if (!Number.isSafeInteger(size)) throw new CadModelError(`${path}.shape is too large.`)
  })
  return size
}

function tensorStrides(shape: readonly number[]): readonly number[] {
  const strides = Array(shape.length).fill(1) as number[]
  for (let index = shape.length - 2; index >= 0; index -= 1) {
    strides[index] = strides[index + 1] * shape[index + 1]
  }
  return Object.freeze(strides)
}

function expectedStorageShape(schema: DataSchema): readonly number[] {
  const components = schema.quantityKind === undefined ? [] : getQuantityKindComponentShape(schema.quantityKind)
  return Object.freeze([...(schema.axes ?? []).map((axis) => axis.length ?? -1), ...components])
}

function validateShape(schema: DataSchema, shape: readonly number[], path: string): void {
  tensorSize(shape, path)
  const expected = expectedStorageShape(schema)
  if (shape.length !== expected.length) {
    throw new CadModelError(
      `${path}.shape has rank ${shape.length}; expected ${expected.length} from schema axes and QuantityKind components.`,
    )
  }
  expected.forEach((length, index) => {
    if (length !== -1 && shape[index] !== length) {
      throw new CadModelError(`${path}.shape[${index}] is ${shape[index]}; expected ${length} from the DataSchema.`)
    }
  })
}

function normalizeAxes(
  schema: DataSchema,
  value: unknown,
  shape: readonly number[],
  path: string,
  requireDynamicTicks: boolean,
): readonly RecordedDataAxis[] {
  const schemaAxes = schema.axes ?? []
  if (value !== undefined && !Array.isArray(value)) {
    throw new CadModelError(`${path}.axes must be an array when provided.`)
  }
  if (Array.isArray(value) && value.length !== schemaAxes.length) {
    throw new CadModelError(`${path}.axes has length ${value.length}; expected ${schemaAxes.length}.`)
  }
  if (schemaAxes.length === 0) {
    if (Array.isArray(value) && value.length > 0) throw new CadModelError(`${path}.axes must be omitted for a scalar.`)
    return Object.freeze([])
  }

  const axes = (value ?? Array.from({ length: schemaAxes.length }, () => ({}))) as readonly unknown[]
  return Object.freeze(
    axes.map((rawAxis, axisIndex) => {
      const axisPath = `${path}.axes[${axisIndex}]`
      if (
        !isPlainObject(rawAxis) ||
        Reflect.ownKeys(rawAxis).some((key) => key !== 'ticks' && key !== 'implicitOrdinal')
      ) {
        throw new CadModelError(`${axisPath} must contain optional ticks or implicitOrdinal only.`)
      }
      const schemaAxis = schemaAxes[axisIndex]
      const actualLength = shape[axisIndex]
      if (rawAxis.implicitOrdinal !== undefined) {
        if (rawAxis.implicitOrdinal !== true) {
          throw new CadModelError(`${axisPath}.implicitOrdinal must be true when present.`)
        }
        if (rawAxis.ticks !== undefined) {
          throw new CadModelError(`${axisPath} cannot contain both ticks and implicitOrdinal.`)
        }
        if (schemaAxis.length !== undefined || schemaAxis.ticks !== undefined) {
          throw new CadModelError(`${axisPath}.implicitOrdinal is allowed only for a dynamic DataSchema axis.`)
        }
        return Object.freeze({ implicitOrdinal: true as const })
      }
      const ticks = rawAxis.ticks ?? schemaAxis.ticks
      if (ticks === undefined) {
        if (requireDynamicTicks && schemaAxis.length === undefined) {
          throw new CadModelError(`${axisPath}.ticks is required for a dynamic DataSchema axis.`)
        }
        return Object.freeze({ ticks: Object.freeze(Array.from({ length: actualLength }, (_, index) => index)) })
      }
      if (!Array.isArray(ticks) || ticks.length !== actualLength) {
        throw new CadModelError(`${axisPath}.ticks must contain exactly ${actualLength} values.`)
      }
      const normalized = Object.freeze(
        ticks.map((tick, tickIndex) => {
          if (typeof tick === 'string' || (typeof tick === 'number' && Number.isFinite(tick))) return tick
          throw new CadModelError(`${axisPath}.ticks[${tickIndex}] must be a string or finite number.`)
        }),
      )
      if (schemaAxis.ticks && JSON.stringify(normalized) !== JSON.stringify(schemaAxis.ticks)) {
        throw new CadModelError(`${axisPath}.ticks does not match the fixed DataSchema ticks.`)
      }
      return Object.freeze({ ticks: normalized })
    }),
  )
}

function inferShape(value: unknown, path: string, ancestors = new Set<unknown>()): readonly number[] {
  if (!Array.isArray(value)) return Object.freeze([])
  if (ancestors.has(value)) throw new CadModelError(`${path} must not be circular.`)
  if (value.length === 0) return Object.freeze([0])
  ancestors.add(value)
  const childShapes = value.map((item, index) => inferShape(item, `${path}[${index}]`, ancestors))
  ancestors.delete(value)
  const first = JSON.stringify(childShapes[0])
  if (childShapes.some((shape) => JSON.stringify(shape) !== first)) {
    throw new CadModelError(`${path} must not be ragged.`)
  }
  return Object.freeze([value.length, ...childShapes[0]])
}

function flattenValue(value: unknown, shape: readonly number[]): readonly (boolean | string | number)[] {
  const flat: (boolean | string | number)[] = []
  const visit = (item: unknown, depth: number) => {
    if (depth === shape.length) {
      flat.push(item as boolean | string | number)
      return
    }
    ;(item as readonly unknown[]).forEach((child) => visit(child, depth + 1))
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
      case 'uint8':
        view.setUint8(offset, number)
        break
      case 'int8':
        view.setInt8(offset, number)
        break
      case 'int16':
        view.setInt16(offset, number, true)
        break
      case 'uint16':
        view.setUint16(offset, number, true)
        break
      case 'int32':
        view.setInt32(offset, number, true)
        break
      case 'uint32':
        view.setUint32(offset, number, true)
        break
      case 'int64':
        view.setBigInt64(offset, BigInt(number), true)
        break
      case 'uint64':
        view.setBigUint64(offset, BigInt(number), true)
        break
      case 'float16':
        view.setUint16(offset, float16Bits(number), true)
        break
      case 'float32':
        view.setFloat32(offset, number, true)
        break
      case 'float64':
        view.setFloat64(offset, number, true)
        break
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

function base64ToBytes(value: string, path: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new CadModelError(`${path} must be canonical base64.`)
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new CadModelError(`${path} must be valid base64.`)
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function normalizeLegacyTensor(schema: DataSchema, value: LegacyRecordedDataTensor, path: string) {
  if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, 'value')) {
    throw new CadModelError(`${path} must contain value and optional axes.`)
  }
  if (Reflect.ownKeys(value).some((key) => key !== 'value' && key !== 'axes')) {
    throw new CadModelError(`${path} must contain value and optional axes only.`)
  }
  const shape = inferShape(value.value, `${path}.value`)
  validateShape(schema, shape, path)
  const normalizedValue = normalizeDataValue(value.value, shape, schema.dtype, `${path}.value`)
  const axes = normalizeAxes(schema, value.axes, shape, path, false)
  return { shape, axes, value: normalizedValue, rawBytes: encodeRaw(normalizedValue, shape, schema.dtype) }
}

export function createDataTensor(schema: DataSchema, value: LegacyRecordedDataTensor, path = 'DataTensor'): DataTensor {
  const normalized = normalizeLegacyTensor(schema, value, path)
  const scalar = normalized.shape.length === 0
  return Object.freeze({
    shape: normalized.shape,
    ...(normalized.axes.length === 0 ? {} : { axes: normalized.axes }),
    storage:
      scalar || normalized.rawBytes.byteLength <= DATA_TENSOR_INLINE_BYTES
        ? Object.freeze({ kind: 'inline' as const, value: normalized.value })
        : Object.freeze({
            kind: 'base64' as const,
            data: bytesToBase64(normalized.rawBytes),
            byteLength: normalized.rawBytes.byteLength,
          }),
  })
}

export function createAttachmentDataTensor(
  schema: DataSchema,
  value: LegacyRecordedDataTensor,
  idPrefix: string,
  path = 'DataTensor',
): Readonly<{
  tensor: DataTensor
  attachments: readonly Readonly<{ id: string; bytes: Uint8Array }>[]
}> {
  const normalized = normalizeLegacyTensor(schema, value, path)
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
      storage: Object.freeze({
        kind: 'attachments' as const,
        ids: Object.freeze(attachments.map((attachment) => attachment.id)),
        byteLength: normalized.rawBytes.byteLength,
      }),
    }),
    attachments,
  })
}

export function shardDataTensorBytes(
  bytes: Uint8Array,
  idPrefix: string,
): readonly Readonly<{ id: string; bytes: Uint8Array }>[] {
  if (!idPrefix) throw new CadModelError('DataTensor attachment id prefix must not be empty.')
  return Object.freeze(
    Array.from({ length: Math.ceil(bytes.byteLength / DATA_TENSOR_ATTACHMENT_SHARD_BYTES) }, (_, index) =>
      Object.freeze({
        id: `${idPrefix}.${index}`,
        bytes: bytes.subarray(
          index * DATA_TENSOR_ATTACHMENT_SHARD_BYTES,
          Math.min(bytes.byteLength, (index + 1) * DATA_TENSOR_ATTACHMENT_SHARD_BYTES),
        ),
      }),
    ),
  )
}

function validateTensorKeys(tensor: DataTensor, path: string): void {
  const allowed = new Set(['shape', 'axes', 'storage', 'tensorEncodingVersion'])
  const invalid = Reflect.ownKeys(tensor).filter((key) => typeof key !== 'string' || !allowed.has(key))
  if (invalid.length > 0) throw new CadModelError(`${path} contains unsupported fields: ${invalid.join(', ')}.`)
  if ('tensorEncodingVersion' in tensor && tensor.tensorEncodingVersion !== 1) {
    throw new CadModelError(`${path}.tensorEncodingVersion must be 1.`)
  }
  const storageKeys = Reflect.ownKeys(tensor.storage)
  const expectedStorageKeys =
    tensor.storage.kind === 'inline'
      ? ['kind', 'value']
      : tensor.storage.kind === 'attachments'
        ? ['kind', 'ids', 'byteLength']
        : ['kind', 'data', 'byteLength']
  if (
    storageKeys.length !== expectedStorageKeys.length ||
    storageKeys.some((key) => typeof key !== 'string' || !expectedStorageKeys.includes(key))
  ) {
    throw new CadModelError(`${path}.storage contains invalid fields for ${tensor.storage.kind} storage.`)
  }
}

function rawTensorBytes(tensor: DataTensor, dtype: DataDType, path: string): readonly Uint8Array[] {
  if (tensor.storage.kind === 'inline') {
    return Object.freeze([encodeRaw(tensor.storage.value, tensor.shape, dtype)])
  }
  if (!Number.isSafeInteger(tensor.storage.byteLength) || tensor.storage.byteLength < 0) {
    throw new CadModelError(`${path}.storage.byteLength must be a non-negative safe integer.`)
  }
  if (tensor.storage.kind === 'base64') {
    const bytes = base64ToBytes(tensor.storage.data, `${path}.storage.data`)
    if (bytes.byteLength !== tensor.storage.byteLength) {
      throw new CadModelError(
        `${path}.storage decoded ${bytes.byteLength} bytes; declared byteLength is ${tensor.storage.byteLength}.`,
      )
    }
    return Object.freeze([bytes])
  }
  const storage = tensor.storage
  if (storage.ids.length === 0 && storage.byteLength > 0) {
    throw new CadModelError(`${path}.storage.ids must contain attachment shards.`)
  }
  const ids = new Set<string>()
  const shards = storage.ids.map((id, index) => {
    if (!id || ids.has(id)) throw new CadModelError(`${path}.storage.ids[${index}] must be a unique non-empty id.`)
    ids.add(id)
    const bytes = attachmentBytes.get(id)
    if (!bytes) throw new CadModelError(`${path} attachment ${JSON.stringify(id)} is not registered.`)
    if (index < storage.ids.length - 1 && bytes.byteLength !== DATA_TENSOR_ATTACHMENT_SHARD_BYTES) {
      throw new CadModelError(
        `${path} attachment ${JSON.stringify(id)} must be a full ${DATA_TENSOR_ATTACHMENT_SHARD_BYTES}-byte shard.`,
      )
    }
    return bytes
  })
  const actual = shards.reduce((sum, bytes) => sum + bytes.byteLength, 0)
  if (actual !== storage.byteLength) {
    throw new CadModelError(
      `${path} attachments contain ${actual} bytes; declared byteLength is ${storage.byteLength}.`,
    )
  }
  return Object.freeze(shards)
}

function concatenateBytes(shards: readonly Uint8Array[]): Uint8Array {
  if (shards.length === 1) return shards[0]
  const result = new Uint8Array(shards.reduce((sum, shard) => sum + shard.byteLength, 0))
  let offset = 0
  shards.forEach((shard) => {
    result.set(shard, offset)
    offset += shard.byteLength
  })
  return result
}

function inlineAt(value: unknown, shape: readonly number[], flatIndex: number) {
  let item = value
  let remaining = flatIndex
  const strides = tensorStrides(shape)
  shape.forEach((_length, index) => {
    const coordinate = Math.floor(remaining / strides[index])
    remaining %= strides[index]
    item = (item as readonly unknown[])[coordinate]
  })
  return item as boolean | string | number
}

function readRawNumber(dtype: Exclude<DataDType, 'string'>, shards: readonly Uint8Array[], index: number) {
  const width = numericByteWidths[dtype]
  const offset = index * width
  let shardOffset = offset
  let shard = shards[0]
  for (const candidate of shards) {
    if (shardOffset < candidate.byteLength) {
      shard = candidate
      break
    }
    shardOffset -= candidate.byteLength
  }
  if (shardOffset + width > shard.byteLength) {
    throw new CadModelError('DataTensor element crosses an invalid attachment shard boundary.')
  }
  const view = new DataView(shard.buffer, shard.byteOffset + shardOffset, width)
  switch (dtype) {
    case 'bool': {
      const value = view.getUint8(0)
      if (value !== 0 && value !== 1) throw new CadModelError('DataTensor bool bytes must be 0 or 1.')
      return value === 1
    }
    case 'int8':
      return view.getInt8(0)
    case 'uint8':
      return view.getUint8(0)
    case 'int16':
      return view.getInt16(0, true)
    case 'uint16':
      return view.getUint16(0, true)
    case 'int32':
      return view.getInt32(0, true)
    case 'uint32':
      return view.getUint32(0, true)
    case 'int64':
    case 'uint64': {
      const bigint = dtype === 'int64' ? view.getBigInt64(0, true) : view.getBigUint64(0, true)
      const value = Number(bigint)
      if (!Number.isSafeInteger(value))
        throw new CadModelError(`DataTensor ${dtype} value exceeds JavaScript safe range.`)
      return value
    }
    case 'float16':
      return float16Number(view.getUint16(0, true))
    case 'float32':
      return view.getFloat32(0, true)
    case 'float64':
      return view.getFloat64(0, true)
  }
}

export function createDataTensorAccessor(
  schema: DataSchema,
  value: RecordedDataTensor,
  path = 'DataTensor',
): DataTensorAccessor {
  const tensor = isDataTensor(value) ? value : createDataTensor(schema, value, path)
  validateTensorKeys(tensor, path)
  validateShape(schema, tensor.shape, path)
  const axes = normalizeAxes(schema, tensor.axes, tensor.shape, path, true)
  const normalizedTensor = Object.freeze({
    ...tensor,
    shape: Object.freeze([...tensor.shape]),
    ...(axes.length === 0 ? { axes: undefined } : { axes }),
  }) as DataTensor
  const size = tensorSize(tensor.shape, path)
  let inlineValue: unknown
  let shards: readonly Uint8Array[]

  if (tensor.storage.kind === 'inline') {
    inlineValue = normalizeDataValue(tensor.storage.value, tensor.shape, schema.dtype, `${path}.storage.value`)
    shards = Object.freeze([encodeRaw(inlineValue, tensor.shape, schema.dtype)])
    if (tensor.shape.length > 0 && shards[0].byteLength > DATA_TENSOR_INLINE_BYTES) {
      throw new CadModelError(`${path}.storage inline data exceeds ${DATA_TENSOR_INLINE_BYTES} bytes.`)
    }
  } else {
    shards = rawTensorBytes(tensor, schema.dtype, path)
    if (schema.dtype === 'string') {
      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatenateBytes(shards)))
      } catch {
        throw new CadModelError(`${path} string storage must contain UTF-8 JSON.`)
      }
      inlineValue = normalizeDataValue(parsed, tensor.shape, schema.dtype, `${path}.storage`)
    } else {
      const expectedByteLength = size * numericByteWidths[schema.dtype]
      const actualByteLength = shards.reduce((sum, shard) => sum + shard.byteLength, 0)
      if (expectedByteLength !== actualByteLength) {
        throw new CadModelError(
          `${path} has ${actualByteLength} raw bytes; expected product(shape) × dtype width = ${expectedByteLength}.`,
        )
      }
    }
  }

  const strides = tensorStrides(tensor.shape)
  const at = (flatIndex: number): boolean | string | number => {
    if (!Number.isSafeInteger(flatIndex) || flatIndex < 0 || flatIndex >= size) {
      throw new CadModelError(`${path} flat index ${flatIndex} is out of bounds for ${size} elements.`)
    }
    const element =
      inlineValue !== undefined
        ? inlineAt(inlineValue, tensor.shape, flatIndex)
        : readRawNumber(schema.dtype as Exclude<DataDType, 'string'>, shards, flatIndex)
    return normalizeDataElement(element, schema.dtype, `${path}[${flatIndex}]`)
  }
  if (inlineValue === undefined) {
    for (let index = 0; index < size; index += 1) at(index)
  }
  const get = (indices: readonly number[]) => {
    if (indices.length !== tensor.shape.length) {
      throw new CadModelError(`${path} requires ${tensor.shape.length} indices; received ${indices.length}.`)
    }
    let flatIndex = 0
    indices.forEach((index, dimension) => {
      if (!Number.isSafeInteger(index) || index < 0 || index >= tensor.shape[dimension]) {
        throw new CadModelError(`${path} index ${index} is out of bounds for dimension ${dimension}.`)
      }
      flatIndex += index * strides[dimension]
    })
    return at(flatIndex)
  }
  const materialize = (depth = 0, indices: number[] = []): boolean | string | number | readonly unknown[] => {
    if (depth === tensor.shape.length) return get(indices)
    return Object.freeze(
      Array.from({ length: tensor.shape[depth] }, (_, index) => materialize(depth + 1, [...indices, index])),
    )
  }
  return Object.freeze({
    tensor: normalizedTensor,
    shape: normalizedTensor.shape,
    strides,
    size,
    byteLength: shards.reduce((sum, shard) => sum + shard.byteLength, 0),
    at,
    get,
    materialize,
    rawBytes: () => concatenateBytes(shards),
  })
}

export function persistDataTensor(
  schema: DataSchema,
  value: RecordedDataTensor,
  path = 'DataTensor',
): PersistedDataTensor {
  const accessor = createDataTensorAccessor(schema, value, path)
  if (accessor.byteLength > MAX_RECORDED_DATA_BYTES) {
    throw new CadModelError(
      `${path} is ${accessor.byteLength} raw bytes; maximum RecordedData size is ${MAX_RECORDED_DATA_BYTES}.`,
    )
  }
  const inline = accessor.shape.length === 0 || accessor.byteLength <= DATA_TENSOR_INLINE_BYTES
  return Object.freeze({
    tensorEncodingVersion: 1 as const,
    shape: accessor.shape,
    ...(accessor.tensor.axes === undefined ? {} : { axes: accessor.tensor.axes }),
    storage: inline
      ? Object.freeze({ kind: 'inline' as const, value: accessor.materialize() })
      : Object.freeze({
          kind: 'base64' as const,
          data: bytesToBase64(accessor.rawBytes()),
          byteLength: accessor.byteLength,
        }),
  })
}

export function persistDataSchema(schema: DataSchema): DataSchema {
  const axes = schema.axes?.map((axis) =>
    Object.freeze({
      ...axis,
      ...(axis.ticks === undefined ? {} : { ticks: Object.freeze([...axis.ticks]) }),
    }),
  )
  const basis = schema.basis?.map((axis) => Object.freeze([...axis]))
  return Object.freeze({
    ...schema,
    ...(axes === undefined ? {} : { axes: Object.freeze(axes) }),
    ...(basis === undefined ? {} : { basis: Object.freeze(basis) }),
  }) as DataSchema
}
