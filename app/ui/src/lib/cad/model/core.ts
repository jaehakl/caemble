import type { Tensor, Vars, Vec3 } from './types'
import { CadModelError } from './errors'
import type {
  DataDType,
  DataValueDescriptor,
  ScalarValue,
} from './descriptor'

export type { Rotation, Tensor, Vars, Vec3 } from './types'
export type { VarsSchemaEntry } from './vars'
export type {
  CanonicalGeometryTransformAttributes,
  Geometry,
  GeometryAttributes,
  GeometryGroupMap,
  GeometrySurfaceRef,
  GeometryIdentityAttributes,
  GeometryInvocationAttributes,
  GeometryTransformAttributes,
  IntrinsicGeometryAttributes,
  SurfaceGroupMap,
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
  MatrixValue,
  NonFloatDataDType,
  PersistedDataTensor,
  RecordedData,
  RecordedDataAxis,
  RecordedDataGroup,
  RecordedDataNode,
  DataTensorInput,
  RecordedDataResult,
  RecordedDataResultAxis,
  RecordedDataRule,
  RecordedDataTensor,
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

export function radians(degrees: number): number
export function radians(degrees: Vec3): Vec3
export function radians(degrees: number | Vec3): number | Vec3 {
  return typeof degrees === 'number'
    ? (degrees * Math.PI) / 180
    : Object.freeze(degrees.map((value) => (value * Math.PI) / 180) as [number, number, number])
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeRawScalar(value: unknown, _path: string): ScalarValue {
  return value as ScalarValue
}

export function isFloatDType(dtype: DataDType) {
  return dtype === 'float16' || dtype === 'float32' || dtype === 'float64'
}

export function normalizeDataElement(value: unknown, _dtype: DataDType, _path: string) {
  return value as boolean | string | number
}

export function normalizeDataValue(
  value: unknown,
  _shape: readonly number[],
  _dtype: DataDType,
  _path: string,
): boolean | string | number | readonly unknown[] {
  return value as boolean | string | number | readonly unknown[]
}

export function normalizeDataValueDescriptor(value: unknown, _path = 'Data value descriptor'): DataValueDescriptor {
  return value as DataValueDescriptor
}

let activeVars: Readonly<Vars> | null = null

export const vars = new Proxy<Record<string, Tensor>>(
  {},
  {
    deleteProperty() { throw new CadModelError('Global vars is read-only.') },
    get(_target, key) {
      if (activeVars === null) throw new CadModelError('Global vars is only available while CAD source is being evaluated.')
      return typeof key === 'symbol' ? undefined : activeVars[key]
    },
    getOwnPropertyDescriptor(_target, key) {
      if (activeVars === null || typeof key === 'symbol' || !(key in activeVars)) return undefined
      return { configurable: true, enumerable: true, value: activeVars[key], writable: false }
    },
    has(_target, key) { return activeVars !== null && typeof key === 'string' && key in activeVars },
    ownKeys() { return activeVars === null ? [] : Reflect.ownKeys(activeVars) },
    set() { throw new CadModelError('Global vars is read-only.') },
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
