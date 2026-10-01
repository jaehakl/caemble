import type { CalculationDataOutput, CalculationOutputLayout } from '@/api'
import { fitTensorDisplayDomain } from '@/components/tensor-editor/displayDomain'

export type PredictionValidationMetric = Readonly<{
  compatible: boolean
  message: string | null
  mae: number | null
  rmse: number | null
  maxAbsoluteError: number | null
  relativeError: number | null
}>

export function calculationOutputContract(output: CalculationDataOutput | CalculationOutputLayout) {
  return Object.freeze({
    dtype: output.dtype,
    shape: Object.freeze([...output.shape]),
    axes: Object.freeze(
      output.axes.map((axis) =>
        Object.freeze({
          name: axis.name,
          ...(axis.unit ? { unit: axis.unit } : {}),
        }),
      ),
    ),
  })
}

function incompatibleMetric(message: string): PredictionValidationMetric {
  return Object.freeze({
    compatible: false,
    message,
    mae: null,
    rmse: null,
    maxAbsoluteError: null,
    relativeError: null,
  })
}

function flatOutput(output: CalculationDataOutput) {
  if (output.shape.some((length) => !Number.isSafeInteger(length) || length < 0)) return null
  const expectedSize = output.shape.reduce((size, length) => size * length, 1)
  if (!Number.isSafeInteger(expectedSize)) return null
  if (output.shape.length === 0) {
    return typeof output.data === 'number' && Number.isFinite(output.data) ? [output.data] : null
  }
  if (
    !Array.isArray(output.data) ||
    output.data.length !== expectedSize ||
    output.data.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    return null
  }
  return [...output.data]
}

export function predictionOutputRange(outputs: readonly (CalculationDataOutput | null | undefined)[]) {
  const values = outputs.flatMap((output) => (output ? (flatOutput(output) ?? []) : []))
  return fitTensorDisplayDomain(values)
}

function outputSignature(output: CalculationDataOutput) {
  if (
    output.shape.length > 3 ||
    output.axes.length !== output.shape.length ||
    output.axes.some(
      (axis, index) =>
        !axis.name.trim() ||
        axis.ticks.length !== output.shape[index] ||
        axis.ticks.some((tick) => !Number.isFinite(tick)) ||
        (axis.unit !== undefined && !axis.unit.trim()),
    )
  ) {
    return null
  }
  return JSON.stringify(output.shape)
}

export function comparePredictionOutput(
  reference: CalculationDataOutput,
  actual: CalculationDataOutput,
): PredictionValidationMetric {
  const referenceSignature = outputSignature(reference)
  const actualSignature = outputSignature(actual)
  if (referenceSignature === null || actualSignature === null) {
    return incompatibleMetric('비교할 CalculationData shape 또는 axes가 올바르지 않습니다.')
  }
  const expected = flatOutput(reference)
  const observed = flatOutput(actual)
  if (expected === null || observed === null) {
    return incompatibleMetric('비교할 tensor 값이 유한하지 않거나 길이가 다릅니다.')
  }
  if (referenceSignature !== actualSignature) {
    return incompatibleMetric(`shape가 다릅니다. 기준 ${referenceSignature}, 실제 ${actualSignature}`)
  }
  const errors = expected.map((value, index) => Math.abs(observed[index] - value))
  if (errors.some((value) => !Number.isFinite(value))) {
    return incompatibleMetric('Prediction 오차가 JavaScript의 유한한 수치 범위를 초과합니다.')
  }
  const maxAbsoluteError = errors.reduce((maximum, value) => Math.max(maximum, value), 0)
  const mae =
    maxAbsoluteError === 0
      ? 0
      : maxAbsoluteError *
        (errors.reduce((sum, value) => sum + value / maxAbsoluteError, 0) / Math.max(1, errors.length))
  const rmse =
    maxAbsoluteError === 0
      ? 0
      : maxAbsoluteError *
        Math.sqrt(errors.reduce((sum, value) => sum + (value / maxAbsoluteError) ** 2, 0) / Math.max(1, errors.length))
  const relativeErrorValue = expected.length === 1 && expected[0] !== 0 ? errors[0] / Math.abs(expected[0]) : null
  const relativeError = relativeErrorValue !== null && Number.isFinite(relativeErrorValue) ? relativeErrorValue : null
  return Object.freeze({
    compatible: true,
    message: null,
    mae,
    rmse,
    maxAbsoluteError,
    relativeError,
  })
}
