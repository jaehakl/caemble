import type { CalculationDataOutput } from '@/api'
import { createDataTensor } from '@/lib/cad/model/dataTensor'
import type { Complex64Value, RecordedData, RecordedDataRule } from '@/lib/cad/model/descriptor'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import type { Tensor } from '@/lib/cad/model/types'
import { assertBoxGridData, type BoxGridData } from '@/contracts/boxGrid'
import { predictionNumericDtypes, type PredictionNumericDtype, type PredictionTensorSample } from './types'
import { predictionTensorValueCount } from './tensor'

const numericDtypes = new Set<string>(predictionNumericDtypes)
const calculationIntegerRanges: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  int8: [-128, 127],
  int16: [-32_768, 32_767],
  int32: [-2_147_483_648, 2_147_483_647],
  int64: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  uint8: [0, 255],
  uint16: [0, 65_535],
  uint32: [0, 4_294_967_295],
  uint64: [0, Number.MAX_SAFE_INTEGER],
})
function requireNumericDtype(dtype: string, label: string): PredictionNumericDtype {
  if (!numericDtypes.has(dtype)) throw new Error(`${label}의 dtype ${dtype}은 numeric Prediction을 지원하지 않습니다.`)
  return dtype as PredictionNumericDtype
}

function complexTensorFromComponents(
  values: readonly number[],
  shape: readonly number[],
  label: string,
): Complex64Value | readonly unknown[] {
  let offset = 0
  const build = (depth: number): Complex64Value | readonly unknown[] => {
    if (depth < shape.length) {
      return Object.freeze(Array.from({ length: shape[depth] }, () => build(depth + 1)))
    }
    const re = Math.fround(values[offset++])
    const im = Math.fround(values[offset++])
    if (!Number.isFinite(re) || !Number.isFinite(im)) {
      throw new Error(`${label}의 예측 complex64 값이 유효하지 않습니다.`)
    }
    return Object.freeze({ re, im })
  }
  return build(0)
}

export function predictedRecordedData(
  samples: readonly PredictionTensorSample[],
  rules: readonly RecordedDataRule[],
  onOrdinalAxisFallback?: (warning: Readonly<{ axisIndex: number; blockKey: string; length: number }>) => void,
  candidateBoxGrids?: Readonly<Record<string, BoxGridData>>,
): RecordedData {
  const unresolvedMetadata = rules.find((rule) => rule.result.metadata !== undefined)
  if (unresolvedMetadata)
    throw new Error(
      `${unresolvedMetadata.label}: Prediction cannot resolve declared result metadata for a new Candidate. Use a Solver result for this Output.`,
    )
  const ruleMap = new Map(rules.map((rule) => [rule.label, rule]))
  const sampleMap = new Map(samples.map((sample) => [sample.layout.key, sample]))
  if (ruleMap.size !== rules.length || sampleMap.size !== samples.length || sampleMap.size !== ruleMap.size) {
    throw new Error('Predicted RecordedData paths must match the current Experiment rules exactly.')
  }
  return Object.freeze(
    Object.fromEntries(
      rules.map((rule) => {
        const sample = sampleMap.get(rule.label)
        if (!sample) throw new Error(`${rule.label} RecordedData Prediction 값이 없습니다.`)
        const dtype = requireNumericDtype(rule.result.dtype, rule.label)
        if (sample.layout.dtype !== dtype) {
          throw new Error(`${rule.label} RecordedData Prediction dtype이 현재 계약과 맞지 않습니다.`)
        }
        if (sample.layout.shape.some((length) => !Number.isSafeInteger(length) || length < 0)) {
          throw new Error(`${rule.label} RecordedData Prediction shape가 올바르지 않습니다.`)
        }
        const expectedSize = predictionTensorValueCount(sample.layout)
        if (sample.values.length !== expectedSize) {
          throw new Error(`${rule.label} RecordedData Prediction 값이 shape와 맞지 않습니다.`)
        }
        const integerRange = calculationIntegerRanges[rule.result.dtype]
        const tensorSize = sample.layout.shape.reduce((size, length) => size * length, 1)
        const predictedValues = sample.values.slice(0, tensorSize)
        const boxGrid = candidateBoxGrids?.[rule.label] ?? sample.layout.boxGrid
        assertBoxGridData(boxGrid, sample.layout.shape)
        // Relative cell correspondence permits different Candidate geometry, but
        // the predicted channels must retain their physical output meaning.
        for (const key of [
          'version',
          'sampling',
          'channels',
          'components',
          'channelUnits',
          'frequencyKind',
          'configuration',
          'weighting',
        ] as const) {
          if (JSON.stringify(boxGrid[key]) !== JSON.stringify(sample.layout.boxGrid?.[key])) {
            throw new Error(`${rule.label}: Candidate BoxGrid ${key}이 모델 출력 계약과 맞지 않습니다.`)
          }
        }
        if (boxGrid.channels.length === 2) {
          const components = boxGrid.components.length
          for (let offset = 0; offset < predictedValues.length; offset += components * 2) {
            for (let component = 0; component < components; component++) {
              const re = predictedValues[offset + component]
              const im = predictedValues[offset + components + component]
              predictedValues[offset + component] = Math.hypot(re, im)
              const phase = re === 0 && im === 0 ? 0 : Math.atan2(im, re)
              predictedValues[offset + components + component] = phase >= Math.PI ? -Math.PI : phase
            }
          }
        }
        const normalizedValues = predictedValues.map((member) =>
          integerRange
            ? Math.min(integerRange[1], Math.max(integerRange[0], Math.round(member)))
            : rule.result.dtype === 'float32'
              ? Math.fround(member)
              : member,
        )
        if (boxGrid.channels.length === 2) {
          const components = boxGrid.components.length
          // The nearest float32 to pi lies outside the canonical phase interval.
          const phaseLimit = Math.fround(Math.PI - 2 ** -22)
          for (let offset = 0; offset < normalizedValues.length; offset += components * 2) {
            for (let component = 0; component < components; component++) {
              const phaseIndex = offset + components + component
              if (normalizedValues[offset + component] === 0) normalizedValues[phaseIndex] = 0
              else if (rule.result.dtype === 'float32')
                normalizedValues[phaseIndex] = Math.max(-phaseLimit, Math.min(phaseLimit, normalizedValues[phaseIndex]))
            }
          }
        }
        const value =
          dtype === 'complex64'
            ? complexTensorFromComponents(normalizedValues, sample.layout.shape, rule.label)
            : varsTensorFromFlat(normalizedValues, sample.layout.shape)
        const externalShape = sample.layout.shape
        const axes = (rule.result.axes ?? []).map((axis, index) => {
          if (index < 3) {
            const length = boxGrid.gridShape[index]
            const extent = boxGrid.size[index]
            return Object.freeze({
              ticks: Object.freeze(Array.from({ length }, (_, cell) => ((cell + 0.5) * extent) / length)),
              bounds: Object.freeze([0, extent]) as readonly [number, number],
            })
          }
          if (index === 4 && sample.layout.frequencyOutput) {
            return Object.freeze({ ticks: Object.freeze(sample.values.slice(tensorSize)) })
          }
          const storedTicks = sample.layout.axes?.[index]?.ticks
          let ticks = storedTicks?.length === externalShape[index] ? storedTicks : axis.ticks
          if (ticks?.length !== externalShape[index]) {
            ticks = Array.from({ length: externalShape[index] ?? 0 }, (_item, tick) => tick)
            onOrdinalAxisFallback?.({ axisIndex: index, blockKey: rule.label, length: externalShape[index] ?? 0 })
          }
          return Object.freeze({ ticks: Object.freeze([...ticks]) })
        })
        return [rule.label, createDataTensor(rule.result, { value, boxGrid, ...(axes?.length ? { axes } : {}) })]
      }),
    ),
  ) as RecordedData
}

export function calculationOutputTensor(output: CalculationDataOutput): Tensor {
  const values = typeof output.data === 'number' ? [output.data] : output.data
  if (values.some((value) => !Number.isFinite(value))) throw new Error('Calculation contains non-finite values.')
  return varsTensorFromFlat(values, output.shape)
}

export function predictionFingerprint(parts: readonly unknown[]) {
  return JSON.stringify(parts, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const record = value as Readonly<Record<string, unknown>>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    )
  })
}
