import type { CatalogRuntimeSlice } from '@/api/catalog'
import type { FloatDataDType } from '@/lib/cad'

export const materialFloatDTypes = Object.freeze(['float16', 'float32', 'float64'] as const)

export type MaterialPropertyDefinition = Readonly<{
  key: string
  label_ko: string
  quantity_kind: string
  special_qualifiers?: readonly string[]
}>

export type MaterialModelDefinition = Readonly<{
  key: string
  label_ko: string
  kind: 'sampled_relation'
  input: Readonly<{ name: string; quantity_kind: string }>
  output: Readonly<{ name: string; quantity_kind: string }>
  minimum_samples: number
  shared_basis: boolean
}>

export type MaterialPropertyValue = Readonly<{
  dtype: FloatDataDType
  value: number | readonly unknown[]
  unit: string
}>

export type MaterialRelationValue = Readonly<{
  kind: 'sampled_relation'
  input: Readonly<{ unit: string; values: readonly unknown[] }>
  output: Readonly<{ unit: string; values: readonly unknown[] }>
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function normalizeFloatElement(value: unknown, dtype: FloatDataDType, path: string) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${path} must be a finite ${dtype} element.`)
  if (dtype === 'float16' && Math.abs(value) > 65_504) {
    throw new Error(`${path} must be a finite float16 value in [-65504, 65504].`)
  }
  if (dtype === 'float32' && !Number.isFinite(Math.fround(value))) {
    throw new Error(`${path} must be representable as a finite float32 value.`)
  }
  return value
}

function normalizeMaterialValue(
  value: unknown,
  shape: readonly number[],
  dtype: FloatDataDType,
  path: string,
  depth = 0,
): number | readonly unknown[] {
  if (depth === shape.length) return normalizeFloatElement(value, dtype, path)
  if (!Array.isArray(value) || value.length !== shape[depth]) {
    throw new Error(`${path} has an invalid component value; expected shape ${JSON.stringify(shape)}.`)
  }
  return Object.freeze(
    value.map((item, index) => normalizeMaterialValue(item, shape, dtype, `${path}[${index}]`, depth + 1)),
  )
}

export function getMaterialProperty(
  name: string,
  catalog: CatalogRuntimeSlice,
): MaterialPropertyDefinition | undefined {
  const definition = catalog.materialParameters.find((entry) => entry.key === name)
  if (!definition) return undefined
  return {
    key: definition.key,
    label_ko: definition.labelKo,
    quantity_kind: definition.quantityKind,
    ...(definition.specialQualifiers.length ? { special_qualifiers: definition.specialQualifiers } : {}),
  }
}

export function getMaterialModel(name: string, catalog: CatalogRuntimeSlice): MaterialModelDefinition | undefined {
  const definition = catalog.materialModels.find((entry) => entry.key === name)
  if (!definition) return undefined
  return {
    key: definition.key,
    label_ko: definition.labelKo,
    kind: definition.kind,
    input: { name: definition.input.name, quantity_kind: definition.input.quantityKind },
    output: { name: definition.output.name, quantity_kind: definition.output.quantityKind },
    minimum_samples: definition.minimumSamples,
    shared_basis: definition.sharedBasis,
  }
}

export function getQuantityValueConfig(quantityKind: string, catalog: CatalogRuntimeSlice) {
  const definition = catalog.quantityKinds.find((entry) => entry.name === quantityKind)
  if (!definition) throw new Error(`QuantityKind ${quantityKind}의 Catalog 정의가 없습니다.`)
  return {
    shape: Object.freeze(Array.from({ length: definition.tensorOrder }, () => 3)) as readonly number[],
    units: definition.applicableUnits as readonly string[],
  }
}

export function readMaterialPropertyValue(
  definition: MaterialPropertyDefinition,
  value: unknown,
  catalog: CatalogRuntimeSlice,
): MaterialPropertyValue | null {
  if (!isRecord(value) || !hasExactKeys(value, ['dtype', 'value', 'unit'])) return null
  if (!materialFloatDTypes.includes(value.dtype as FloatDataDType) || typeof value.unit !== 'string') return null

  const { shape, units } = getQuantityValueConfig(definition.quantity_kind, catalog)
  if (!units.includes(value.unit)) return null

  try {
    return {
      dtype: value.dtype as FloatDataDType,
      value: normalizeMaterialValue(value.value, shape, value.dtype as FloatDataDType, 'Material parameter'),
      unit: value.unit,
    }
  } catch {
    return null
  }
}

export function createMaterialPropertyValue(
  definition: MaterialPropertyDefinition,
  dtype: FloatDataDType,
  value: unknown,
  unit: string,
  catalog: CatalogRuntimeSlice,
): MaterialPropertyValue {
  const { shape, units } = getQuantityValueConfig(definition.quantity_kind, catalog)
  if (!units.includes(unit)) {
    throw new Error(`${unit || '선택하지 않은 unit'}은(는) ${definition.quantity_kind}에서 사용할 수 없습니다.`)
  }
  return {
    dtype,
    value: normalizeMaterialValue(value, shape, dtype, 'Material parameter'),
    unit,
  }
}

export function readMaterialRelationValue(
  definition: MaterialModelDefinition,
  value: unknown,
  catalog: CatalogRuntimeSlice,
): MaterialRelationValue | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'input', 'output'])) return null
  if (!isRecord(value.input) || !hasExactKeys(value.input, ['unit', 'values'])) return null
  if (!isRecord(value.output) || !hasExactKeys(value.output, ['unit', 'values'])) return null

  try {
    return createMaterialRelationValue(
      definition,
      value.input.unit as string,
      value.output.unit as string,
      value.input.values as readonly unknown[],
      value.output.values as readonly unknown[],
      catalog,
    )
  } catch {
    return null
  }
}

export function createMaterialRelationValue(
  definition: MaterialModelDefinition,
  inputUnit: string,
  outputUnit: string,
  inputValues: readonly unknown[],
  outputValues: readonly unknown[],
  catalog: CatalogRuntimeSlice,
): MaterialRelationValue {
  if (inputValues.length < definition.minimum_samples) {
    throw new Error(`Material model relation must contain at least ${definition.minimum_samples} samples.`)
  }
  if (inputValues.length !== outputValues.length) {
    throw new Error('Material model relation input and output must contain the same number of samples.')
  }
  const inputConfig = getQuantityValueConfig(definition.input.quantity_kind, catalog)
  const outputConfig = getQuantityValueConfig(definition.output.quantity_kind, catalog)
  if (!inputConfig.units.includes(inputUnit) || !outputConfig.units.includes(outputUnit)) {
    throw new Error('Material model relation unit은 해당 QuantityKind에서 사용할 수 없습니다.')
  }
  return {
    kind: 'sampled_relation',
    input: {
      unit: inputUnit,
      values: Object.freeze(
        inputValues.map((value, index) =>
          normalizeMaterialValue(value, inputConfig.shape, 'float64', `Material model relation input.values[${index}]`),
        ),
      ),
    },
    output: {
      unit: outputUnit,
      values: Object.freeze(
        outputValues.map((value, index) =>
          normalizeMaterialValue(
            value,
            outputConfig.shape,
            'float64',
            `Material model relation output.values[${index}]`,
          ),
        ),
      ),
    },
  }
}
