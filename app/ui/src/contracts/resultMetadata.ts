/** Result meaning is declared once; candidate-specific values travel with each tensor. */
export type ResultMetadataField = Readonly<{
  dtype:
    | 'string'
    | 'bool'
    | 'float16'
    | 'float32'
    | 'float64'
    | 'int8'
    | 'int16'
    | 'int32'
    | 'int64'
    | 'uint8'
    | 'uint16'
    | 'uint32'
    | 'uint64'
  shape?: readonly (number | null)[]
  quantityKind?: string
  unit?: string
  values?: readonly string[]
}>
export type ResultMetadataSchema = Readonly<Record<string, ResultMetadataField>>
export type ResultMetadataValue = string | boolean | number | readonly ResultMetadataValue[]
export type ResultMetadata = Readonly<Record<string, ResultMetadataValue>>

export function assertMetadataSchema(value: unknown): asserts value is ResultMetadataSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid result metadata schema.')
  for (const [name, raw] of Object.entries(value)) {
    if (
      !name ||
      ['__proto__', 'constructor', 'prototype'].includes(name) ||
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw)
    )
      throw new Error('Invalid result metadata field.')
    const field = raw as ResultMetadataField
    if (
      Object.keys(field).some((key) => !['dtype', 'shape', 'quantityKind', 'unit', 'values'].includes(key)) ||
      typeof field.dtype !== 'string' ||
      !/^(string|bool|float(16|32|64)|u?int(8|16|32|64))$/u.test(field.dtype) ||
      (field.shape !== undefined &&
        (!Array.isArray(field.shape) ||
          field.shape.some((size) => size !== null && (!Number.isSafeInteger(size) || size < 0))))
    )
      throw new Error(`Invalid metadata descriptor ${name}.`)
    if (
      field.dtype.startsWith('float')
        ? typeof field.quantityKind !== 'string' || !field.quantityKind || typeof field.unit !== 'string' || !field.unit
        : field.quantityKind !== undefined || field.unit !== undefined
    )
      throw new Error(`Metadata ${name} has inconsistent physical units.`)
    if (
      field.values !== undefined &&
      (field.dtype !== 'string' ||
        !Array.isArray(field.values) ||
        !field.values.length ||
        field.values.some((item) => typeof item !== 'string') ||
        new Set(field.values).size !== field.values.length)
    )
      throw new Error(`Metadata ${name} requires distinct string choices.`)
  }
}

export function assertResultMetadata(
  schema: ResultMetadataSchema | undefined,
  value: unknown,
  path = 'Result metadata',
): asserts value is ResultMetadata | undefined {
  if (schema === undefined && value === undefined) return
  assertMetadataSchema(schema)
  if (!schema || !value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path} requires its declared metadata fields.`)
  const actual = value as Record<string, unknown>
  if (
    Object.keys(actual).length !== Object.keys(schema).length ||
    Object.keys(schema).some((name) => !Object.prototype.hasOwnProperty.call(actual, name))
  )
    throw new Error(`${path} fields differ from their declared metadata schema.`)
  for (const [name, field] of Object.entries(schema)) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error(`${path} has an invalid field name.`)
    const shape = field.shape ?? []
    const dimensions = new Map<number, number>()
    const validate = (item: unknown, depth: number): boolean => {
      if (depth < shape.length) {
        if (
          !Array.isArray(item) ||
          (shape[depth] !== null && item.length !== shape[depth]) ||
          (dimensions.has(depth) && dimensions.get(depth) !== item.length)
        )
          return false
        dimensions.set(depth, item.length)
        return item.every((child) => validate(child, depth + 1))
      }
      if (field.dtype === 'string') return typeof item === 'string' && (!field.values || field.values.includes(item))
      if (field.dtype === 'bool') return typeof item === 'boolean'
      if (typeof item !== 'number' || !Number.isFinite(item)) return false
      if (field.dtype.startsWith('float')) {
        const limit = field.dtype === 'float16' ? 65504 : field.dtype === 'float32' ? 3.4028234663852886e38 : Infinity
        return Math.abs(item) <= limit
      }
      const integer = /^(u?)int(8|16|32|64)$/u.exec(field.dtype)
      if (!integer || !Number.isSafeInteger(item)) return false
      const bits = Number(integer[2]),
        unsigned = integer[1] === 'u'
      return item >= (unsigned ? 0 : -(2 ** (bits - 1))) && item < 2 ** (bits - Number(!unsigned))
    }
    if (!validate(actual[name], 0)) throw new Error(`${path}.${name} differs from its metadata declaration.`)
  }
}

export function cloneResultMetadata(value: ResultMetadata): ResultMetadata {
  const clone = (item: ResultMetadataValue): ResultMetadataValue =>
    Array.isArray(item) ? Object.freeze(item.map(clone)) : item
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clone(item)])))
}
