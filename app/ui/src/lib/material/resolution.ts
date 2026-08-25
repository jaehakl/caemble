import type {
  MaterialNameRecord,
  MaterialParameterQualifierRecord,
  MaterialParameterRecord,
  MaterialRecord,
} from '@/api'
import type { CadSceneMaterial } from '../cad/evaluation/types'
import { applyMaterialErrorMultiplier, normalizeDataValueDescriptor } from '../cad/model/core'
import { QuantityKind } from '../quantitykind'
import { getRuntimeMaterialModel, getRuntimeMaterialParameter } from '../catalog/runtime'

export type MaterialPropertyValue = Readonly<{
  dtype: 'float16' | 'float32' | 'float64'
  value: number | readonly unknown[]
  unit: string
  axes?: readonly [
    Readonly<{
      length: number
      name: 'frequency'
      ticks: readonly number[]
      unit: 'Hz'
      quantityKind: 'Frequency'
    }>,
  ]
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
  schemaVersion: 1
  materials: Readonly<Record<string, Readonly<Record<string, FrozenMaterialParameter>>>>
  materialColors?: Readonly<Record<string, Readonly<{ color: string; materialId: number }>>>
}>

export type MaterialResolution = Readonly<{
  materialParameters: FrozenMaterialParameters
  warnings: readonly string[]
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function propertyValue(name: string, value: unknown): MaterialPropertyValue | null {
  const definition = getRuntimeMaterialParameter(name)
  if (!definition || !isRecord(value) || !exactKeys(value, ['dtype', 'value', 'unit'])) return null
  if (!['float16', 'float32', 'float64'].includes(String(value.dtype)) || typeof value.unit !== 'string') return null
  if (!(QuantityKind[definition.quantityKind].applicableUnits() as readonly string[]).includes(value.unit)) return null
  try {
    const normalized = normalizeDataValueDescriptor(
      {
        dtype: value.dtype as MaterialPropertyValue['dtype'],
        value: value.value as number | readonly unknown[],
        unit: value.unit,
        quantityKind: definition.quantityKind,
      },
      `Material parameter ${name}`,
    )
    return Object.freeze({
      dtype: value.dtype as MaterialPropertyValue['dtype'],
      value: normalized.value as number | readonly unknown[],
      unit: value.unit,
    })
  } catch {
    return null
  }
}

function frequencyPropertyValue(name: string, value: unknown): MaterialPropertyValue | null {
  const definition = getRuntimeMaterialParameter(name)
  if (
    !definition ||
    !definition.specialQualifiers.some(
      (qualifier) => qualifier === 'frequency' || qualifier === 'wavelength_or_frequency',
    ) ||
    !isRecord(value) ||
    !exactKeys(value, ['dtype', 'value', 'unit', 'axes']) ||
    value.dtype !== 'float64' ||
    typeof value.unit !== 'string' ||
    !Array.isArray(value.value) ||
    !Array.isArray(value.axes) ||
    value.axes.length !== 1
  )
    return null

  const axis = value.axes[0]
  if (
    !isRecord(axis) ||
    !exactKeys(axis, ['length', 'name', 'ticks', 'unit', 'quantityKind']) ||
    !Number.isSafeInteger(axis.length) ||
    (axis.length as number) < 2 ||
    axis.name !== 'frequency' ||
    axis.unit !== 'Hz' ||
    axis.quantityKind !== 'Frequency' ||
    !Array.isArray(axis.ticks) ||
    axis.ticks.length !== axis.length ||
    value.value.length !== axis.length ||
    axis.ticks.some((tick) => typeof tick !== 'number' || !Number.isFinite(tick) || tick <= 0) ||
    axis.ticks.some((tick, index) => index > 0 && tick <= (axis.ticks as number[])[index - 1])
  )
    return null

  const samples = value.value.map(
    (sample) => propertyValue(name, { dtype: 'float64', value: sample, unit: value.unit })?.value,
  )
  if (samples.some((sample) => sample === undefined)) return null
  const normalizedAxis = Object.freeze({
    length: axis.length as number,
    name: 'frequency' as const,
    ticks: Object.freeze([...(axis.ticks as number[])]),
    unit: 'Hz' as const,
    quantityKind: 'Frequency' as const,
  })
  return Object.freeze({
    dtype: 'float64',
    value: Object.freeze(samples) as readonly unknown[],
    unit: value.unit,
    axes: Object.freeze([normalizedAxis] as const),
  })
}

function relationValue(name: string, value: unknown): MaterialRelationValue | null {
  const definition = getRuntimeMaterialModel(name)
  if (
    !definition ||
    !isRecord(value) ||
    !exactKeys(value, ['kind', 'input', 'output']) ||
    value.kind !== 'sampled_relation' ||
    !isRecord(value.input) ||
    !isRecord(value.output) ||
    !exactKeys(value.input, ['unit', 'values']) ||
    !exactKeys(value.output, ['unit', 'values']) ||
    typeof value.input.unit !== 'string' ||
    typeof value.output.unit !== 'string' ||
    !Array.isArray(value.input.values) ||
    !Array.isArray(value.output.values) ||
    value.input.values.length < definition.minimumSamples ||
    value.input.values.length !== value.output.values.length ||
    !(QuantityKind[definition.input.quantityKind].applicableUnits() as readonly string[]).includes(value.input.unit) ||
    !(QuantityKind[definition.output.quantityKind].applicableUnits() as readonly string[]).includes(value.output.unit)
  )
    return null
  const input = value.input as { unit: string; values: unknown[] }
  const output = value.output as { unit: string; values: unknown[] }
  try {
    const inputValues = input.values.map(
      (sample, index) =>
        normalizeDataValueDescriptor(
          {
            dtype: 'float64',
            value: sample as number | readonly unknown[],
            unit: input.unit as string,
            quantityKind: definition.input.quantityKind,
          },
          `Material model ${name} input[${index}]`,
        ).value,
    )
    const outputValues = output.values.map(
      (sample, index) =>
        normalizeDataValueDescriptor(
          {
            dtype: 'float64',
            value: sample as number | readonly unknown[],
            unit: output.unit as string,
            quantityKind: definition.output.quantityKind,
          },
          `Material model ${name} output[${index}]`,
        ).value,
    )
    return Object.freeze({
      kind: 'sampled_relation',
      input: Object.freeze({ unit: input.unit, values: Object.freeze(inputValues) }),
      output: Object.freeze({ unit: output.unit, values: Object.freeze(outputValues) }),
    })
  } catch {
    return null
  }
}

function frozenCatalogValue(name: string, value: unknown) {
  return propertyValue(name, value) ?? frequencyPropertyValue(name, value) ?? relationValue(name, value)
}

function sourceCatalogValue(name: string, value: unknown) {
  if (getRuntimeMaterialParameter(name) && isRecord(value)) {
    return propertyValue(name, { dtype: value.dtype, value: value.value, unit: value.unit })
  }
  if (getRuntimeMaterialModel(name) && isRecord(value) && isRecord(value.input) && isRecord(value.output)) {
    return relationValue(name, {
      kind: value.kind,
      input: { unit: value.input.unit, values: value.input.values },
      output: { unit: value.output.unit, values: value.output.values },
    })
  }
  return relationValue(name, value)
}

function sampleProperty(value: MaterialPropertyValue, errorRate: number, path: string) {
  if (errorRate === 0) return value
  const multiplier = 1 - errorRate + 2 * errorRate * Math.random()
  return Object.freeze({
    ...value,
    value: applyMaterialErrorMultiplier(value.value, value.dtype, multiplier, `${path}.value`),
  })
}

function timestamp(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function newestPrivateFirst<T extends { id?: number; updated_at?: string | null; user_id?: string | null }>(
  left: T,
  right: T,
) {
  const privacy = Number(right.user_id != null) - Number(left.user_id != null)
  if (privacy) return privacy
  const recency = timestamp(right.updated_at) - timestamp(left.updated_at)
  return recency || (right.id ?? 0) - (left.id ?? 0)
}

function canonical(value: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))))
}

export function sourceOnlyMaterialParameters(materials: readonly CadSceneMaterial[]): MaterialResolution {
  return resolveMaterialParameters(materials, [], [], {
    sourceOnly: true,
    warnings: ['Legacy Material snapshot: database parameters were not automatically re-resolved.'],
  })
}

export function projectMaterialResolution(
  resolution: MaterialResolution,
  materials: readonly CadSceneMaterial[],
): MaterialResolution {
  const names = new Set(materials.map((material) => material.name))
  const projectedMaterials = Object.freeze(
    Object.fromEntries(Object.entries(resolution.materialParameters.materials).filter(([name]) => names.has(name))),
  )
  const projectedColors = Object.freeze(
    Object.fromEntries(
      Object.entries(resolution.materialParameters.materialColors ?? {}).filter(([name]) => names.has(name)),
    ),
  )
  const warnings = resolution.warnings.filter((warning) => {
    if (!warning.startsWith('Material ')) return true
    return [...names].some((name) => warning.startsWith(`Material ${name}:`))
  })
  return Object.freeze({
    materialParameters: Object.freeze({
      schemaVersion: 1,
      materials: projectedMaterials,
      ...(resolution.materialParameters.materialColors === undefined ? {} : { materialColors: projectedColors }),
    }) as FrozenMaterialParameters,
    warnings: Object.freeze(warnings),
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
  const resolved: Record<string, Record<string, unknown>> = {}
  const materialColors: Record<string, Readonly<{ color: string; materialId: number }>> = {}
  const declarations = new Map<string, string>()

  sceneMaterials.forEach((material) => {
    const declaration = JSON.stringify(material)
    const previousDeclaration = declarations.get(material.name)
    if (previousDeclaration !== undefined) {
      if (previousDeclaration !== declaration) {
        throw new Error(`Material ${material.name} resolves to conflicting parameter sets.`)
      }
      return
    }
    declarations.set(material.name, declaration)

    if (options.sourceOnly) {
      warnings.push(
        `Material ${material.name}: database catalog values are unavailable in source-only mode; only explicit source parameters are used.`,
      )
    }

    const explicit = new Map<string, MaterialPropertyValue | MaterialRelationValue>()
    Object.entries(material.variables).forEach(([name, value]) => {
      if (name === 'color') return
      const normalized = sourceCatalogValue(name, value)
      if (!normalized) throw new Error(`Material ${material.name} source parameter ${name} is invalid.`)
      const sourceValue = value as unknown
      const errorRate =
        isRecord(sourceValue) && typeof sourceValue.errorRate === 'number' && Number.isFinite(sourceValue.errorRate)
          ? sourceValue.errorRate
          : 0
      explicit.set(
        name,
        getRuntimeMaterialParameter(name)
          ? sampleProperty(
              normalized as MaterialPropertyValue,
              errorRate,
              `Material ${material.name} source parameter ${name}`,
            )
          : normalized,
      )
    })

    const values: Record<string, unknown> = {}
    const matchedName = options.sourceOnly
      ? undefined
      : names.filter((row) => row.name === material.name).sort(newestPrivateFirst)[0]
    if (!matchedName && !options.sourceOnly) {
      warnings.push(`Material ${material.name} was not found; only source parameters are available.`)
    }

    if (matchedName) {
      const databaseMaterial = options.materials?.find((row) => row.id === matchedName.material_id)
      if (
        material.variables.color === undefined &&
        databaseMaterial?.color &&
        /^#[0-9a-f]{6}$/i.test(databaseMaterial.color)
      ) {
        materialColors[material.name] = Object.freeze({
          color: databaseMaterial.color.toLowerCase(),
          materialId: matchedName.material_id,
        })
      }
      const grouped = new Map<string, MaterialParameterRecord[]>()
      parameters
        .filter((row) => row.material_id === matchedName.material_id)
        .forEach((row) => {
          grouped.set(row.name, [...(grouped.get(row.name) ?? []), row])
        })
      grouped.forEach((candidates, name) => {
        if (explicit.has(name)) return
        const propertyDefinition = getRuntimeMaterialParameter(name)
        const modelDefinition = getRuntimeMaterialModel(name)
        if (!propertyDefinition && !modelDefinition) {
          warnings.push(`Material ${material.name} parameter ${name} is outside the catalog and was skipped.`)
          return
        }
        const tier = (candidate: MaterialParameterRecord) => {
          if (material.source && material.version) {
            if (candidate.source === material.source && candidate.version === material.version) return 0
            if (candidate.source === material.source) return 1
            return 2
          }
          if (material.source) return candidate.source === material.source ? 0 : 1
          return 0
        }
        const ordered = [...candidates].sort(
          (left, right) => tier(left) - tier(right) || newestPrivateFirst(left, right),
        )
        let selected = ordered[0]
        let materialParameterId = selected.id ?? null
        let normalized: MaterialPropertyValue | MaterialRelationValue | null

        if (propertyDefinition) {
          const qualifierKey = (candidate: MaterialParameterRecord) =>
            JSON.stringify(
              (options.qualifiers ?? [])
                .filter((qualifier) => qualifier.material_parameter_id === candidate.id)
                .map((qualifier) => [qualifier.name, qualifier.value] as const)
                .sort(
                  ([leftName, leftValue], [rightName, rightValue]) =>
                    leftName.localeCompare(rightName) || leftValue - rightValue,
                ),
            )
          const selectedQualifierKey = qualifierKey(selected)
          const cohort = ordered.filter(
            (candidate) =>
              (candidate.user_id != null) === (selected.user_id != null) &&
              (candidate.source ?? null) === (selected.source ?? null) &&
              (candidate.version ?? null) === (selected.version ?? null) &&
              (candidate.temperature ?? null) === (selected.temperature ?? null) &&
              (candidate.pressure ?? null) === (selected.pressure ?? null) &&
              qualifierKey(candidate) === selectedQualifierKey,
          )
          const scalarRows = cohort.filter((candidate) => candidate.frequency == null)
          const frequencyRows = cohort.filter((candidate) => candidate.frequency != null)
          if (scalarRows.length > 0 && frequencyRows.length > 0) {
            throw new Error(
              `Material ${material.name} database parameter ${name} cannot mix scalar and frequency rows in one source/version/privacy/condition cohort.`,
            )
          }

          if (frequencyRows.length > 0) {
            if (
              !propertyDefinition.specialQualifiers.some(
                (qualifier) => qualifier === 'frequency' || qualifier === 'wavelength_or_frequency',
              )
            ) {
              throw new Error(`Material ${material.name} database parameter ${name} does not support frequency rows.`)
            }
            frequencyRows.forEach((candidate) => {
              if (
                typeof candidate.frequency !== 'number' ||
                !Number.isFinite(candidate.frequency) ||
                candidate.frequency <= 0
              ) {
                throw new Error(
                  `Material ${material.name} database parameter ${name} frequency must be a positive finite Hz value.`,
                )
              }
            })
            frequencyRows.sort((left, right) => left.frequency! - right.frequency!)
            if (frequencyRows.length < 2) {
              throw new Error(
                `Material ${material.name} database parameter ${name} frequency series requires at least two rows.`,
              )
            }
            if (
              frequencyRows.some(
                (candidate, index) => index > 0 && candidate.frequency === frequencyRows[index - 1].frequency,
              )
            ) {
              throw new Error(`Material ${material.name} database parameter ${name} has duplicate frequency rows.`)
            }
            const samples = frequencyRows.map((candidate) => propertyValue(name, candidate.value))
            if (samples.some((sample) => sample === null)) {
              throw new Error(`Material ${material.name} database parameter ${name} has an invalid frequency sample.`)
            }
            const typedSamples = samples as MaterialPropertyValue[]
            const unit = typedSamples[0].unit
            const quantityKind = QuantityKind[propertyDefinition.quantityKind]
            normalized = frequencyPropertyValue(name, {
              dtype: 'float64',
              value: typedSamples.map((sample) => quantityKind.transform(sample.value, sample.unit, unit)),
              unit,
              axes: [
                {
                  length: frequencyRows.length,
                  name: 'frequency',
                  ticks: frequencyRows.map((candidate) => candidate.frequency),
                  unit: 'Hz',
                  quantityKind: 'Frequency',
                },
              ],
            })
            materialParameterId = null
          } else {
            selected = [...scalarRows].sort(newestPrivateFirst)[0]
            normalized = propertyValue(name, selected.value)
          }
        } else {
          if (selected.frequency != null) {
            throw new Error(`Material ${material.name} database model ${name} cannot use frequency rows.`)
          }
          normalized = relationValue(name, selected.value)
        }

        const value =
          normalized && propertyDefinition
            ? sampleProperty(
                normalized as MaterialPropertyValue,
                material.errorRate ?? 0,
                `Material ${material.name} database parameter ${name}`,
              )
            : normalized
        if (!value) throw new Error(`Material ${material.name} database parameter ${name} is invalid.`)
        values[name] = Object.freeze({
          origin: 'database',
          value,
          source: selected.source ?? null,
          version: selected.version ?? null,
          materialId: selected.material_id,
          materialParameterId,
        })
      })
    }

    explicit.forEach((value, name) => {
      values[name] = Object.freeze({
        origin: 'source',
        value,
        source: null,
        version: null,
        materialId: null,
        materialParameterId: null,
      })
    })

    const previous = resolved[material.name]
    if (previous && canonical(previous) !== canonical(values)) {
      throw new Error(`Material ${material.name} resolves to conflicting parameter sets.`)
    }
    resolved[material.name] = values
  })

  return Object.freeze({
    materialParameters: Object.freeze({
      schemaVersion: 1,
      materials: Object.freeze(resolved),
      materialColors: Object.freeze(materialColors),
    }) as FrozenMaterialParameters,
    warnings: Object.freeze([...new Set(warnings)]),
  })
}

export function readFrozenMaterialParameters(value: unknown): FrozenMaterialParameters | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.materials)) return null
  if (value.materialColors !== undefined) {
    if (!isRecord(value.materialColors)) return null
    for (const entry of Object.values(value.materialColors)) {
      if (
        !isRecord(entry) ||
        !exactKeys(entry, ['color', 'materialId']) ||
        typeof entry.color !== 'string' ||
        !/^#[0-9a-f]{6}$/.test(entry.color) ||
        !Number.isSafeInteger(entry.materialId)
      )
        return null
    }
  }
  for (const parameters of Object.values(value.materials)) {
    if (!isRecord(parameters)) return null
    for (const [name, entry] of Object.entries(parameters)) {
      if (
        !isRecord(entry) ||
        !exactKeys(entry, ['origin', 'value', 'source', 'version', 'materialId', 'materialParameterId']) ||
        (entry.origin !== 'database' && entry.origin !== 'source') ||
        (entry.source !== null && typeof entry.source !== 'string') ||
        (entry.version !== null && typeof entry.version !== 'string') ||
        (entry.materialId !== null && !Number.isSafeInteger(entry.materialId)) ||
        (entry.materialParameterId !== null && !Number.isSafeInteger(entry.materialParameterId)) ||
        !frozenCatalogValue(name, entry.value) ||
        (frequencyPropertyValue(name, entry.value) !== null &&
          (entry.origin !== 'database' || entry.materialId === null || entry.materialParameterId !== null))
      )
        return null
    }
  }
  return value as FrozenMaterialParameters
}
