import { getRuntimeMaterialParameter } from '../../catalog/runtime'
import type { MaterialModelKey, MaterialPropertyKey } from '../../material/data'
import type { MaterialSampledRelation, ResolvedMaterialDataValueDescriptor } from './descriptor'

export const DEFAULT_MATERIAL_ERROR_RATE = 0.001

export function normalizeMaterialErrorRate(value: unknown, _path: string, fallback = DEFAULT_MATERIAL_ERROR_RATE) {
  return (value ?? fallback) as number
}

export function normalizeMaterialDataValueDescriptor(
  key: MaterialPropertyKey,
  value: Record<string, unknown>,
  _path: string,
  defaultErrorRate = DEFAULT_MATERIAL_ERROR_RATE,
): ResolvedMaterialDataValueDescriptor {
  return Object.freeze({
    ...value,
    quantityKind: getRuntimeMaterialParameter(key)?.quantityKind,
    errorRate: value.errorRate ?? defaultErrorRate,
  }) as ResolvedMaterialDataValueDescriptor
}

export function normalizeMaterialSampledRelation(
  _key: MaterialModelKey,
  value: Record<string, unknown>,
  _path: string,
): MaterialSampledRelation {
  return value as MaterialSampledRelation
}
