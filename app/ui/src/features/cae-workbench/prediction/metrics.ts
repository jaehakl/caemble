import type { CalculationDataOutput } from '@/api'
import type { PredictionTensorLayout, PredictionTrainingRow } from './knn'

export type PredictionValidationMetric = Readonly<{
  compatible: boolean
  message: string | null
  mae: number | null
  rmse: number | null
  maxAbsoluteError: number | null
  relativeError: number | null
}>

export type InverseValidationPair = Readonly<{
  actual: CalculationDataOutput | null
  calculationId: number
  reference: CalculationDataOutput
}>

function stableEuclideanNorm(values: readonly number[]) {
  let scale = 0
  let sum = 0
  values.forEach((value) => {
    const absolute = Math.abs(value)
    if (absolute === 0) return
    if (scale < absolute) {
      const ratio = scale / absolute
      sum = 1 + sum * ratio * ratio
      scale = absolute
    } else {
      const ratio = absolute / scale
      sum += ratio * ratio
    }
  })
  return scale === 0 ? 0 : scale * Math.sqrt(sum)
}

function populationStandardDeviation(values: readonly number[]) {
  const maximum = values.reduce((current, value) => Math.max(current, Math.abs(value)), 0)
  if (maximum === 0) return 0
  const mean = values.reduce((sum, value) => sum + value / maximum, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value / maximum - mean) ** 2, 0) / values.length
  return maximum * Math.sqrt(variance)
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
  if (values.length === 0) return [-1, 1] as const
  const minimum = values.reduce((current, value) => Math.min(current, value), Number.POSITIVE_INFINITY)
  const maximum = values.reduce((current, value) => Math.max(current, value), Number.NEGATIVE_INFINITY)
  const difference = maximum - minimum
  const span =
    Number.isFinite(difference) && difference > 0 ? difference : Math.max(1, Math.abs(minimum), Math.abs(maximum))
  return [Math.max(-Number.MAX_VALUE, minimum - span * 10), Math.min(Number.MAX_VALUE, maximum + span * 10)] as const
}

function outputSignature(output: CalculationDataOutput) {
  if (
    output.shape.length > 2 ||
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
  return JSON.stringify([
    output.dtype,
    [...output.shape],
    output.axes.map((axis) => ({
      name: axis.name,
      ticks: [...axis.ticks],
      ...(axis.unit === undefined ? {} : { unit: axis.unit }),
    })),
  ])
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
  if (referenceSignature !== actualSignature) {
    return incompatibleMetric('dtype, shape 또는 axes가 Prediction snapshot과 다릅니다.')
  }
  const expected = flatOutput(reference)
  const observed = flatOutput(actual)
  if (expected === null || observed === null || expected.length !== observed.length) {
    return incompatibleMetric('비교할 tensor 값이 유한하지 않거나 길이가 다릅니다.')
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

export function inverseValidationAggregateError(
  pairs: readonly InverseValidationPair[],
  calculationWeights: Readonly<Record<number, number>>,
  trainingRows: readonly PredictionTrainingRow[],
  includedMeasurementIds: readonly number[],
) {
  const included = new Set(includedMeasurementIds)
  const blocks: { error: number; weight: number }[] = []
  for (const pair of pairs) {
    if (!pair.actual || !comparePredictionOutput(pair.reference, pair.actual).compatible) return null
    const reference = flatOutput(pair.reference)
    const actual = flatOutput(pair.actual)
    if (!reference || !actual) return null
    const key = `calculation:${pair.calculationId}`
    const samples = trainingRows
      .filter((row) => included.has(row.measurementId))
      .map((row) => row.inputs.find((sample) => sample.layout.key === key)?.values)
    if (
      samples.length !== includedMeasurementIds.length ||
      samples.some((values) => !values || values.length !== reference.length)
    ) {
      return null
    }
    const normalizedErrors: number[] = []
    for (let index = 0; index < reference.length; index += 1) {
      const deviation = populationStandardDeviation(samples.map((values) => values![index]))
      if (deviation === 0) continue
      const normalized = (actual[index] - reference[index]) / deviation
      if (!Number.isFinite(normalized)) return null
      normalizedErrors.push(normalized)
    }
    const weight = calculationWeights[pair.calculationId] ?? 1
    if (!Number.isFinite(weight) || weight < 0) return null
    blocks.push({
      error: normalizedErrors.length ? stableEuclideanNorm(normalizedErrors) / Math.sqrt(normalizedErrors.length) : 0,
      weight,
    })
  }
  return weightedAggregateError(blocks)
}

function weightedAggregateError(blocks: readonly Readonly<{ error: number; weight: number }>[]) {
  const weightScale = blocks.reduce((maximum, block) => Math.max(maximum, block.weight), 0)
  if (weightScale === 0) return null
  const weightSum = blocks.reduce((sum, block) => sum + block.weight / weightScale, 0)
  return stableEuclideanNorm(blocks.map((block) => block.error * Math.sqrt(block.weight / weightScale / weightSum)))
}

export function inverseValidationAggregateErrorFromScales(
  pairs: readonly InverseValidationPair[],
  calculationWeights: Readonly<Record<number, number>>,
  inputLayouts: readonly PredictionTensorLayout[],
  inputScales: Float64Array,
) {
  const offsets = [0]
  const sizes = inputLayouts.map((layout) => layout.shape.reduce((size, length) => size * length, 1))
  sizes.forEach((size) => offsets.push(offsets[offsets.length - 1] + size))
  if (offsets[offsets.length - 1] !== inputScales.length) return null
  const blocks: { error: number; weight: number }[] = []
  for (const pair of pairs) {
    if (!pair.actual || !comparePredictionOutput(pair.reference, pair.actual).compatible) return null
    const reference = flatOutput(pair.reference)
    const actual = flatOutput(pair.actual)
    if (!reference || !actual) return null
    const block = inputLayouts.findIndex((layout) => layout.key === `calculation:${pair.calculationId}`)
    if (block < 0 || sizes[block] !== reference.length) return null
    const normalizedErrors: number[] = []
    for (let index = 0; index < reference.length; index += 1) {
      const deviation = inputScales[offsets[block] + index]
      if (deviation === 0) continue
      const normalized = (actual[index] - reference[index]) / deviation
      if (!Number.isFinite(normalized)) return null
      normalizedErrors.push(normalized)
    }
    const weight = calculationWeights[pair.calculationId] ?? 1
    if (!Number.isFinite(weight) || weight < 0) return null
    blocks.push({
      error: normalizedErrors.length ? stableEuclideanNorm(normalizedErrors) / Math.sqrt(normalizedErrors.length) : 0,
      weight,
    })
  }
  return weightedAggregateError(blocks)
}
