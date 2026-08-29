import type { CalculationDataOutput, CalculationDataRecord, MeasurementRecordedData, MeasurementRecord } from '@/api'
import { recordedDataTreeSnapshot } from '@/features/cae-workbench/measurement/recordedData'
import { flattenVarsTensor, varsTensorFromFlat } from '@/features/cae-workbench/calculation/varsTensor'
import { createDataTensor, createDataTensorAccessor, isDataTensor } from '@/lib/cad/model/dataTensor'
import type { RecordedData, RecordedDataRule, RecordedDataTensor } from '@/lib/cad/model/descriptor'
import type { Tensor, Vars } from '@/lib/cad/model/types'
import type { VarsSchemaEntry } from '@/lib/cad/model/vars'
import {
  predictionNumericDtypes,
  type PredictionNumericDtype,
  type PredictionTensorLayout,
  type PredictionTensorSample,
  type PredictionTrainingRow,
} from '.'

const numericDtypes = new Set<string>(predictionNumericDtypes)
const calculationDtypes = new Set<string>(['float32', 'float64', 'int8', 'int16', 'int32', 'uint8', 'uint16', 'uint32'])
const calculationIntegerRanges: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  int8: [-128, 127],
  int16: [-32_768, 32_767],
  int32: [-2_147_483_648, 2_147_483_647],
  uint8: [0, 255],
  uint16: [0, 65_535],
  uint32: [0, 4_294_967_295],
})
type VarsSchema = Readonly<Record<string, VarsSchemaEntry>>

function requireNumericDtype(dtype: string, label: string): PredictionNumericDtype {
  if (!numericDtypes.has(dtype)) throw new Error(`${label}의 dtype ${dtype}은 numeric Prediction을 지원하지 않습니다.`)
  return dtype as PredictionNumericDtype
}

function requireFlatNumbers(values: readonly unknown[], label: string) {
  return Object.freeze(
    values.map((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`${label}에 유한하지 않은 값이 있습니다.`)
      return value
    }),
  )
}

export function predictionVarsLayouts(schema: VarsSchema): readonly PredictionTensorLayout[] {
  return Object.freeze(
    Object.keys(schema)
      .sort()
      .map((key) => {
        const entry = schema[key]
        return Object.freeze({
          key,
          dtype: 'float64' as const,
          shape: Object.freeze([...entry.shape]),
          minimum: entry.min,
          maximum: entry.max,
        })
      }),
  )
}

export function predictionVarsSamples(vars: Readonly<Vars>, schema: VarsSchema): readonly PredictionTensorSample[] {
  return Object.freeze(
    predictionVarsLayouts(schema).map((layout) => {
      const value = vars[layout.key]
      if (value === undefined) throw new Error(`vars.${layout.key} 값이 없습니다.`)
      return Object.freeze({
        layout,
        values: Object.freeze(flattenVarsTensor(value, layout.shape, `vars.${layout.key}`)),
      })
    }),
  )
}

function recordedLayout(rule: RecordedDataRule, tensor: RecordedDataTensor): PredictionTensorLayout {
  const result = rule.result
  const tensorOrder = (result as typeof result & Readonly<{ tensorOrder?: number }>).tensorOrder ?? 0
  if (!Number.isSafeInteger(tensorOrder) || tensorOrder < 0 || tensorOrder > tensor.shape.length) {
    throw new Error(`${rule.label}의 tensorOrder가 shape와 맞지 않습니다.`)
  }
  const externalRank = tensor.shape.length - tensorOrder
  const schemaAxes = result.axes ?? []
  const storedAxes = tensor.axes ?? []
  if (schemaAxes.length !== externalRank || storedAxes.length !== externalRank) {
    throw new Error(`${rule.label}의 axes가 외부 tensor rank와 맞지 않습니다.`)
  }
  return Object.freeze({
    key: rule.label,
    dtype: requireNumericDtype(result.dtype, rule.label),
    shape: Object.freeze([...tensor.shape]),
    dataSchemaSignature: predictionFingerprint([result]),
    axes: Object.freeze(
      schemaAxes.map((schemaAxis, index) => {
        const length = tensor.shape[index]
        if (schemaAxis.length !== undefined && schemaAxis.length !== length) {
          throw new Error(`${rule.label} axis ${index}의 schema length가 tensor shape와 다릅니다.`)
        }
        const storedAxis = storedAxes[index]
        const ticks =
          storedAxis.ticks ??
          (storedAxis.implicitOrdinal === true ? Array.from({ length }, (_item, tick) => tick) : schemaAxis.ticks)
        if (
          ticks === undefined ||
          ticks.length !== length ||
          ticks.some((tick) => typeof tick !== 'string' && (typeof tick !== 'number' || !Number.isFinite(tick)))
        ) {
          throw new Error(`${rule.label} axis ${index}의 ticks가 tensor shape와 맞지 않습니다.`)
        }
        return Object.freeze({
          name: schemaAxis.name ?? `axis ${index}`,
          ticks: Object.freeze([...ticks]),
          ...('unit' in schemaAxis && schemaAxis.unit ? { unit: schemaAxis.unit } : {}),
        })
      }),
    ),
    tensorOrder,
    ...('unit' in result && result.unit ? { unit: result.unit } : {}),
    ...('quantityKind' in result && result.quantityKind ? { quantityKind: result.quantityKind } : {}),
  })
}

export function predictionRecordedSamples(
  tree: MeasurementRecordedData,
  measurementId: number,
): Readonly<{ rules: readonly RecordedDataRule[]; samples: readonly PredictionTensorSample[] }> {
  const snapshot = recordedDataTreeSnapshot(tree, measurementId)
  const samples = snapshot.rules.map((rule) => {
    const tensor = snapshot.flatData[rule.label]
    if (!isDataTensor(tensor)) throw new Error(`${rule.label} RecordedData tensor가 없습니다.`)
    const layout = recordedLayout(rule, tensor)
    const accessor = createDataTensorAccessor(rule.result, tensor, rule.label)
    return Object.freeze({
      layout,
      values: requireFlatNumbers(
        Array.from({ length: accessor.size }, (_item, index) => accessor.at(index)),
        rule.label,
      ),
    })
  })
  return Object.freeze({ rules: snapshot.rules, samples: Object.freeze(samples) })
}

export function predictionRecordedSamplesMatchRules(
  samples: readonly PredictionTensorSample[],
  rules: readonly RecordedDataRule[],
) {
  if (samples.length !== rules.length) return false
  const sampleMap = new Map(samples.map((sample) => [sample.layout.key, sample]))
  return (
    sampleMap.size === samples.length &&
    rules.every(
      (rule) => sampleMap.get(rule.label)?.layout.dataSchemaSignature === predictionFingerprint([rule.result]),
    )
  )
}

export function predictedRecordedData(
  samples: readonly PredictionTensorSample[],
  rules: readonly RecordedDataRule[],
): RecordedData {
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
        if (sample.layout.dtype !== requireNumericDtype(rule.result.dtype, rule.label)) {
          throw new Error(`${rule.label} RecordedData dtype이 현재 Experiment rule과 다릅니다.`)
        }
        if (sample.layout.dataSchemaSignature !== predictionFingerprint([rule.result])) {
          throw new Error(`${rule.label} RecordedData schema가 현재 Experiment rule과 다릅니다.`)
        }
        if (sample.layout.shape.some((length) => !Number.isSafeInteger(length) || length < 0)) {
          throw new Error(`${rule.label} RecordedData Prediction shape가 올바르지 않습니다.`)
        }
        const expectedSize = sample.layout.shape.reduce((size, length) => size * length, 1)
        if (!Number.isSafeInteger(expectedSize) || sample.values.length !== expectedSize) {
          throw new Error(`${rule.label} RecordedData Prediction 값이 shape와 맞지 않습니다.`)
        }
        const value = varsTensorFromFlat(sample.values, sample.layout.shape)
        const axes = sample.layout.axes?.map((axis) => Object.freeze({ ticks: Object.freeze([...axis.ticks]) }))
        return [rule.label, createDataTensor(rule.result, { value, ...(axes?.length ? { axes } : {}) })]
      }),
    ),
  ) as RecordedData
}

export function calculationSample(record: CalculationDataRecord): PredictionTensorSample {
  return calculationOutputSample(record.calculation_id, record.data, `CalculationData #${record.id}`)
}

export function calculationOutputSample(
  calculationId: number,
  output: CalculationDataOutput,
  label = `Calculation #${calculationId}`,
): PredictionTensorSample {
  const values = output.shape.length === 0 ? [output.data] : output.data
  if (!Array.isArray(values)) throw new Error(`${label}의 data가 tensor shape와 맞지 않습니다.`)
  const sample = Object.freeze({
    layout: Object.freeze({
      key: `calculation:${calculationId}`,
      dtype: requireNumericDtype(output.dtype, label),
      shape: Object.freeze([...output.shape]),
      axes: Object.freeze(
        output.axes.map((axis) =>
          Object.freeze({
            name: axis.name,
            ticks: Object.freeze([...axis.ticks]),
            ...(axis.unit ? { unit: axis.unit } : {}),
          }),
        ),
      ),
    }),
    values: requireFlatNumbers(values, label),
  })
  calculationOutputFromSample(sample)
  return sample
}

export function calculationOutputFromSample(sample: PredictionTensorSample): CalculationDataOutput {
  if (sample.layout.shape.length > 2) throw new Error(`${sample.layout.key} 결과 rank는 2 이하여야 합니다.`)
  if (sample.layout.shape.some((length) => !Number.isSafeInteger(length) || length < 0)) {
    throw new Error(`${sample.layout.key} CalculationData shape가 올바르지 않습니다.`)
  }
  if (!calculationDtypes.has(sample.layout.dtype)) {
    throw new Error(`${sample.layout.key} dtype은 CalculationData output으로 저장할 수 없습니다.`)
  }
  const expectedSize = sample.layout.shape.reduce((size, length) => size * length, 1)
  if (!Number.isSafeInteger(expectedSize) || sample.values.length !== expectedSize) {
    throw new Error(`${sample.layout.key} 값이 CalculationData shape와 맞지 않습니다.`)
  }
  const values = requireFlatNumbers(sample.values, sample.layout.key)
  const integerRange = calculationIntegerRanges[sample.layout.dtype]
  if (
    (integerRange &&
      values.some((value) => !Number.isInteger(value) || value < integerRange[0] || value > integerRange[1])) ||
    (sample.layout.dtype === 'float32' && values.some((value) => !Number.isFinite(Math.fround(value))))
  ) {
    throw new Error(`${sample.layout.key} 값이 ${sample.layout.dtype} 범위와 맞지 않습니다.`)
  }
  const axes = sample.layout.axes ?? []
  if (
    axes.length !== sample.layout.shape.length ||
    axes.some(
      (axis, index) =>
        axis.ticks.length !== sample.layout.shape[index] ||
        axis.ticks.some((tick) => typeof tick !== 'number' || !Number.isFinite(tick)),
    )
  ) {
    throw new Error(`${sample.layout.key} axes가 CalculationData shape와 맞지 않습니다.`)
  }
  return Object.freeze({
    dtype: sample.layout.dtype as CalculationDataOutput['dtype'],
    shape: Object.freeze([...sample.layout.shape]),
    data: sample.layout.shape.length === 0 ? values[0] : values,
    axes: Object.freeze(
      axes.map((axis) =>
        Object.freeze({
          name: axis.name,
          ticks: Object.freeze(axis.ticks.map((tick) => tick as number)),
          ...(axis.unit ? { unit: axis.unit } : {}),
        }),
      ),
    ),
  })
}

export function calculationOutputTensor(output: CalculationDataOutput): Tensor {
  const sample = calculationOutputSample(0, output)
  return varsTensorFromFlat(sample.values, sample.layout.shape)
}

export function calculationOutputWithTensor(output: CalculationDataOutput, value: Tensor): CalculationDataOutput {
  const sample = calculationOutputSample(0, output)
  const flat = flattenVarsTensor(value, output.shape, 'CalculationData target')
  return calculationOutputFromSample({ layout: sample.layout, values: flat })
}

export function inverseTrainingRows(
  measurements: readonly MeasurementRecord[],
  calculationData: readonly CalculationDataRecord[],
  calculationIds: readonly number[],
  varsSchema: VarsSchema,
): readonly PredictionTrainingRow[] {
  if (new Set(calculationIds).size !== calculationIds.length) {
    throw new Error('Inverse Prediction Calculation IDs must be unique.')
  }
  const measurementMap = new Map(measurements.flatMap((row) => (row.id ? [[row.id, row] as const] : [])))
  const varsLayouts = predictionVarsLayouts(varsSchema)
  const dataByMeasurement = new Map<number, Map<number, CalculationDataRecord>>()
  calculationData.forEach((record) => {
    const byCalculation = dataByMeasurement.get(record.measurement_id) ?? new Map<number, CalculationDataRecord>()
    byCalculation.set(record.calculation_id, record)
    dataByMeasurement.set(record.measurement_id, byCalculation)
  })
  return Object.freeze(
    [...measurementMap.entries()]
      .sort(([left], [right]) => left - right)
      .map(([measurementId, measurement]) => {
        const byCalculation = dataByMeasurement.get(measurementId)
        const inputs = calculationIds.flatMap((id) => {
          const record = byCalculation?.get(id)
          if (!record) return []
          try {
            return [calculationSample(record)]
          } catch {
            return [
              Object.freeze({
                layout: Object.freeze({
                  key: `calculation:${id}`,
                  dtype: 'float64' as const,
                  shape: Object.freeze([]),
                }),
                values: Object.freeze([Number.NaN]),
              }),
            ]
          }
        })
        let outputs: readonly PredictionTensorSample[]
        try {
          outputs = predictionVarsSamples(measurement.vars as Readonly<Vars>, varsSchema)
        } catch {
          outputs = Object.freeze(
            varsLayouts.map((layout) => Object.freeze({ layout, values: Object.freeze([Number.NaN]) })),
          )
        }
        return Object.freeze({ measurementId, inputs: Object.freeze(inputs), outputs })
      }),
  )
}

export function forwardTrainingRow(
  measurement: MeasurementRecord & Readonly<{ id: number }>,
  recorded: Readonly<{ samples: readonly PredictionTensorSample[] }>,
  varsSchema: VarsSchema,
): PredictionTrainingRow {
  return Object.freeze({
    measurementId: measurement.id,
    inputs: predictionVarsSamples(measurement.vars as Readonly<Vars>, varsSchema),
    outputs: recorded.samples,
  })
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
