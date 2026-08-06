import { normalizeDataValueDescriptor, type FloatDataDType } from '@/lib/cad'
import {
  materialModelData,
  materialParameterData,
  type MaterialModelDefinition,
  type MaterialParameterDefinition,
} from '@/lib/material'
import { QuantityKind } from '@/lib/quantitykind'

export const materialFloatDTypes = Object.freeze(['float16', 'float32', 'float64'] as const)

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

export function getMaterialProperty(name: string): MaterialParameterDefinition | undefined {
  return materialParameterData.find((entry) => entry.key === name)
}

export function getMaterialModel(name: string): MaterialModelDefinition | undefined {
  return materialModelData.find((entry) => entry.key === name)
}

export function getQuantityValueConfig(quantityKind: MaterialParameterDefinition['quantity_kind']) {
  const definition = QuantityKind[quantityKind]
  return {
    shape: definition.componentShape() as readonly number[],
    units: definition.applicableUnits() as readonly string[],
  }
}

export function readMaterialPropertyValue(
  definition: MaterialParameterDefinition,
  value: unknown,
): MaterialPropertyValue | null {
  if (!isRecord(value) || !hasExactKeys(value, ['dtype', 'value', 'unit'])) return null
  if (!materialFloatDTypes.includes(value.dtype as FloatDataDType) || typeof value.unit !== 'string') return null

  const { units } = getQuantityValueConfig(definition.quantity_kind)
  if (!units.includes(value.unit)) return null

  try {
    const normalized = normalizeDataValueDescriptor(
      {
        dtype: value.dtype as FloatDataDType,
        value: value.value as number | readonly unknown[],
        unit: value.unit,
        quantityKind: definition.quantity_kind,
      },
      'Material parameter',
    )
    return {
      dtype: value.dtype as FloatDataDType,
      value: normalized.value as number | readonly unknown[],
      unit: value.unit,
    }
  } catch {
    return null
  }
}

export function createMaterialPropertyValue(
  definition: MaterialParameterDefinition,
  dtype: FloatDataDType,
  value: unknown,
  unit: string,
): MaterialPropertyValue {
  const { units } = getQuantityValueConfig(definition.quantity_kind)
  if (!units.includes(unit)) {
    throw new Error(`${unit || '선택하지 않은 unit'}은(는) ${definition.quantity_kind}에서 사용할 수 없습니다.`)
  }
  const normalized = normalizeDataValueDescriptor(
    {
      dtype,
      value: value as number | readonly unknown[],
      unit,
      quantityKind: definition.quantity_kind,
    },
    'Material parameter',
  )
  return {
    dtype,
    value: normalized.value as number | readonly unknown[],
    unit,
  }
}

export function readMaterialRelationValue(
  definition: MaterialModelDefinition,
  value: unknown,
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
): MaterialRelationValue {
  if (inputValues.length < definition.minimum_samples) {
    throw new Error(`Material model relation must contain at least ${definition.minimum_samples} samples.`)
  }
  if (inputValues.length !== outputValues.length) {
    throw new Error('Material model relation input and output must contain the same number of samples.')
  }
  const normalizedInput = inputValues.map(
    (value, index) =>
      normalizeDataValueDescriptor(
        {
          dtype: 'float64',
          value: value as number | readonly unknown[],
          unit: inputUnit,
          quantityKind: definition.input.quantity_kind,
        },
        `Material model relation input.values[${index}]`,
      ).value,
  )
  const normalizedOutput = outputValues.map(
    (value, index) =>
      normalizeDataValueDescriptor(
        {
          dtype: 'float64',
          value: value as number | readonly unknown[],
          unit: outputUnit,
          quantityKind: definition.output.quantity_kind,
        },
        `Material model relation output.values[${index}]`,
      ).value,
  )
  return {
    kind: 'sampled_relation',
    input: { unit: inputUnit, values: normalizedInput },
    output: { unit: outputUnit, values: normalizedOutput },
  }
}
