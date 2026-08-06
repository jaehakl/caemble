import { getListRequest, type GetListRequest, type MaterialNameRecord, type MaterialRecord } from '@/api'
import { materialModelData, materialParameterCatalog, materialParameterData } from '@/lib/material'
import { kernelModules } from '@/lib/cad/simulation'

export const dedicatedQualifierNames = Object.freeze(['temperature', 'pressure', 'frequency', 'source'] as const)

export const materialCatalogEntries = Object.freeze([
  ...materialParameterData.map((entry) => ({
    domain: entry.key.split('.')[0],
    key: entry.key,
    kind: 'parameter' as const,
    label: entry.label_ko,
    quantityKind: entry.quantity_kind,
  })),
  ...materialModelData.map((entry) => ({
    domain: 'model',
    key: entry.key,
    kind: 'model' as const,
    label: entry.label_ko,
    quantityKind: `${entry.input.quantity_kind} → ${entry.output.quantity_kind}`,
  })),
])

const materialCatalogKeySet = new Set<string>(materialCatalogEntries.map((entry) => entry.key))
const dedicatedQualifierNameSet = new Set<string>(dedicatedQualifierNames)

export function isMaterialColorValid(value: string) {
  return !value.trim() || /^#[0-9a-f]{6}$/i.test(value.trim())
}

export function isMaterialCatalogKey(value: string) {
  return materialCatalogKeySet.has(value)
}

export function isDedicatedQualifierName(value: string) {
  return dedicatedQualifierNameSet.has(value)
}

export function getQualifierNames(parameterName: string): string[] {
  const parameter = materialParameterData.find((entry) => entry.key === parameterName)
  return [
    ...new Set([
      ...materialParameterCatalog.global_qualifiers,
      ...(parameter && 'special_qualifiers' in parameter ? (parameter.special_qualifiers ?? []) : []),
    ]),
  ]
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

export function getSolverReadiness(parameterNames: Iterable<string>) {
  const availableNames = new Set(parameterNames)
  return kernelModules.map(({ descriptor: spec }) => {
    const roles = spec.materials.map((role) => {
      const required = Object.entries(role.properties)
        .filter(([, parameter]) => !('required' in parameter) || parameter.required !== false)
        .map(([name]) => name)
      const missing = required.filter((name) => !availableNames.has(name))
      return { role, required, missing, available: missing.length === 0 }
    })
    return {
      spec,
      roles,
      available: roles.length === 0 || roles.some((role) => role.available),
    }
  })
}
