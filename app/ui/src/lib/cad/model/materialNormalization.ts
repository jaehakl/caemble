import type { CatalogRuntimeSlice, ModelParameterSchema } from '@/contracts/catalog'
import type { MaterialDefinition } from '@/contracts/material'
import { activeCatalogRuntimeSlice } from '../../catalog/runtime'
import { transformQuantityValue, type CartesianBasis } from '../../quantitykind/runtime'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import { CadModelError } from './errors'
import { convertUcumValue } from './units'

function record(value: unknown, path: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new CadModelError(`${path} must be an object.`)
  }
  return value as Record<string, unknown>
}

/** Validates input structure and normalizes physical units; never evaluates a model equation. */
export function normalizeModelParameters(
  schema: ModelParameterSchema,
  input: unknown,
  path: string,
  catalog: CatalogRuntimeSlice = activeCatalogRuntimeSlice(),
): unknown {
  if (schema.kind === 'object') {
    const value = record(input, path)
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(schema.fields, key))
        throw new CadModelError(`${path}.${key} is not a parameter of this model.`)
    }
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw new CadModelError(`${path}.${key} is required.`)
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          normalizeModelParameters(schema.fields[key], item, `${path}.${key}`, catalog),
        ]),
      ),
    )
  }
  if (schema.kind === 'list') {
    if (!Array.isArray(input)) throw new CadModelError(`${path} must be a list.`)
    if (input.length < (schema.minimumLength ?? 0) || input.length > (schema.maximumLength ?? Infinity)) {
      throw new CadModelError(
        `${path} must contain ${schema.minimumLength ?? 0}..${schema.maximumLength ?? 'N'} items.`,
      )
    }
    const values = input.map((value, index) =>
      normalizeModelParameters(schema.items, value, `${path}[${index}]`, catalog),
    )
    if (schema.increasingBy) {
      let previous = -Infinity
      values.forEach((value, index) => {
        const field = record(value, `${path}[${index}]`)[schema.increasingBy!]
        const number =
          typeof field === 'number' ? field : record(field, `${path}[${index}].${schema.increasingBy}`).value
        if (typeof number !== 'number' || !Number.isFinite(number) || number <= previous) {
          throw new CadModelError(`${path}[${index}].${schema.increasingBy} must be strictly increasing.`)
        }
        previous = number
      })
    }
    return Object.freeze(values)
  }

  const dtype = schema.dtype ?? 'float64'
  const quantity = schema.quantityKind !== undefined
  const descriptor = quantity ? record(input, path) : undefined
  if (descriptor) {
    for (const key of Object.keys(descriptor)) {
      if (!['value', 'unit', 'dtype', 'basis'].includes(key)) throw new CadModelError(`${path}.${key} is not allowed.`)
    }
    if (descriptor.dtype !== undefined && !['float16', 'float32', 'float64'].includes(String(descriptor.dtype))) {
      throw new CadModelError(`${path}.dtype must be a float dtype.`)
    }
    if (typeof descriptor.unit !== 'string' || !descriptor.unit) throw new CadModelError(`${path}.unit is required.`)
  }
  const shape = schema.shape ?? []
  const visit = (value: unknown, depth: number, valuePath: string, normalize: boolean): unknown => {
    if (depth < shape.length) {
      if (!Array.isArray(value) || value.length !== shape[depth])
        throw new CadModelError(`${valuePath} must have shape ${JSON.stringify(shape)}.`)
      return Object.freeze(value.map((item, index) => visit(item, depth + 1, `${valuePath}[${index}]`, normalize)))
    }
    if (dtype === 'string' || dtype === 'bool') {
      if (typeof value !== (dtype === 'bool' ? 'boolean' : 'string'))
        throw new CadModelError(`${valuePath} must be ${dtype}.`)
      if (schema.values && !schema.values.includes(value as string))
        throw new CadModelError(`${valuePath} must be one of ${schema.values.join(', ')}.`)
      return value
    }
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new CadModelError(`${valuePath} must be a finite number.`)
    let number = value
    if (normalize && descriptor) number = convertUcumValue(number, descriptor.unit as string, schema.unit!, valuePath)
    if (/^u?int/u.test(dtype)) {
      const bits = Number(dtype.replace(/\D/gu, ''))
      const unsigned = dtype.startsWith('u')
      const min = unsigned ? 0 : -(2 ** (bits - 1))
      const max = unsigned ? 2 ** bits - 1 : 2 ** (bits - 1) - 1
      if (!Number.isSafeInteger(number) || number < min || number > max)
        throw new CadModelError(`${valuePath} must be a safe ${dtype} integer.`)
    }
    const actualDtype = descriptor ? (descriptor.dtype ?? 'float64') : dtype
    if (
      (actualDtype === 'float16' && Math.abs(number) > 65504) ||
      (actualDtype === 'float32' && !Number.isFinite(Math.fround(number)))
    ) {
      throw new CadModelError(`${valuePath} is outside the finite ${actualDtype} range.`)
    }
    if (schema.minimum !== undefined && (schema.exclusiveMinimum ? number <= schema.minimum : number < schema.minimum))
      throw new CadModelError(
        `${valuePath} must be ${schema.exclusiveMinimum ? 'greater than' : 'at least'} ${schema.minimum}.`,
      )
    if (schema.maximum !== undefined && (schema.exclusiveMaximum ? number >= schema.maximum : number > schema.maximum))
      throw new CadModelError(
        `${valuePath} must be ${schema.exclusiveMaximum ? 'less than' : 'at most'} ${schema.maximum}.`,
      )
    return number
  }
  if (!descriptor) return visit(input, 0, path, false)
  const kind = catalog.quantityKinds.find((entry) => entry.name === schema.quantityKind)
  if (!kind) throw new CadModelError(`${path}: QuantityKind ${schema.quantityKind} is not in the active Catalog.`)
  if (!schema.unit) throw new CadModelError(`${path}: model quantity schema must declare a canonical unit.`)
  if (kind.opaque && descriptor.unit !== schema.unit)
    throw new CadModelError(`${path}.unit cannot convert an opaque QuantityKind.`)
  if (descriptor.basis !== undefined && kind.tensorOrder === 0)
    throw new CadModelError(`${path}.basis is forbidden for scalar quantities.`)
  if (descriptor.basis !== undefined) {
    const basis = descriptor.basis
    if (
      !Array.isArray(basis) ||
      basis.length !== 3 ||
      basis.some(
        (axis) =>
          !Array.isArray(axis) ||
          axis.length !== 3 ||
          axis.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n)),
      )
    )
      throw new CadModelError(`${path}.basis must be a Cartesian basis.`)
    for (let i = 0; i < 3; i++)
      for (let j = i; j < 3; j++) {
        const dot = basis[i].reduce((sum: number, n: number, k: number) => sum + n * basis[j][k], 0)
        if (Math.abs(dot - Number(i === j)) > 1e-9) throw new CadModelError(`${path}.basis must be orthonormal.`)
      }
    const determinant =
      basis[0][0] * (basis[1][1] * basis[2][2] - basis[1][2] * basis[2][1]) -
      basis[0][1] * (basis[1][0] * basis[2][2] - basis[1][2] * basis[2][0]) +
      basis[0][2] * (basis[1][0] * basis[2][1] - basis[1][1] * basis[2][0])
    if (Math.abs(determinant - 1) > 1e-9) throw new CadModelError(`${path}.basis must be right-handed.`)
  }
  const normalized = visit(descriptor.value, 0, `${path}.value`, true)
  const value =
    descriptor.basis === undefined
      ? normalized
      : transformQuantityValue(
          normalized,
          shape as readonly 3[],
          { unit: schema.unit, basis: descriptor.basis as CartesianBasis },
          { unit: schema.unit, basis: identityCartesianBasis },
          path,
        )
  return Object.freeze({
    dtype: descriptor.dtype ?? 'float64',
    value: visit(value, 0, `${path}.value`, false),
    unit: schema.unit,
    ...(kind.tensorOrder > 0 ? { basis: identityCartesianBasis } : {}),
  })
}

export function normalizeMaterialModels(
  input: unknown,
  path: string,
  catalog?: CatalogRuntimeSlice,
): MaterialDefinition['models'] {
  const models = record(input, path)
  return Object.freeze(
    Object.fromEntries(
      Object.entries(models).map(([name, raw]) => {
        if (!name.trim() || name !== name.trim()) throw new CadModelError(`${path} has an invalid model instance name.`)
        const instance = record(raw, `${path}.${name}`)
        for (const key of Object.keys(instance))
          if (!['model', 'parameters'].includes(key)) throw new CadModelError(`${path}.${name}.${key} is not allowed.`)
        const definition =
          typeof instance.model === 'string'
            ? (catalog ?? activeCatalogRuntimeSlice()).materialModels.find((model) => model.key === instance.model)
            : undefined
        if (!definition)
          throw new CadModelError(
            `${path}.${name}.model: ${String(instance.model)} is not registered in the active Model Catalog.`,
          )
        return [
          name,
          Object.freeze({
            model: definition.key,
            parameters: normalizeModelParameters(
              definition.parameterSchema,
              instance.parameters,
              `${path}.${name}.parameters`,
              catalog,
            ) as Readonly<Record<string, unknown>>,
          }),
        ]
      }),
    ),
  )
}
