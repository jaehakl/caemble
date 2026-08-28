import {
  CalculationExecutionError,
  createCalculationInput,
  type CalculationExecutionErrorCode,
  type CalculationInput,
} from '@/lib/calculation'
import { isDataTensor, type RecordedData, type RecordedDataRule } from '@/lib/cad'
import { getQuantityKindTensorOrder } from '@/lib/quantitykind/runtime'

export type CalculationRecordedDataSummary = Readonly<{
  path: string
  shape: readonly number[] | null
  actualAxisLengths: readonly number[] | null
  quantityKind: string | null
  unit: string | null
  valid: boolean
  error: string | null
}>

export function buildCalculationRecordedData(
  rules: readonly RecordedDataRule[],
  recordedData: RecordedData | null | undefined,
): Readonly<{
  input: CalculationInput | null
  summaries: readonly CalculationRecordedDataSummary[]
  error: string | null
  errorCode: CalculationExecutionErrorCode | 'input' | null
}> {
  let firstError: string | null = null
  let errorCode: CalculationExecutionErrorCode | 'input' | null = null
  let summaries = rules.map((rule): CalculationRecordedDataSummary => {
    const quantityKind = rule.result.quantityKind ?? null
    const unit = rule.result.unit ?? null
    const value = recordedData?.[rule.label]
    if (value === undefined) {
      const error = `${rule.label}: RecordedData 값이 없습니다.`
      firstError ??= error
      errorCode ??= 'input'
      return {
        actualAxisLengths: null,
        error,
        path: rule.label,
        quantityKind,
        shape: null,
        unit,
        valid: false,
      }
    }

    let shape: readonly number[] | null = null
    let actualAxisLengths: readonly number[] | null = null
    try {
      if (!isDataTensor(value)) throw new Error('dotted path가 tensor leaf를 가리키지 않습니다.')
      const result = rule.result as RecordedDataRule['result'] & Readonly<{ tensorOrder?: number }>
      const tensorOrder =
        result.tensorOrder ?? (result.quantityKind === undefined ? 0 : getQuantityKindTensorOrder(result.quantityKind))
      shape = Object.freeze([...value.shape])
      if (!Number.isSafeInteger(tensorOrder) || tensorOrder < 0 || tensorOrder > shape.length) {
        throw new Error(`tensorOrder ${String(tensorOrder)}가 전체 shape와 맞지 않습니다.`)
      }
      actualAxisLengths = Object.freeze(shape.slice(0, shape.length - tensorOrder))
      return {
        actualAxisLengths,
        error: null,
        path: rule.label,
        quantityKind,
        shape,
        unit,
        valid: true,
      }
    } catch (cause: unknown) {
      const error = `${rule.label}: ${cause instanceof Error ? cause.message : String(cause)}`
      firstError ??= error
      errorCode ??= cause instanceof CalculationExecutionError ? cause.code : 'input'
      return {
        actualAxisLengths,
        error,
        path: rule.label,
        quantityKind,
        shape,
        unit,
        valid: false,
      }
    }
  })

  let input: CalculationInput | null = null
  if (!recordedData) {
    firstError ??= '선택한 Measurement에 RecordedData가 없습니다.'
    errorCode ??= 'input'
  } else if (!firstError) {
    try {
      input = createCalculationInput(rules, recordedData)
    } catch (cause: unknown) {
      firstError = cause instanceof Error ? cause.message : String(cause)
      errorCode = cause instanceof CalculationExecutionError ? cause.code : 'input'
    }
  }
  if (recordedData && errorCode === 'input') {
    summaries = summaries.map((summary, index) => {
      if (!summary.valid) return summary
      const rule = rules[index]
      const value = recordedData[rule.label]
      if (!isDataTensor(value)) return summary
      try {
        createCalculationInput([rule], Object.freeze({ [rule.label]: value }))
        return summary
      } catch (cause: unknown) {
        return {
          ...summary,
          error: `${rule.label}: ${cause instanceof Error ? cause.message : String(cause)}`,
          valid: false,
        }
      }
    })
  }
  return Object.freeze({
    error: firstError,
    errorCode,
    input,
    summaries: Object.freeze(summaries),
  })
}
