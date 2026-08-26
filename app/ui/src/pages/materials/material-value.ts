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
  return {
    shape: Object.freeze(Array.from({ length: definition!.tensorOrder }, () => 3)) as readonly number[],
    units: definition!.applicableUnits as readonly string[],
  }
}

export function readMaterialPropertyValue(
  definition: MaterialPropertyDefinition,
  value: unknown,
  catalog: CatalogRuntimeSlice,
): MaterialPropertyValue | null {
  if (value == null) return null
  const stored = value as MaterialPropertyValue
  void definition
  void catalog
  return stored
}

export function createMaterialPropertyValue(
  definition: MaterialPropertyDefinition,
  dtype: FloatDataDType,
  value: unknown,
  unit: string,
  catalog: CatalogRuntimeSlice,
): MaterialPropertyValue {
  void definition
  void catalog
  return {
    dtype,
    value: value as number | readonly unknown[],
    unit,
  }
}

export function readMaterialRelationValue(
  definition: MaterialModelDefinition,
  value: unknown,
  catalog: CatalogRuntimeSlice,
): MaterialRelationValue | null {
  if (value == null) return null
  void definition
  void catalog
  return value as MaterialRelationValue
}

export function createMaterialRelationValue(
  definition: MaterialModelDefinition,
  inputUnit: string,
  outputUnit: string,
  inputValues: readonly unknown[],
  outputValues: readonly unknown[],
  catalog: CatalogRuntimeSlice,
): MaterialRelationValue {
  void definition
  void catalog
  return {
    kind: 'sampled_relation',
    input: {
      unit: inputUnit,
      values: Object.freeze([...inputValues]),
    },
    output: {
      unit: outputUnit,
      values: Object.freeze([...outputValues]),
    },
  }
}
