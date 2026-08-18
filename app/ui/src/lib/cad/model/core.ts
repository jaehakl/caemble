import type { Tensor, Vars } from './types'
import { CadModelError } from './errors'
import {
  getQuantityKindComponentShape,
  normalizeQuantityMetadata,
  type QuantityKindName,
} from '../../quantitykind/runtime'
import type { MaterialModelKey, MaterialPropertyKey } from '../../material/data'
import { getRuntimeMaterialModel, getRuntimeMaterialParameter } from '../../catalog/runtime'
import { Material } from './material'
import type {
  DataDType,
  DataValueDescriptor,
  FloatDataDType,
  MaterialSampledRelation,
  ResolvedMaterialDataValueDescriptor,
  ResolvedMaterialVariables,
  ScalarValue,
} from './descriptor'

export type { Rotation, Tensor, Vars, Vec3 } from './types'
export type { VarsSchemaEntry } from './vars'
export type {
  CanonicalGeometryTransformAttributes,
  Geometry,
  GeometryAttributes,
  GeometryGroupMap,
  GeometryTransformAttributes,
  IntrinsicGeometryAttributes,
  LegacyGeometryTransformAttributes,
} from './structure'
export { Material } from './material'
export { CadModelError } from './errors'
export { Mat } from './descriptor'
export type {
  DataAxis,
  DataDType,
  DataSchema,
  DataSchemaAxis,
  DataTensor,
  DataValueDescriptor,
  ExperimentParameter,
  ExperimentParameters,
  ExperimentRule,
  ExperimentTarget,
  FloatDataDType,
  IntegerDataDType,
  MaterialDataValueDescriptor,
  MaterialQuantitySeries,
  MaterialSampledRelation,
  MaterialVariable,
  MaterialVariables,
  MatrixValue,
  NonFloatDataDType,
  NormalizedMaterialVariables,
  PersistedDataTensor,
  RecordedData,
  RecordedDataAxis,
  LegacyRecordedDataTensor,
  RecordedDataResult,
  RecordedDataResultAxis,
  RecordedDataRule,
  RecordedDataTensor,
  ResolvedMaterialDataValueDescriptor,
  ResolvedMaterialVariables,
  ScalarValue,
} from './descriptor'
export type { UcumUnit } from './units'
export type {
  CartesianBasis,
  QuantityKindDomain,
  QuantityKindName,
  QuantityKindNameForDomain,
  QuantityMetadata,
  ScalarQuantityKindName,
  TensorQuantityKindName,
} from '../../quantitykind/runtime'
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

export function normalizeRawScalar(value: unknown, path: string): ScalarValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CadModelError(`${path} must be a finite number.`)
    if (!Number.isSafeInteger(value)) {
      throw new CadModelError(`${path} raw numbers must be safe integers; use a dtype descriptor for float values.`)
    }
    return value
  }
  if (value === null) throw new CadModelError(`${path} must not be null.`)
  if (Array.isArray(value)) {
    throw new CadModelError(`${path} raw arrays are not allowed; use a dtype descriptor with axes.`)
  }
  throw new CadModelError(`${path} must be a raw boolean, string, safe integer, or dtype descriptor.`)
}

const dataDTypes = new Set<DataDType>([
  'bool',
  'string',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float16',
  'float32',
  'float64',
])
const integerDataRanges: Partial<Record<DataDType, readonly [number, number]>> = {
  int8: [-128, 127],
  int16: [-32768, 32767],
  int32: [-2147483648, 2147483647],
  int64: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
  uint64: [0, Number.MAX_SAFE_INTEGER],
}

export function isFloatDType(dtype: DataDType) {
  return dtype === 'float16' || dtype === 'float32' || dtype === 'float64'
}

function assertDescriptorKeys(value: Record<string, unknown>, expected: readonly string[], path: string) {
  const keys = Reflect.ownKeys(value)
  const invalid = keys.filter((key) => typeof key !== 'string' || !expected.includes(key))
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (invalid.length > 0 || missing.length > 0 || keys.length !== expected.length) {
    throw new CadModelError(`${path} must contain exactly ${expected.join(', ')}.`)
  }
}

function assertNoLegacyDataKeys(value: Record<string, unknown>, path: string) {
  const replacements = [
    ['type', 'use dtype'],
    ['shape', 'move every outer dimension to axes with a length'],
    ['dimension', 'omit it; outer dimension is axes.length'],
    ['sampleDimension', 'omit it; outer dimension is axes.length'],
    ['sampleShape', 'move every outer dimension to axes with a length'],
    ['sampleAxes', 'use axes'],
  ] as const
  const legacy = replacements.find(([key]) => Object.prototype.hasOwnProperty.call(value, key))
  if (legacy) {
    throw new CadModelError(`${path}.${legacy[0]} is obsolete in the dtype/axes contract; ${legacy[1]}.`)
  }
}

function normalizeDataAxes(value: unknown, path: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new CadModelError(`${path}.axes must be an array.`)
  if (value.length === 0) {
    throw new CadModelError(`${path}.axes must be omitted for a single value; axes cannot be empty.`)
  }

  return Object.freeze(
    Array.from(value, (rawAxis, axisIndex) => {
      const axisPath = `${path}.axes[${axisIndex}]`
      if (!isPlainObject(rawAxis)) {
        throw new CadModelError(`${axisPath} must be a plain object.`)
      }
      const axisKeys = ['length', 'name', 'ticks', 'unit', 'quantityKind'].filter((key) =>
        Object.prototype.hasOwnProperty.call(rawAxis, key),
      )
      assertDescriptorKeys(rawAxis, axisKeys, axisPath)

      if (!Number.isSafeInteger(rawAxis.length) || (rawAxis.length as number) <= 0) {
        throw new CadModelError(`${axisPath}.length must be a positive safe integer.`)
      }
      const length = rawAxis.length as number

      const name = rawAxis.name === undefined ? `axis ${axisIndex}` : rawAxis.name
      if (typeof name !== 'string' || !name.trim()) {
        throw new CadModelError(`${axisPath}.name must be a non-empty string.`)
      }
      const hasUnit = Object.prototype.hasOwnProperty.call(rawAxis, 'unit')
      const hasQuantityKind = Object.prototype.hasOwnProperty.call(rawAxis, 'quantityKind')
      if (hasUnit !== hasQuantityKind) {
        throw new CadModelError(`${axisPath} must specify both unit and quantityKind or neither.`)
      }
      const metadata = hasUnit ? normalizeQuantityMetadata(rawAxis, axisPath, true) : undefined

      const rawTicks = rawAxis.ticks === undefined ? Array.from({ length }, (_, tickIndex) => tickIndex) : rawAxis.ticks
      if (!Array.isArray(rawTicks)) {
        throw new CadModelError(`${axisPath}.ticks must be an array.`)
      }
      if (rawTicks.length !== length) {
        throw new CadModelError(
          `${axisPath}.ticks has length ${rawTicks.length}; expected ${length} to match ${axisPath}.length.`,
        )
      }
      const ticks = Object.freeze(
        Array.from(rawTicks, (tick, tickIndex) => {
          if (typeof tick === 'string' || (typeof tick === 'number' && Number.isFinite(tick))) return tick
          throw new CadModelError(`${axisPath}.ticks[${tickIndex}] must be a string or finite number.`)
        }),
      )

      return Object.freeze({ length, name: name.trim(), ticks, ...metadata })
    }),
  )
}

function normalizeDataSchema(value: Record<string, unknown>, path: string) {
  assertNoLegacyDataKeys(value, path)
  if (typeof value.dtype !== 'string' || !dataDTypes.has(value.dtype as DataDType)) {
    throw new CadModelError(`${path}.dtype must be a supported data dtype.`)
  }
  const dtype = value.dtype as DataDType
  const hasUnit = Object.prototype.hasOwnProperty.call(value, 'unit')
  const hasQuantityKind = Object.prototype.hasOwnProperty.call(value, 'quantityKind')
  const hasBasis = Object.prototype.hasOwnProperty.call(value, 'basis')
  if (isFloatDType(dtype)) {
    if (!hasUnit || !hasQuantityKind) {
      throw new CadModelError(`${path} must specify both unit and quantityKind for a float dtype.`)
    }
  } else if (hasUnit || hasQuantityKind || hasBasis) {
    throw new CadModelError(`${path}.unit, ${path}.quantityKind, and ${path}.basis are allowed only for float dtypes.`)
  }
  const metadata = isFloatDType(dtype) ? normalizeQuantityMetadata(value, path) : undefined
  const componentShape = metadata === undefined ? [] : getQuantityKindComponentShape(metadata.quantityKind)
  const axes = normalizeDataAxes(value.axes, path)
  const outerShape = axes?.map((axis) => axis.length) ?? []
  return {
    ...(axes === undefined ? {} : { axes }),
    dtype,
    storageShape: Object.freeze([...outerShape, ...componentShape]),
    ...metadata,
  }
}

function describeTensorShape(value: unknown, ancestors = new Set<unknown>()): string {
  if (!Array.isArray(value)) return '[]'
  if (ancestors.has(value)) return '[circular]'
  if (value.length === 0) return '[0]'

  ancestors.add(value)
  const childShapes = value.map((item) => describeTensorShape(item, ancestors))
  ancestors.delete(value)
  const uniqueShapes = [...new Set(childShapes)]
  if (uniqueShapes.length !== 1) {
    return `[${value.length}, ragged ${uniqueShapes.join(' | ')}]`
  }
  const child = uniqueShapes[0]
  return child === '[]' ? `[${value.length}]` : `[${value.length}, ${child.slice(1, -1)}]`
}

function tensorShapeError(path: string, value: unknown, shape: readonly number[]): CadModelError {
  return new CadModelError(
    `${path} has actual shape ${describeTensorShape(value)}; expected shape ${JSON.stringify(shape)}.`,
  )
}

export function normalizeDataElement(value: unknown, dtype: DataDType, path: string) {
  if (dtype === 'bool') {
    if (typeof value !== 'boolean') throw new CadModelError(`${path} must be a bool element.`)
    return value
  }
  if (dtype === 'string') {
    if (typeof value !== 'string') throw new CadModelError(`${path} must be a string element.`)
    return value
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CadModelError(`${path} must be a finite ${dtype} element.`)
  }

  const range = integerDataRanges[dtype]
  if (range) {
    if (!Number.isSafeInteger(value) || value < range[0] || value > range[1]) {
      throw new CadModelError(`${path} must be a ${dtype} safe integer in [${range[0]}, ${range[1]}].`)
    }
    return value
  }
  if (dtype === 'float16' && Math.abs(value) > 65504) {
    throw new CadModelError(`${path} must be a finite float16 value in [-65504, 65504].`)
  }
  if (dtype === 'float32' && !Number.isFinite(Math.fround(value))) {
    throw new CadModelError(`${path} must be representable as a finite float32 value.`)
  }
  return value
}

export function normalizeDataValue(
  value: unknown,
  shape: readonly number[],
  dtype: DataDType,
  path: string,
  rootValue = value,
  rootPath = path,
  depth = 0,
  ancestors = new Set<unknown>(),
): boolean | string | number | readonly unknown[] {
  if (depth === shape.length) {
    if (Array.isArray(value)) throw tensorShapeError(rootPath, rootValue, shape)
    return normalizeDataElement(value, dtype, path)
  }
  if (!Array.isArray(value) || value.length !== shape[depth] || ancestors.has(value)) {
    throw tensorShapeError(rootPath, rootValue, shape)
  }

  ancestors.add(value)
  const normalized = value.map((item, index) =>
    normalizeDataValue(item, shape, dtype, `${path}[${index}]`, rootValue, rootPath, depth + 1, ancestors),
  )
  ancestors.delete(value)
  return Object.freeze(normalized)
}

export function normalizeDataValueDescriptor(value: unknown, path = 'Data value descriptor'): DataValueDescriptor {
  if (!isPlainObject(value)) {
    throw new CadModelError(`${path} must be a dtype descriptor.`)
  }
  assertNoLegacyDataKeys(value, path)
  const descriptorKeys = ['dtype', 'value']
  if (Object.prototype.hasOwnProperty.call(value, 'axes')) descriptorKeys.push('axes')
  if (Object.prototype.hasOwnProperty.call(value, 'unit')) descriptorKeys.push('unit')
  if (Object.prototype.hasOwnProperty.call(value, 'quantityKind')) descriptorKeys.push('quantityKind')
  if (Object.prototype.hasOwnProperty.call(value, 'basis')) descriptorKeys.push('basis')
  assertDescriptorKeys(value, descriptorKeys, path)
  const { storageShape, ...schema } = normalizeDataSchema(value, path)
  return Object.freeze({
    ...schema,
    value: normalizeDataValue(value.value, storageShape, schema.dtype, `${path}.value`),
  }) as DataValueDescriptor
}

export const DEFAULT_MATERIAL_ERROR_RATE = 0.001

export function normalizeMaterialErrorRate(value: unknown, path: string, fallback = DEFAULT_MATERIAL_ERROR_RATE) {
  const normalized = value === undefined ? fallback : value
  if (typeof normalized !== 'number' || !Number.isFinite(normalized) || normalized < 0 || normalized >= 1) {
    throw new CadModelError(`${path} must be a finite number in [0, 1).`)
  }
  return normalized
}

export function normalizeMaterialDataValueDescriptor(
  key: MaterialPropertyKey,
  value: Record<string, unknown>,
  path: string,
  defaultErrorRate = DEFAULT_MATERIAL_ERROR_RATE,
): ResolvedMaterialDataValueDescriptor {
  assertNoLegacyDataKeys(value, path)
  const dtype = value.dtype
  if (typeof dtype !== 'string' || !isFloatDType(dtype as DataDType)) {
    throw new CadModelError(`${path}.dtype must be a supported float dtype.`)
  }
  const descriptorKeys = ['dtype', 'value', 'unit']
  if (Object.prototype.hasOwnProperty.call(value, 'errorRate')) descriptorKeys.push('errorRate')
  if (Object.prototype.hasOwnProperty.call(value, 'basis')) descriptorKeys.push('basis')
  assertDescriptorKeys(value, descriptorKeys, path)
  const errorRate = normalizeMaterialErrorRate(value.errorRate, `${path}.errorRate`, defaultErrorRate)
  const quantityKind = getRuntimeMaterialParameter(key)?.quantityKind
  if (!quantityKind) throw new CadModelError(`${path} is not a registered Material parameter.`)
  const { storageShape, ...schema } = normalizeDataSchema(
    {
      ...value,
      quantityKind,
    },
    path,
  )
  return Object.freeze({
    ...schema,
    value: normalizeDataValue(value.value, storageShape, schema.dtype, `${path}.value`),
    errorRate,
  }) as ResolvedMaterialDataValueDescriptor
}

function normalizeMaterialQuantitySeries(value: unknown, quantityKind: QuantityKindName, path: string) {
  if (!isPlainObject(value)) throw new CadModelError(`${path} must be a quantity series.`)
  const allowedKeys = ['unit', 'values']
  if (Object.prototype.hasOwnProperty.call(value, 'basis')) allowedKeys.push('basis')
  assertDescriptorKeys(value, allowedKeys, path)
  if (!Array.isArray(value.values)) throw new CadModelError(`${path}.values must be an array.`)
  const metadata = normalizeQuantityMetadata({ ...value, quantityKind }, path)
  const componentShape = getQuantityKindComponentShape(quantityKind)
  const values = Object.freeze(
    value.values.map((sample, index) =>
      normalizeDataValue(sample, componentShape, 'float64', `${path}.values[${index}]`),
    ),
  )
  return Object.freeze({
    unit: metadata.unit,
    values,
    ...(metadata.basis === undefined ? {} : { basis: metadata.basis }),
  })
}

export function normalizeMaterialSampledRelation(
  key: MaterialModelKey,
  value: Record<string, unknown>,
  path: string,
): MaterialSampledRelation {
  assertDescriptorKeys(value, ['kind', 'input', 'output'], path)
  if (value.kind !== 'sampled_relation') {
    throw new CadModelError(`${path}.kind must be sampled_relation.`)
  }
  const definition = getRuntimeMaterialModel(key)
  if (!definition) throw new CadModelError(`${path} is not a registered Material model.`)
  const input = normalizeMaterialQuantitySeries(value.input, definition.input.quantityKind, `${path}.input`)
  const output = normalizeMaterialQuantitySeries(value.output, definition.output.quantityKind, `${path}.output`)
  if (input.values.length < definition.minimumSamples) {
    throw new CadModelError(`${path} must contain at least ${definition.minimumSamples} samples.`)
  }
  if (input.values.length !== output.values.length) {
    throw new CadModelError(`${path} input and output must contain the same number of samples.`)
  }
  if (definition.sharedBasis && JSON.stringify(input.basis) !== JSON.stringify(output.basis)) {
    throw new CadModelError(`${path} input and output must use the same Cartesian basis.`)
  }
  return Object.freeze({ kind: 'sampled_relation', input, output }) as MaterialSampledRelation
}

let activeVars: Readonly<Vars> | null = null

export function applyMaterialErrorMultiplier(
  value: number | readonly unknown[],
  dtype: FloatDataDType,
  multiplier: number,
  path: string,
): number | readonly unknown[] {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item, index) =>
        applyMaterialErrorMultiplier(item as number | readonly unknown[], dtype, multiplier, `${path}[${index}]`),
      ),
    )
  }

  return normalizeDataElement((value as number) * multiplier, dtype, path) as number
}

export function resolveMaterialVariables(material: Material): ResolvedMaterialVariables {
  const resolved: Record<string, unknown> = {}

  Object.entries(material.variables).forEach(([key, value]) => {
    if (
      isPlainObject(value) &&
      'dtype' in value &&
      typeof value.dtype === 'string' &&
      isFloatDType(value.dtype as DataDType) &&
      Object.prototype.hasOwnProperty.call(value, 'errorRate')
    ) {
      const parameter = value as ResolvedMaterialDataValueDescriptor & {
        dtype: FloatDataDType
        errorRate: number
      }
      resolved[key] = Object.freeze({
        dtype: parameter.dtype,
        unit: parameter.unit,
        quantityKind: parameter.quantityKind,
        errorRate: parameter.errorRate,
        ...(parameter.basis === undefined ? {} : { basis: parameter.basis }),
        value: parameter.value,
      }) as DataValueDescriptor
      return
    }

    resolved[key] = value
  })

  return Object.freeze(resolved) as ResolvedMaterialVariables
}

export const vars = new Proxy<Record<string, Tensor>>(
  {},
  {
    deleteProperty() {
      throw new CadModelError('Global vars is read-only.')
    },
    get(_target, key) {
      if (activeVars === null) {
        throw new CadModelError('Global vars is only available while CAD source is being evaluated.')
      }

      if (typeof key === 'symbol') return undefined
      return activeVars[key]
    },
    getOwnPropertyDescriptor(_target, key) {
      if (activeVars === null || typeof key === 'symbol' || !(key in activeVars)) return undefined

      return {
        configurable: true,
        enumerable: true,
        value: activeVars[key],
        writable: false,
      }
    },
    has(_target, key) {
      return activeVars !== null && typeof key === 'string' && key in activeVars
    },
    ownKeys() {
      return activeVars === null ? [] : Reflect.ownKeys(activeVars)
    },
    set() {
      throw new CadModelError('Global vars is read-only.')
    },
  },
)

export function evaluateWithVars<T>(sampleVars: Readonly<Vars>, evaluate: () => T) {
  const previousVars = activeVars
  activeVars = sampleVars

  try {
    return evaluate()
  } finally {
    activeVars = previousVars
  }
}
