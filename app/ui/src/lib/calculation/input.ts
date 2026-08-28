import { createDataTensorAccessor, isDataTensor } from '@/lib/cad/model/dataTensor'
import type { RecordedData, RecordedDataRule, RecordedDataTensor } from '@/lib/cad/model/descriptor'
import { convertUcumValue } from '@/lib/cad/model/units'
import { getQuantityKindTensorOrder } from '@/lib/quantitykind/runtime'
import { CALCULATION_INPUT_MAX_BYTES, CalculationExecutionError, type CalculationInput } from './types'
import { assertCalculationInput } from './validation'

type ResolvedRuleResult = RecordedDataRule['result'] & Readonly<{ tensorOrder?: number }>

export function createCalculationInput(
  rules: readonly RecordedDataRule[],
  flatRecordedData: RecordedData | Readonly<Record<string, RecordedDataTensor | undefined>>,
): CalculationInput {
  const resolved = rules.map((rule) => {
    const tensor = flatRecordedData[rule.label] as RecordedDataTensor | undefined
    if (tensor === undefined) throw new Error(`RecordedData ${rule.label} is missing.`)
    if (!isDataTensor(tensor)) throw new Error(`RecordedData ${rule.label} is not a tensor leaf.`)
    const result = rule.result as ResolvedRuleResult
    const tensorOrder =
      result.tensorOrder ?? (result.quantityKind === undefined ? 0 : getQuantityKindTensorOrder(result.quantityKind))
    if (!Number.isInteger(tensorOrder) || tensorOrder < 0) {
      throw new Error(`RecordedData ${rule.label} has an invalid tensorOrder.`)
    }
    return { result, rule, tensor, tensorOrder }
  })
  resolved.reduce((total, { rule, tensor }) => {
    if (tensor.storage.kind === 'inline') return total
    if (!Number.isSafeInteger(tensor.storage.byteLength) || tensor.storage.byteLength < 0) {
      throw new Error(`RecordedData ${rule.label} has an invalid storage byte length.`)
    }
    const next = total + tensor.storage.byteLength
    if (!Number.isSafeInteger(next) || next > CALCULATION_INPUT_MAX_BYTES) {
      throw new CalculationExecutionError(
        'input-too-large',
        `Calculation input is larger than the ${CALCULATION_INPUT_MAX_BYTES.toLocaleString()} byte limit.`,
      )
    }
    return next
  }, 0)
  const prepared = resolved.map(({ result, rule, tensor, tensorOrder }) => {
    const accessor = createDataTensorAccessor(rule.result, tensor, `RecordedData ${rule.label}`)
    return { accessor, result, rule, tensorOrder }
  })
  const rawByteLength = prepared.reduce((total, { accessor }) => total + accessor.byteLength, 0)
  if (rawByteLength > CALCULATION_INPUT_MAX_BYTES) {
    throw new CalculationExecutionError(
      'input-too-large',
      `Calculation input is ${rawByteLength.toLocaleString()} bytes; the limit is ${CALCULATION_INPUT_MAX_BYTES.toLocaleString()} bytes.`,
    )
  }

  const input = Object.freeze(
    Object.fromEntries(
      prepared.map(({ accessor, result, rule, tensorOrder }) => {
        const externalRank = accessor.shape.length - tensorOrder
        if (externalRank < 0) throw new Error(`RecordedData ${rule.label} tensorOrder exceeds its rank.`)
        if (accessor.shape.slice(externalRank).some((length) => length !== 3)) {
          throw new Error(`RecordedData ${rule.label} tensor component dimensions must all have length 3.`)
        }
        const schemaAxes = result.axes ?? []
        if (schemaAxes.length !== externalRank) {
          throw new Error(
            `RecordedData ${rule.label} declares ${schemaAxes.length} axes, but shape [${accessor.shape.join(', ')}] and tensorOrder ${tensorOrder} require ${externalRank}.`,
          )
        }
        const storedAxes = accessor.tensor.axes ?? []
        if (storedAxes.length !== externalRank) {
          throw new Error(
            `RecordedData ${rule.label} stores ${storedAxes.length} axes, but ${externalRank} external axes are required.`,
          )
        }
        const axes = Object.freeze(
          schemaAxes.map((schemaAxis, axisIndex) => {
            const length = accessor.shape[axisIndex]
            if (schemaAxis.length !== undefined && schemaAxis.length !== length) {
              throw new Error(
                `RecordedData ${rule.label} axis ${axisIndex} schema length ${schemaAxis.length} does not match actual length ${length}.`,
              )
            }
            if (schemaAxis.ticks !== undefined && schemaAxis.ticks.length !== length) {
              throw new Error(
                `RecordedData ${rule.label} axis ${axisIndex} schema ticks do not match actual length ${length}.`,
              )
            }
            const storedAxis = storedAxes[axisIndex]
            const storedTicks =
              storedAxis.ticks ??
              (storedAxis.implicitOrdinal === true
                ? Object.freeze(Array.from({ length }, (_item, tick) => tick))
                : undefined)
            if (
              schemaAxis.ticks !== undefined &&
              storedTicks !== undefined &&
              schemaAxis.ticks.some((tick, tickIndex) => tick !== storedTicks[tickIndex])
            ) {
              throw new Error(
                `RecordedData ${rule.label} axis ${axisIndex} stored ticks do not match its schema ticks.`,
              )
            }
            const ticks = storedTicks ?? schemaAxis.ticks
            if (
              ticks === undefined ||
              ticks.length !== length ||
              ticks.some((tick) => typeof tick !== 'string' && (typeof tick !== 'number' || !Number.isFinite(tick)))
            ) {
              throw new Error(
                `RecordedData ${rule.label} axis ${axisIndex} requires ${length} finite numeric or string ticks.`,
              )
            }
            if (schemaAxis.unit !== undefined) convertUcumValue(1, schemaAxis.unit, schemaAxis.unit)
            return Object.freeze({
              name: schemaAxis.name ?? `axis ${axisIndex}`,
              ticks: Object.freeze([...ticks]),
              ...(schemaAxis.unit === undefined ? {} : { unit: schemaAxis.unit }),
            })
          }),
        )
        const values = Array.from({ length: accessor.size }, (_item, index) => accessor.at(index))
        const data = accessor.shape.length === 0 ? values[0] : Object.freeze(values)
        return [
          rule.label,
          Object.freeze({
            dtype: result.dtype,
            shape: Object.freeze([...accessor.shape]),
            data,
            axes,
            ...(result.quantityKind === undefined ? {} : { quantityKind: result.quantityKind }),
            tensorOrder,
            ...(result.unit === undefined ? {} : { unit: result.unit }),
          }),
        ] as const
      }),
    ),
  )
  assertCalculationInput(input)
  return input
}
