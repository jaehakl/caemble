import type { RecordedData, RecordedDataAxis, RecordedDataRule, RecordedDataTensor, UcumUnit } from '@/lib/cad'
import { convertUcumValue, isDataTensor } from '@/lib/cad'
import { normalizeRecordedDataTensor, type ResolvedRecordedTensor } from '@/lib/cad'
import type { CatalogQuantityKind } from '@/api/catalog'

export type CadViewerRecordedAxis = RecordedDataAxis
export type CadViewerRecordedTensor = RecordedDataTensor
export type CadViewerRecordedData = RecordedData
export type { ResolvedRecordedTensor }
export type RecordedQuantityKinds = ReadonlyMap<string, CatalogQuantityKind>

export type RecordedDataDisplayUnits = Readonly<
  Record<
    string,
    Readonly<{
      axes?: Readonly<Record<number, UcumUnit>>
      result?: UcumUnit
    }>
  >
>

export type RecordedDataDisplayUnitTarget = 'result' | number

export type ResolvedRecordedData = Readonly<{
  entries: readonly Readonly<{
    rule: RecordedDataRule
    tensor: ResolvedRecordedTensor | null
    error: string | null
  }>[]
  error: string | null
  unknownLabels: readonly string[]
}>

function quantityKindDefinition(rule: RecordedDataRule, quantityKinds: RecordedQuantityKinds) {
  if (!rule.result.quantityKind) return undefined
  const definition = quantityKinds.get(rule.result.quantityKind)
  if (!definition) throw new Error(`QuantityKind ${rule.result.quantityKind}의 Catalog 정의가 없습니다.`)
  return definition
}

function appendComponentAxes(value: unknown, outerAxisCount: number, tensorOrder: number): unknown {
  if (tensorOrder === 0 || typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const payload = value as Record<string, unknown>
  const axes = Array.isArray(payload.axes)
    ? payload.axes
    : isDataTensor(value)
      ? undefined
      : Array.from({ length: outerAxisCount }, () => ({}))
  if (!axes) return value
  return {
    ...payload,
    axes: [...axes, ...Array.from({ length: tensorOrder }, () => ({ ticks: [0, 1, 2] }))],
  }
}

export function normalizeCadViewerRecordedTensor(
  rule: RecordedDataRule,
  value: unknown,
  quantityKinds: RecordedQuantityKinds = new Map(),
): ResolvedRecordedTensor {
  const definition = quantityKindDefinition(rule, quantityKinds)
  if (!definition) return normalizeRecordedDataTensor(rule, value)
  const tensorOrder = definition.tensorOrder
  const componentShape = Object.freeze(Array.from({ length: tensorOrder }, () => 3 as const))
  const outerAxisCount = rule.result.axes?.length ?? 0
  const result = Object.fromEntries(
    Object.entries(rule.result).filter(([key]) => key !== 'quantityKind' && key !== 'basis'),
  )
  result.axes = [
    ...(rule.result.axes ?? []),
    ...Array.from({ length: tensorOrder }, (_, index) => ({
      length: 3,
      name: `QuantityKind component ${index}`,
    })),
  ]
  const normalized = normalizeRecordedDataTensor(
    { ...rule, result: result as RecordedDataRule['result'] },
    appendComponentAxes(value, outerAxisCount, tensorOrder),
  )
  const resolved = {
    axes: Object.freeze(normalized.axes.slice(0, outerAxisCount)),
    componentShape,
    tensorOrder,
    dtype: normalized.dtype,
    ...(normalized.unit === undefined ? {} : { unit: normalized.unit }),
    quantityKind: rule.result.quantityKind,
    ...(rule.result.basis === undefined ? {} : { basis: rule.result.basis }),
  }
  return Object.freeze(
    Object.defineProperties(resolved, {
      accessor: { value: normalized.accessor },
      value: { enumerable: true, get: () => normalized.value },
    }),
  ) as ResolvedRecordedTensor
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
}

export function resolveCadViewerRecordedData(
  rules: readonly RecordedDataRule[],
  value: unknown,
  quantityKinds: RecordedQuantityKinds = new Map(),
): ResolvedRecordedData {
  if (value !== null && value !== undefined && !isPlainObject(value)) {
    return Object.freeze({
      entries: Object.freeze(rules.map((rule) => Object.freeze({ rule, tensor: null, error: null }))),
      error: 'recordedData must be a plain object keyed by recorded rule label.',
      unknownLabels: Object.freeze([]),
    })
  }

  const data = value ?? {}
  const labels = new Set(rules.map((rule) => rule.label))
  const unknownLabels = Object.freeze(Object.keys(data).filter((label) => !labels.has(label)))
  const entries = Object.freeze(
    rules.map((rule) => {
      if (!Object.prototype.hasOwnProperty.call(data, rule.label)) {
        return Object.freeze({ rule, tensor: null, error: null })
      }
      try {
        return Object.freeze({
          rule,
          tensor: normalizeCadViewerRecordedTensor(rule, data[rule.label], quantityKinds),
          error: null,
        })
      } catch (error) {
        return Object.freeze({
          rule,
          tensor: null,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }),
  )

  return Object.freeze({ entries, error: null, unknownLabels })
}

export function isNumericRecordedDType(dtype: RecordedDataRule['result']['dtype']) {
  return dtype !== 'bool' && dtype !== 'string'
}

export function recordedDisplayUnitOptions(definition: CatalogQuantityKind, sourceUnit: UcumUnit): readonly UcumUnit[] {
  const units = definition.applicableUnits as readonly UcumUnit[]
  const tensorOrder = definition.tensorOrder
  return Object.freeze(
    [sourceUnit, ...units.filter((unit) => unit !== sourceUnit)].filter((unit) => {
      try {
        if (tensorOrder > 0 && convertUcumValue(0, sourceUnit, unit, `${definition.name} display unit`) !== 0) {
          return false
        }
        convertUcumValue(1, sourceUnit, unit, `${definition.name} display unit`)
        return true
      } catch {
        return false
      }
    }),
  )
}

export function convertRecordedNumericValue(
  value: ResolvedRecordedTensor['value'],
  sourceUnit: UcumUnit,
  displayUnit: UcumUnit,
  tensorOrder = 0,
): ResolvedRecordedTensor['value'] {
  if (sourceUnit === displayUnit) return value
  if (tensorOrder > 0 && convertUcumValue(0, sourceUnit, displayUnit, 'Recorded tensor display unit') !== 0) {
    throw new Error('Recorded tensor display unit conversion must preserve zero.')
  }
  const convertValue = (item: unknown): ResolvedRecordedTensor['value'] => {
    if (Array.isArray(item)) return Object.freeze(item.map(convertValue))
    if (typeof item !== 'number') throw new Error('Recorded value unit conversion requires numeric tensor values.')
    return convertUcumValue(item, sourceUnit, displayUnit, 'Recorded value display unit')
  }
  return convertValue(value)
}

export function readRecordedValue(
  tensor: ResolvedRecordedTensor,
  outerIndices: readonly number[],
  componentSelection = 'norm',
): boolean | string | number {
  if (outerIndices.length !== tensor.axes.length) {
    throw new Error(`Recorded tensor requires ${tensor.axes.length} outer indices.`)
  }
  if (tensor.tensorOrder === 0) return tensor.accessor.get(outerIndices)
  if (componentSelection.startsWith('component:')) {
    const components = componentSelection.slice('component:'.length).split(',').map(Number)
    if (
      components.length !== tensor.tensorOrder ||
      components.some((index) => !Number.isSafeInteger(index) || index < 0 || index > 2)
    ) {
      throw new Error('Recorded tensor component selection is invalid.')
    }
    return tensor.accessor.get([...outerIndices, ...components])
  }
  let squared = 0
  const componentCount = 3 ** tensor.tensorOrder
  for (let flatIndex = 0; flatIndex < componentCount; flatIndex += 1) {
    let remaining = flatIndex
    const components = Array(tensor.tensorOrder).fill(0) as number[]
    for (let dimension = tensor.tensorOrder - 1; dimension >= 0; dimension -= 1) {
      components[dimension] = remaining % 3
      remaining = Math.floor(remaining / 3)
    }
    const value = tensor.accessor.get([...outerIndices, ...components])
    if (typeof value !== 'number') throw new Error('Recorded tensor norm requires numeric components.')
    squared += value ** 2
  }
  return Math.sqrt(squared)
}

export function convertRecordedNumericTicks(
  ticks: readonly number[],
  sourceUnit: UcumUnit,
  displayUnit: UcumUnit,
): readonly number[] {
  if (sourceUnit === displayUnit) return ticks
  return Object.freeze(
    ticks.map((tick) => convertUcumValue(tick, sourceUnit, displayUnit, 'Recorded axis display unit')),
  )
}
