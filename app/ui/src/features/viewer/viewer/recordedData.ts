import type {
  QuantityKindName,
  RecordedData,
  RecordedDataAxis,
  RecordedDataResult,
  RecordedDataRule,
  RecordedDataTensor,
  UcumUnit,
} from '@/lib/cad'
import { convertUcumValue } from '@/lib/cad'
import { normalizeRecordedDataTensor, type ResolvedRecordedTensor } from '@/lib/cad'
import type { SimulationProgramManifest } from '@/lib/cad/simulation'
import { QuantityKind } from '@/lib/quantitykind'

export type CadViewerRecordedAxis = RecordedDataAxis
export type CadViewerRecordedTensor = RecordedDataTensor
export type CadViewerRecordedData = RecordedData
export type { ResolvedRecordedTensor }

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

export const normalizeCadViewerRecordedTensor = normalizeRecordedDataTensor

export function resolveCadViewerRecordedDataRules(
  provided: readonly RecordedDataRule[] | undefined,
  program: SimulationProgramManifest | null | undefined,
) {
  if (provided !== undefined) return provided
  return Object.freeze(
    Object.entries(program?.recordedData ?? {}).map(([name, result]) =>
      Object.freeze({
        target: Object.freeze([]),
        label: name,
        methodId: 'simulation.record',
        parameters: Object.freeze({}),
        result: result as RecordedDataResult,
      }),
    ),
  ) satisfies readonly RecordedDataRule[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
}

export function resolveCadViewerRecordedData(rules: readonly RecordedDataRule[], value: unknown): ResolvedRecordedData {
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
          tensor: normalizeRecordedDataTensor(rule, data[rule.label]),
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

export function recordedDisplayUnitOptions(quantityKind: QuantityKindName, sourceUnit: UcumUnit): readonly UcumUnit[] {
  const definition = QuantityKind[quantityKind]
  const units = definition.applicableUnits() as readonly UcumUnit[]
  const tensorOrder = definition.tensorOrder()
  return Object.freeze(
    [sourceUnit, ...units.filter((unit) => unit !== sourceUnit)].filter((unit) => {
      try {
        if (tensorOrder > 0 && convertUcumValue(0, sourceUnit, unit, `${quantityKind} display unit`) !== 0) {
          return false
        }
        convertUcumValue(1, sourceUnit, unit, `${quantityKind} display unit`)
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
