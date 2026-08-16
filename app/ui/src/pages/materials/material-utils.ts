import { getListRequest, type GetListRequest, type MaterialNameRecord, type MaterialRecord } from '@/api'
import type { CatalogRuntimeSlice } from '@/api/catalog'

export const dedicatedQualifierNames = Object.freeze(['temperature', 'pressure', 'frequency', 'source'] as const)

const dedicatedQualifierNameSet = new Set<string>(dedicatedQualifierNames)

export function isMaterialColorValid(value: string) {
  return !value.trim() || /^#[0-9a-f]{6}$/i.test(value.trim())
}

export function isMaterialCatalogKey(value: string, catalog: CatalogRuntimeSlice) {
  return (
    catalog.materialParameters.some((entry) => entry.key === value) ||
    catalog.materialModels.some((entry) => entry.key === value)
  )
}

export function isDedicatedQualifierName(value: string) {
  return dedicatedQualifierNameSet.has(value)
}

export function getQualifierNames(parameterName: string, catalog: CatalogRuntimeSlice): string[] {
  const parameter = catalog.materialParameters.find((entry) => entry.key === parameterName)
  return [...new Set([...catalog.materialGlobalQualifiers, ...(parameter?.specialQualifiers ?? [])])]
    .filter((name) => !isDedicatedQualifierName(name))
    .sort((left, right) => left.localeCompare(right))
}

export function allRowsRequest(scope: NonNullable<GetListRequest['scope']> = 'visible'): GetListRequest {
  return { ...getListRequest(scope), limit: null }
}

export function relationRowsRequest(field: string, id: number): GetListRequest {
  return { ...allRowsRequest(), filter: { [field]: [id, id] } }
}

export function materialDisplayName(material: MaterialRecord, names: readonly MaterialNameRecord[]) {
  const visibleNames = names
    .filter((entry) => entry.material_id === material.id)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
  return visibleNames[0] ?? `Material #${material.id}`
}
