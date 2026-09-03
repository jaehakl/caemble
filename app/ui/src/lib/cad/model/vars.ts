import type { Tensor, Vars } from './types'

export type VarsSchemaEntry = Readonly<{ shape: readonly number[]; min: number; max: number }>
export type VarsSchema = Readonly<Record<string, VarsSchemaEntry>>

export function normalizeVarsSchema(rawSchema: unknown, _objectName?: string): VarsSchema {
  void _objectName
  return rawSchema as VarsSchema
}

export function normalizeVars(_schema: VarsSchema, rawVars: unknown, _variableObjectName?: string) {
  void _schema
  void _variableObjectName
  return rawVars as Readonly<Vars>
}

export function varsSchemaFingerprint(schema: VarsSchema) {
  return JSON.stringify(
    Object.keys(schema)
      .sort()
      .map((key) => [key, schema[key].shape, schema[key].min, schema[key].max]),
  )
}

export function varsFingerprint(vars: Readonly<Vars> | null) {
  return vars ? JSON.stringify(vars) : 'none'
}

function randomTensor(shape: readonly number[], min: number, max: number): Tensor {
  if (shape.length === 0) return min === max ? min : min + Math.random() * (max - min)
  return Array.from({ length: shape[0] }, () => randomTensor(shape.slice(1), min, max))
}

export function generateRandomVars(schema: VarsSchema) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(schema).map(([key, entry]) => [key, randomTensor(entry.shape, entry.min, entry.max)]),
    ),
  )
}
