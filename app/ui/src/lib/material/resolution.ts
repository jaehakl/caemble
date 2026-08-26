import type {
  MaterialNameRecord,
  MaterialParameterQualifierRecord,
  MaterialParameterRecord,
  MaterialRecord,
} from '@/api'
import type { CadSceneMaterial } from '../cad/evaluation/types'
import { applyMaterialErrorMultiplier } from '../cad/model/core'
import { QuantityKind } from '../quantitykind'
import { getRuntimeMaterialModel, getRuntimeMaterialParameter } from '../catalog/runtime'

export type MaterialPropertyValue = Readonly<{
  dtype: 'float16' | 'float32' | 'float64'
  value: number | readonly unknown[]
  unit: string
  axes?: readonly [Readonly<{
    length: number
    name: 'frequency'
    ticks: readonly number[]
    unit: 'Hz'
    quantityKind: 'Frequency'
  }>]
}>

export type MaterialRelationValue = Readonly<{
  kind: 'sampled_relation'
  input: Readonly<{ unit: string; values: readonly unknown[] }>
  output: Readonly<{ unit: string; values: readonly unknown[] }>
}>

type FrozenMaterialParameter = Readonly<{
  origin: 'database' | 'source'
  value: MaterialPropertyValue | MaterialRelationValue
  source: string | null
  version: string | null
  materialId: number | null
  materialParameterId: number | null
}>

export type FrozenMaterialParameters = Readonly<{
  materials: Readonly<Record<string, Readonly<Record<string, FrozenMaterialParameter>>>>
  materialColors?: Readonly<Record<string, Readonly<{ color: string; materialId: number }>>>
}>

export type MaterialResolution = Readonly<{
  materialParameters: FrozenMaterialParameters
  warnings: readonly string[]
}>

function propertyValue(value: unknown): MaterialPropertyValue {
  return value as MaterialPropertyValue
}

function frequencyPropertyValue(name: string, rows: readonly MaterialParameterRecord[]): MaterialPropertyValue {
  const definition = getRuntimeMaterialParameter(name)!
  const values = rows.map((row) => propertyValue(row.value))
  const unit = values[0].unit
  const quantityKind = QuantityKind[definition.quantityKind]
  return Object.freeze({
    dtype: 'float64',
    value: Object.freeze(values.map((sample) => quantityKind.transform(sample.value, sample.unit, unit))),
    unit,
    axes: Object.freeze([Object.freeze({
      length: rows.length,
      name: 'frequency' as const,
      ticks: Object.freeze(rows.map((row) => row.frequency!)),
      unit: 'Hz' as const,
      quantityKind: 'Frequency' as const,
    })] as const),
  })
}

function relationValue(value: unknown): MaterialRelationValue {
  return value as MaterialRelationValue
}

function sourceCatalogValue(name: string, value: unknown): MaterialPropertyValue | MaterialRelationValue {
  return getRuntimeMaterialParameter(name) ? propertyValue(value) : relationValue(value)
}

function sampleProperty(value: MaterialPropertyValue, errorRate: number, path: string) {
  if (errorRate === 0) return value
  const multiplier = 1 - errorRate + 2 * errorRate * Math.random()
  return Object.freeze({ ...value, value: applyMaterialErrorMultiplier(value.value, value.dtype, multiplier, path) })
}

function timestamp(value: string | null | undefined) {
  return value ? Date.parse(value) : 0
}

function newestPrivateFirst<T extends { id?: number; updated_at?: string | null; user_id?: string | null }>(left: T, right: T) {
  const privacy = Number(right.user_id != null) - Number(left.user_id != null)
  return privacy || timestamp(right.updated_at) - timestamp(left.updated_at) || (right.id ?? 0) - (left.id ?? 0)
}

export function sourceOnlyMaterialParameters(materials: readonly CadSceneMaterial[]): MaterialResolution {
  return resolveMaterialParameters(materials, [], [], {
    sourceOnly: true,
    warnings: ['Source-only Material resolution does not include database catalog parameters.'],
  })
}

export function projectMaterialResolution(resolution: MaterialResolution, materials: readonly CadSceneMaterial[]): MaterialResolution {
  const names = new Set(materials.map((material) => material.name))
  const projectedMaterials = Object.freeze(
    Object.fromEntries(Object.entries(resolution.materialParameters.materials).filter(([name]) => names.has(name))),
  )
  const projectedColors = Object.freeze(
    Object.fromEntries(Object.entries(resolution.materialParameters.materialColors ?? {}).filter(([name]) => names.has(name))),
  )
  return Object.freeze({
    materialParameters: Object.freeze({
      materials: projectedMaterials,
      ...(resolution.materialParameters.materialColors === undefined ? {} : { materialColors: projectedColors }),
    }) as FrozenMaterialParameters,
    warnings: Object.freeze(resolution.warnings.filter((warning) => !warning.startsWith('Material ') || [...names].some((name) => warning.startsWith(`Material ${name}:`)))),
  })
}

export function resolveMaterialParameters(
  sceneMaterials: readonly CadSceneMaterial[],
  names: readonly MaterialNameRecord[],
  parameters: readonly MaterialParameterRecord[],
  options: Readonly<{
    materials?: readonly MaterialRecord[]
    qualifiers?: readonly MaterialParameterQualifierRecord[]
    sourceOnly?: boolean
    warnings?: string[]
  }> = {},
): MaterialResolution {
  const warnings = options.warnings ?? []
  const resolved: Record<string, Record<string, FrozenMaterialParameter>> = {}
  const materialColors: Record<string, Readonly<{ color: string; materialId: number }>> = {}

  sceneMaterials.forEach((material) => {
    const explicit = new Map<string, MaterialPropertyValue | MaterialRelationValue>()
    Object.entries(material.variables).forEach(([name, value]) => {
      if (name === 'color') return
      const normalized = sourceCatalogValue(name, value)
      const errorRate = typeof (value as { errorRate?: unknown })?.errorRate === 'number'
        ? (value as { errorRate: number }).errorRate
        : 0
      explicit.set(name, getRuntimeMaterialParameter(name)
        ? sampleProperty(normalized as MaterialPropertyValue, errorRate, `Material ${material.name}.${name}`)
        : normalized)
    })

    const values: Record<string, FrozenMaterialParameter> = {}
    const matchedName = options.sourceOnly ? undefined : names.filter((row) => row.name === material.name).sort(newestPrivateFirst)[0]
    if (matchedName) {
      const databaseMaterial = options.materials?.find((row) => row.id === matchedName.material_id)
      if (material.variables.color === undefined && databaseMaterial?.color) {
        materialColors[material.name] = Object.freeze({ color: databaseMaterial.color, materialId: matchedName.material_id })
      }
      const grouped = new Map<string, MaterialParameterRecord[]>()
      parameters.filter((row) => row.material_id === matchedName.material_id).forEach((row) => {
        grouped.set(row.name, [...(grouped.get(row.name) ?? []), row])
      })
      grouped.forEach((candidates, name) => {
        if (explicit.has(name)) return
        const ordered = [...candidates].sort(newestPrivateFirst)
        const selected = ordered[0]
        const frequencyRows = ordered.filter((row) => row.frequency != null).sort((left, right) => left.frequency! - right.frequency!)
        const normalized = frequencyRows.length > 0
          ? frequencyPropertyValue(name, frequencyRows)
          : getRuntimeMaterialModel(name)
            ? relationValue(selected.value)
            : propertyValue(selected.value)
        const sampled = getRuntimeMaterialParameter(name)
          ? sampleProperty(normalized as MaterialPropertyValue, material.errorRate ?? 0, `Material ${material.name}.${name}`)
          : normalized
        values[name] = Object.freeze({
          origin: 'database',
          value: sampled,
          source: selected.source ?? null,
          version: selected.version ?? null,
          materialId: selected.material_id,
          materialParameterId: frequencyRows.length > 0 ? null : selected.id ?? null,
        })
      })
    }

    explicit.forEach((value, name) => {
      values[name] = Object.freeze({
        origin: 'source', value, source: null, version: null, materialId: null, materialParameterId: null,
      })
    })
    resolved[material.name] = values
  })

  return Object.freeze({
    materialParameters: Object.freeze({ materials: Object.freeze(resolved), materialColors: Object.freeze(materialColors) }),
    warnings: Object.freeze([...new Set(warnings)]),
  })
}

export function readFrozenMaterialParameters(value: unknown): FrozenMaterialParameters | null {
  return value as FrozenMaterialParameters
}
