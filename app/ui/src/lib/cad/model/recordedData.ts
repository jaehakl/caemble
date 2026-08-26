import {
  type CartesianBasis,
  type DataDType,
  type QuantityKindName,
  type RecordedData,
  type RecordedDataRule,
} from './core'
import { createDataTensorAccessor, type DataTensorAccessor } from './dataTensor'
import { getQuantityKindComponentShape, getQuantityKindTensorOrder } from '../../quantitykind/runtime'
import type { UcumUnit } from './units'

export type ResolvedRecordedTensor = Readonly<{
  value: boolean | string | number | readonly unknown[]
  accessor: DataTensorAccessor
  componentShape: readonly 3[]
  tensorOrder: number
  dtype: DataDType
  axes: readonly Readonly<{
    length: number
    name: string
    ticks: readonly (number | string)[]
  }>[]
  unit?: UcumUnit
  quantityKind?: QuantityKindName
  basis?: CartesianBasis
}>

function resolveRecordedDataTensor(rule: RecordedDataRule, value: unknown): ResolvedRecordedTensor {
  const path = `recordedData[${JSON.stringify(rule.label)}]`
    const accessor = createDataTensorAccessor(rule.result, value as import('./core').RecordedDataTensor, path)
    const axisCount = rule.result.axes?.length ?? 0
    const componentShape =
      rule.result.quantityKind === undefined
        ? (Object.freeze([]) as readonly 3[])
        : getQuantityKindComponentShape(rule.result.quantityKind)
    const tensorOrder =
      rule.result.quantityKind === undefined ? 0 : getQuantityKindTensorOrder(rule.result.quantityKind)
    const resolved = {
      axes: Object.freeze(
        Array.from({ length: axisCount }, (_, axisIndex) =>
          Object.freeze({
            length: accessor.shape[axisIndex],
            name: rule.result.axes?.[axisIndex]?.name ?? `axis ${axisIndex}`,
            ticks:
              accessor.tensor.axes?.[axisIndex]?.ticks ??
              Object.freeze(Array.from({ length: accessor.shape[axisIndex] }, (_, index) => index)),
          }),
        ),
      ),
      componentShape,
      tensorOrder,
      dtype: rule.result.dtype,
      ...(rule.result.unit === undefined ? {} : { unit: rule.result.unit }),
      ...(rule.result.quantityKind === undefined ? {} : { quantityKind: rule.result.quantityKind }),
      ...(rule.result.basis === undefined ? {} : { basis: rule.result.basis }),
    }
    return Object.freeze(
      Object.defineProperties(resolved, {
        accessor: { value: accessor },
        value: {
          enumerable: true,
          get: () => accessor.materialize(),
        },
      }),
    ) as ResolvedRecordedTensor
}

export function normalizeRecordedDataTensor(rule: RecordedDataRule, value: unknown): ResolvedRecordedTensor {
  return resolveRecordedDataTensor(rule, value)
}

export function normalizeRecordedData(rules: readonly RecordedDataRule[], value: unknown): RecordedData {
  const record = value as Record<string, unknown>
  const normalized = rules.map((rule) => {
    const tensor = normalizeRecordedDataTensor(rule, record[rule.label])
    return [rule.label, tensor.accessor.tensor] as const
  })
  return Object.freeze(Object.fromEntries(normalized))
}
