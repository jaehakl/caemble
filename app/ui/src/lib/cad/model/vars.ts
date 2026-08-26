import { CadModelError } from './errors'
import type { Tensor, Vars } from './types'

export const MAX_VARS_TENSOR_ELEMENTS = 65_536

export type VarsSchemaEntry = Readonly<{
  shape: readonly number[]
  min: number
  max: number
}>

export type VarsSchema = Readonly<Record<string, VarsSchemaEntry>>

function cloneTensor(value: Tensor): Tensor {
  return Array.isArray(value) ? value.map(cloneTensor) : value
}

function normalizeShape(value: unknown, path: string) {
  if (!Array.isArray(value)) throw new CadModelError(`${path} must be an array of positive safe integers.`)
  let elements = 1
  const shape = value.map((size, index) => {
    if (!Number.isSafeInteger(size) || (size as number) <= 0) {
      throw new CadModelError(`${path}[${index}] must be a positive safe integer.`)
    }
    elements *= size as number
    if (!Number.isSafeInteger(elements) || elements > MAX_VARS_TENSOR_ELEMENTS) {
      throw new CadModelError(`${path} must contain at most ${MAX_VARS_TENSOR_ELEMENTS} elements.`)
    }
    return size as number
  })
  return Object.freeze(shape)
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

function freezeTensor(value: Tensor): Tensor {
  if (!Array.isArray(value)) return value
  value.forEach(freezeTensor)
  return Object.freeze(value)
}

function validateRange(value: Tensor, min: number, max: number, shape: readonly number[], path: string) {
  if (shape.length === 0) {
    const scalar = value as number
    if (scalar < min) throw new CadModelError(`${path} must be greater than or equal to ${min}.`)
    if (scalar > max) throw new CadModelError(`${path} must be less than or equal to ${max}.`)
    return
  }
  ;(value as readonly Tensor[]).forEach((item, index) =>
    validateRange(item, min, max, shape.slice(1), `${path}[${index}]`),
  )
}

export function normalizeVarsSchema(rawSchema: unknown, objectName: string): VarsSchema {
  if (typeof rawSchema !== 'object' || rawSchema === null || Array.isArray(rawSchema)) {
    throw new CadModelError(`${objectName} varsSchema must be an object.`)
  }
  const schema: Record<string, VarsSchemaEntry> = {}
  Object.entries(rawSchema).forEach(([key, rawEntry]) => {
    if (!key.trim()) throw new CadModelError('varsSchema keys must not be empty.')
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      throw new CadModelError(`varsSchema.${key} must be an object.`)
    }
    const entry = rawEntry as Record<string, unknown>
    const unsupportedKey = Object.keys(entry).find((entryKey) => !['shape', 'min', 'max'].includes(entryKey))
    if (unsupportedKey) {
      throw new CadModelError(`varsSchema.${key}.${unsupportedKey} is not supported; define only shape, min, and max.`)
    }
    if (entry.shape === undefined) {
      throw new CadModelError(
        `varsSchema.${key}.shape is required by CAD API v11; update the Experiment source to define shape, min, and max.`,
      )
    }
    if (entry.min === undefined || entry.max === undefined) {
      throw new CadModelError(`varsSchema.${key} must define shape, min, and max.`)
    }
    const shape = normalizeShape(entry.shape, `varsSchema.${key}.shape`)
    if (typeof entry.min !== 'number' || !Number.isFinite(entry.min)) {
      throw new CadModelError(`varsSchema.${key}.min must be a finite number.`)
    }
    if (typeof entry.max !== 'number' || !Number.isFinite(entry.max)) {
      throw new CadModelError(`varsSchema.${key}.max must be a finite number.`)
    }
    if (entry.min > entry.max) throw new CadModelError(`varsSchema.${key} has min greater than max.`)
    schema[key] = Object.freeze({ shape, min: entry.min, max: entry.max })
  })
  return Object.freeze(schema)
}

export function normalizeVars(schema: VarsSchema, rawVars: unknown, variableObjectName: string) {
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
    if (!Object.prototype.hasOwnProperty.call(values, key) || rawValue === undefined) {
      throw new CadModelError(`vars.${key} is required by varsSchema but is missing from the current Candidate.`)
    }
    validateTensor(rawValue, entry.shape, `vars.${key}`)
    const value = freezeTensor(cloneTensor(rawValue))
    validateRange(value, entry.min, entry.max, entry.shape, `vars.${key}`)
    normalized[key] = value
  })
  return Object.freeze(normalized)
}

export function varsSchemaFingerprint(rawSchema: VarsSchema) {
  const schema = normalizeVarsSchema(rawSchema, 'Experiment')
  return JSON.stringify(
    Object.keys(schema)
      .sort()
      .map((key) => {
        const entry = schema[key]
        return [key, entry.shape, entry.min, entry.max]
      }),
  )
}

function randomTensor(shape: readonly number[], min: number, max: number): Tensor {
  if (shape.length === 0) {
    if (min === max) return min
    return min + Math.random() * (max - min)
  }
  return Array.from({ length: shape[0] }, () => randomTensor(shape.slice(1), min, max))
}

export function generateRandomVars(rawSchema: VarsSchema) {
  const schema = normalizeVarsSchema(rawSchema, 'Experiment')
  const generated = Object.fromEntries(
    Object.entries(schema).map(([key, entry]) => [key, randomTensor(entry.shape, entry.min, entry.max)]),
  )
  return normalizeVars(schema, generated, 'Experiment')
}
