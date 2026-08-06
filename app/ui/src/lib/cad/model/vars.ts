import { CadModelError } from './errors'
import type { Tensor, Vars } from './types'

export type VarsSchemaEntry = {
  min: Tensor
  max: Tensor
}

export type NormalizedVarsSchemaEntry = Readonly<VarsSchemaEntry & { shape: readonly number[] }>
export type NormalizedVarsSchema = Readonly<Record<string, NormalizedVarsSchemaEntry>>

function cloneTensor(value: Tensor): Tensor {
  return Array.isArray(value) ? value.map(cloneTensor) : value
}

function freezeTensor(value: Tensor): Tensor {
  if (!Array.isArray(value)) return value
  value.forEach(freezeTensor)
  return Object.freeze(value)
}

function inferTensorShape(value: unknown, path: string): readonly number[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CadModelError(`${path} must contain only finite numbers.`)
    return Object.freeze([])
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new CadModelError(`${path} must be a finite number or a non-empty rectangular tensor.`)
  }
  const childShape = inferTensorShape(value[0], `${path}[0]`)
  value.slice(1).forEach((item, index) => {
    const itemShape = inferTensorShape(item, `${path}[${index + 1}]`)
    if (itemShape.length !== childShape.length || itemShape.some((size, axis) => size !== childShape[axis])) {
      throw new CadModelError(`${path} must be a rectangular tensor.`)
    }
  })
  return Object.freeze([value.length, ...childShape])
}

function validateTensor(value: unknown, shape: readonly number[], path: string): asserts value is Tensor {
  if (shape.length === 0) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CadModelError(`${path} must be a finite number.`)
    }
    return
  }
  if (!Array.isArray(value) || value.length !== shape[0]) {
    throw new CadModelError(`${path} must have shape [${shape.join(', ')}].`)
  }
  value.forEach((item, index) => validateTensor(item, shape.slice(1), `${path}[${index}]`))
}

function validateBound(value: unknown, shape: readonly number[], path: string): asserts value is Tensor {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CadModelError(`${path} must be a finite number.`)
    return
  }
  validateTensor(value, shape, path)
}

function boundAt(bound: Tensor, index: number): Tensor {
  return Array.isArray(bound) ? bound[index] : bound
}

function validateRange(value: Tensor, min: Tensor, max: Tensor, shape: readonly number[], path: string) {
  if (shape.length === 0) {
    const scalar = value as number
    const minimum = min as number
    const maximum = max as number
    if (minimum > maximum) throw new CadModelError(`${path} has min greater than max.`)
    if (scalar < minimum) throw new CadModelError(`${path} must be greater than or equal to ${minimum}.`)
    if (scalar > maximum) throw new CadModelError(`${path} must be less than or equal to ${maximum}.`)
    return
  }
  ;(value as readonly Tensor[]).forEach((item, index) =>
    validateRange(item, boundAt(min, index), boundAt(max, index), shape.slice(1), `${path}[${index}]`),
  )
}

function validateBounds(min: Tensor, max: Tensor, shape: readonly number[], path: string) {
  if (shape.length === 0) {
    if ((min as number) > (max as number)) throw new CadModelError(`${path} has min greater than max.`)
    return
  }
  Array.from({ length: shape[0] }, (_, index) => {
    validateBounds(boundAt(min, index), boundAt(max, index), shape.slice(1), `${path}[${index}]`)
  })
}

export function normalizeVarsSchema(rawSchema: unknown, objectName: string) {
  if (typeof rawSchema !== 'object' || rawSchema === null || Array.isArray(rawSchema)) {
    throw new CadModelError(`${objectName} varsSchema must be an object.`)
  }
  const schema: Record<string, VarsSchemaEntry> = {}
  const normalized: Record<string, NormalizedVarsSchemaEntry> = {}
  Object.entries(rawSchema).forEach(([key, rawEntry]) => {
    if (!key.trim()) throw new CadModelError('varsSchema keys must not be empty.')
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      throw new CadModelError(`varsSchema.${key} must be an object.`)
    }
    const entry = rawEntry as Record<string, unknown>
    const unsupportedKey = Object.keys(entry).find((entryKey) => entryKey !== 'min' && entryKey !== 'max')
    if (unsupportedKey) {
      throw new CadModelError(`varsSchema.${key}.${unsupportedKey} is not supported; define only min and max.`)
    }
    if (entry.min === undefined || entry.max === undefined) {
      throw new CadModelError(`varsSchema.${key} must define both min and max.`)
    }
    const minShape = inferTensorShape(entry.min, `varsSchema.${key}.min`)
    const maxShape = inferTensorShape(entry.max, `varsSchema.${key}.max`)
    const shape = minShape.length === 0 ? maxShape : minShape
    if (minShape.length > 0 && maxShape.length > 0) validateTensor(entry.max, minShape, `varsSchema.${key}.max`)
    validateBound(entry.min, shape, `varsSchema.${key}.min`)
    validateBound(entry.max, shape, `varsSchema.${key}.max`)
    const min = freezeTensor(cloneTensor(entry.min as Tensor))
    const max = freezeTensor(cloneTensor(entry.max as Tensor))
    validateBounds(min, max, shape, `varsSchema.${key}`)
    schema[key] = Object.freeze({ min, max })
    normalized[key] = Object.freeze({ shape, min, max })
  })
  return Object.freeze({ schema: Object.freeze(schema), normalized: Object.freeze(normalized) })
}

export function normalizeVars(schema: NormalizedVarsSchema, rawVars: unknown, variableObjectName: string) {
  if (typeof rawVars !== 'object' || rawVars === null || Array.isArray(rawVars)) {
    throw new CadModelError(`${variableObjectName} vars must be an object.`)
  }
  const values = rawVars as Record<string, unknown>
  const extraKey = Object.keys(values).find((key) => !(key in schema))
  if (extraKey) throw new CadModelError(`Unknown ${variableObjectName} var: ${extraKey}.`)
  const normalized: Vars = {}
  Object.keys(schema).forEach((key) => {
    const entry = schema[key]
    const rawValue = values[key]
    validateTensor(rawValue, entry.shape, `vars.${key}`)
    const value = freezeTensor(cloneTensor(rawValue))
    validateRange(value, entry.min, entry.max, entry.shape, `vars.${key}`)
    normalized[key] = value
  })
  return Object.freeze(normalized)
}

export function createRandom(seed?: number) {
  if (seed === undefined) return Math.random
  if (!Number.isInteger(seed) || !Number.isSafeInteger(seed)) {
    throw new CadModelError('randomVars seed must be a safe integer.')
  }
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function randomTensor(shape: readonly number[], min: Tensor, max: Tensor, random: () => number): Tensor {
  if (shape.length === 0) {
    const minimum = min as number
    const maximum = max as number
    if (minimum === maximum) return minimum
    return minimum + random() * (maximum - minimum)
  }
  return Array.from({ length: shape[0] }, (_, index) =>
    randomTensor(shape.slice(1), boundAt(min, index), boundAt(max, index), random),
  )
}
