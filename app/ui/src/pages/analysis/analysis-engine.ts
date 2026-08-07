import { kmeans } from 'ml-kmeans'
import { Matrix, solve } from 'ml-matrix'
import { PCA } from 'ml-pca'
import { RandomForestRegression } from 'ml-random-forest'
import { mean, quantileSorted, sampleCorrelation, sampleStandardDeviation, silhouette } from 'simple-statistics'
import type { MeasurementRecord, RecordedDataRecord, SampleRecord, SetupRecord } from '@/api'
import {
  createDataTensorAccessor,
  isDataTensor,
  type DataDType,
  type DataSchema,
  type DataTensorAccessor,
} from '@/lib/cad'
import { getQuantityKindTensorOrder, type QuantityKindName } from '@/lib/quantitykind/runtime'
import type {
  AnalysisColumnDescriptor,
  AnalysisMiningResult,
  AnalysisPredictionResult,
  AnalysisProfile,
  AnalysisTablePage,
} from './analysis-types'

export const ANALYSIS_MAX_ROWS = 10_000
export const ANALYSIS_MAX_COLUMNS = 500
export const ANALYSIS_MAX_PREDICTION_FEATURES = 50

type RowIdentity = Readonly<{
  measurementId: number
  sampleId: number
  setupId: number
}>

type AnalysisColumn = Readonly<{
  descriptor: AnalysisColumnDescriptor
  values: Float64Array
}>

export type AnalysisDataset = {
  profile: AnalysisProfile
  rows: readonly RowIdentity[]
  columns: ReadonlyMap<string, AnalysisColumn>
  lastMining: AnalysisMiningResult | null
  lastPrediction: AnalysisPredictionResult | null
}

type ColumnState = {
  key: string
  label: string
  kind: 'feature' | 'target'
  source: AnalysisColumnDescriptor['source']
  values: number[]
  unit?: string
  quantityKind?: string
  statistic?: string
  root?: string
  invalidReason?: string
}

type NumericObservation = Readonly<{
  key: string
  label: string
  source: AnalysisColumnDescriptor['source']
  value: number
  unit?: string
  root?: string
  signature?: string
}>

type FittedPreprocessor = Readonly<{
  featureKeys: readonly string[]
  medians: readonly number[]
  means: readonly number[]
  standardDeviations: readonly number[]
  indicatorIndexes: readonly number[]
  expandedFeatureIndexes: readonly number[]
}>

type RidgeModel = Readonly<{
  coefficients: readonly number[]
  intercept: number
}>

type RecordedTensorView = Readonly<{
  accessor: Pick<DataTensorAccessor, 'at' | 'shape' | 'size'>
  quantityKind?: string
  schema: DataSchema
  signature: string
  tensorOrder: number
  unit?: string
}>

const RECORDED_QUANTILE_SAMPLE_LIMIT = 4_096

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function numericTensor(value: unknown): Readonly<{ flat: readonly number[]; shape: readonly number[] }> | null {
  if (finiteNumber(value)) return { flat: [value], shape: [] }
  if (!Array.isArray(value) || value.length === 0) return null

  const children = value.map(numericTensor)
  if (children.some((child) => child === null)) return null
  const resolved = children as readonly Readonly<{ flat: readonly number[]; shape: readonly number[] }>[]
  const childShape = JSON.stringify(resolved[0].shape)
  if (resolved.some((child) => JSON.stringify(child.shape) !== childShape)) return null
  return {
    flat: resolved.flatMap((child) => child.flat),
    shape: [value.length, ...resolved[0].shape],
  }
}

function componentPath(index: number, shape: readonly number[]) {
  if (shape.length === 0) return ''
  const coordinates: number[] = []
  let remaining = index
  for (let dimension = shape.length - 1; dimension >= 0; dimension -= 1) {
    coordinates.unshift(remaining % shape[dimension])
    remaining = Math.floor(remaining / shape[dimension])
  }
  return coordinates.map((coordinate) => `[${coordinate}]`).join('')
}

function extractVars(
  value: unknown,
  prefix: string,
  source: 'sample-vars' | 'setup-vars',
  observations: NumericObservation[],
) {
  if (finiteNumber(value)) {
    observations.push({ key: prefix, label: prefix, source, value })
    return
  }
  if (Array.isArray(value)) {
    const tensor = numericTensor(value)
    if (!tensor) return
    tensor.flat.forEach((item, index) => {
      const key = `${prefix}${componentPath(index, tensor.shape)}`
      observations.push({ key, label: key, source, value: item })
    })
    return
  }
  if (!isRecord(value)) return
  Object.entries(value).forEach(([key, child]) => {
    const normalizedKey = key.toLowerCase()
    if (
      normalizedKey === 'id' ||
      normalizedKey.endsWith('_id') ||
      key.endsWith('Id') ||
      normalizedKey === 'metadata' ||
      normalizedKey === 'meta' ||
      normalizedKey.startsWith('_')
    )
      return
    extractVars(child, prefix ? `${prefix}.${key}` : key, source, observations)
  })
}

function extractMaterials(
  value: unknown,
  prefix: 'sample' | 'setup',
  source: 'sample-material' | 'setup-material',
  observations: NumericObservation[],
) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.materials)) return
  Object.entries(value.materials).forEach(([materialName, rawParameters]) => {
    if (!isRecord(rawParameters)) return
    Object.entries(rawParameters).forEach(([parameterName, rawParameter]) => {
      if (!isRecord(rawParameter) || !isRecord(rawParameter.value)) return
      const parameterValue = rawParameter.value
      if (parameterValue.kind === 'sampled_relation' || typeof parameterValue.unit !== 'string') return
      const tensor = numericTensor(parameterValue.value)
      if (!tensor) return
      const root = `${prefix}.material.${materialName}.${parameterName}`
      const signature = `${parameterValue.unit}:${JSON.stringify(tensor.shape)}`
      tensor.flat.forEach((item, index) => {
        const key = `${root}${componentPath(index, tensor.shape)}`
        observations.push({
          key,
          label: key,
          source,
          value: item,
          unit: parameterValue.unit as string,
          root,
          signature,
        })
      })
    })
  })
}

function recordedTargets(row: RecordedDataRecord): Readonly<{
  observations: readonly Readonly<{
    key: string
    label: string
    value: number
    statistic?: string
  }>[]
  quantityKind?: string
  signature: string
  unit?: string
}> | null {
  const tensor = recordedTensor(row)
  if (!tensor || tensor.schema.dtype === 'bool' || tensor.schema.dtype === 'string' || tensor.accessor.size === 0) {
    return null
  }
  const componentSize = 3 ** tensor.tensorOrder
  if (!Number.isSafeInteger(componentSize) || componentSize <= 0 || tensor.accessor.size % componentSize !== 0) {
    return null
  }
  const valueCount = tensor.accessor.size / componentSize
  const sampleStep = Math.max(1, Math.ceil(valueCount / RECORDED_QUANTILE_SAMPLE_LIMIT))
  const quantileSample: number[] = []
  let average = 0
  let count = 0
  let maximum = Number.NEGATIVE_INFINITY
  let minimum = Number.POSITIVE_INFINITY
  let squaredDeviation = 0
  let singleValue = 0
  for (let valueIndex = 0; valueIndex < valueCount; valueIndex += 1) {
    const index = valueIndex * componentSize
    let value: number
    if (componentSize === 1) {
      const component = tensor.accessor.at(index)
      if (typeof component !== 'number') return null
      value = component
    } else {
      let squared = 0
      for (let componentIndex = 0; componentIndex < componentSize; componentIndex += 1) {
        const component = tensor.accessor.at(index + componentIndex)
        if (typeof component !== 'number') return null
        squared += component ** 2
      }
      value = Math.sqrt(squared)
    }
    count += 1
    const delta = value - average
    average += delta / count
    squaredDeviation += delta * (value - average)
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
    singleValue = value
    if (valueIndex % sampleStep === 0 || valueIndex === valueCount - 1) quantileSample.push(value)
  }

  if (count === 1) {
    return {
      observations: [
        {
          key: `target:${row.name}`,
          label: row.name,
          value: singleValue,
          ...(tensor.tensorOrder > 0 ? { statistic: 'magnitude' } : {}),
        },
      ],
      ...(tensor.quantityKind ? { quantityKind: tensor.quantityKind } : {}),
      signature: tensor.signature,
      ...(tensor.unit ? { unit: tensor.unit } : {}),
    }
  }

  quantileSample.sort((left, right) => left - right)
  const summaries = {
    mean: average,
    std: Math.sqrt(squaredDeviation / (count - 1)),
    min: minimum,
    max: maximum,
    p05: quantileSorted(quantileSample, 0.05),
    p50: quantileSorted(quantileSample, 0.5),
    p95: quantileSorted(quantileSample, 0.95),
  }
  return {
    observations: Object.entries(summaries).map(([statistic, value]) => ({
      key: `target:${row.name}:${statistic}`,
      label: `${row.name} · ${statistic}`,
      statistic,
      value,
    })),
    ...(tensor.quantityKind ? { quantityKind: tensor.quantityKind } : {}),
    signature: tensor.signature,
    ...(tensor.unit ? { unit: tensor.unit } : {}),
  }
}

function recordedTensor(row: RecordedDataRecord): RecordedTensorView | null {
  if (!isRecord(row.data)) return null
  if (!isDataTensor(row.data)) {
    const legacy = numericTensor(row.data.value)
    if (!legacy) return null
    const storedSchema = row.data_schema as DataSchema | null | undefined
    const tensorOrder =
      storedSchema?.quantityKind === undefined
        ? row.tensor_order
        : getQuantityKindTensorOrder(storedSchema.quantityKind as QuantityKindName)
    if (
      storedSchema &&
      (storedSchema.dtype !== row.dtype ||
        storedSchema.quantityKind !== (row.quantity_kind ?? undefined) ||
        tensorOrder !== row.tensor_order)
    ) {
      return null
    }
    return {
      accessor: {
        at: (index) => legacy.flat[index],
        shape: legacy.shape,
        size: legacy.flat.length,
      },
      ...(storedSchema?.quantityKind || row.quantity_kind
        ? { quantityKind: storedSchema?.quantityKind ?? row.quantity_kind ?? undefined }
        : {}),
      schema: storedSchema ?? ({ dtype: row.dtype as DataDType } as DataSchema),
      signature: storedSchema
        ? `schema:${JSON.stringify(storedSchema)}`
        : `legacy:${row.dtype}:${row.quantity_kind ?? ''}:${row.tensor_order}`,
      tensorOrder,
      ...(storedSchema?.unit ? { unit: storedSchema.unit } : {}),
    }
  }
  try {
    const storedSchema = row.data_schema as DataSchema | null | undefined
    let schema: DataSchema
    let tensorOrder: number
    if (storedSchema) {
      if (storedSchema.dtype !== row.dtype) return null
      tensorOrder =
        storedSchema.quantityKind === undefined
          ? 0
          : getQuantityKindTensorOrder(storedSchema.quantityKind as QuantityKindName)
      if (storedSchema.quantityKind !== (row.quantity_kind ?? undefined) || tensorOrder !== row.tensor_order) {
        return null
      }
      schema = storedSchema
    } else {
      tensorOrder = row.tensor_order
      const outerRank = row.data.shape.length - tensorOrder
      if (outerRank < 0) return null
      const quantityMetadata =
        row.dtype.startsWith('float') && row.quantity_kind
          ? (() => {
              if (getQuantityKindTensorOrder(row.quantity_kind as QuantityKindName) !== tensorOrder) {
                throw new Error('Legacy RecordedData QuantityKind does not match tensor_order.')
              }
              return { quantityKind: row.quantity_kind, unit: '1' }
            })()
          : {}
      schema = {
        dtype: row.dtype as DataDType,
        ...quantityMetadata,
        axes: row.data.shape.slice(0, outerRank).map((length) => ({ length })),
      } as DataSchema
    }
    const accessor = createDataTensorAccessor(schema, row.data, `RecordedData ${JSON.stringify(row.name)}`)
    return {
      accessor,
      ...(storedSchema?.quantityKind ? { quantityKind: storedSchema.quantityKind } : {}),
      schema,
      signature: storedSchema
        ? `schema:${JSON.stringify(storedSchema)}`
        : `legacy:${row.dtype}:${row.quantity_kind ?? ''}:${row.tensor_order}`,
      tensorOrder,
      ...(storedSchema?.unit ? { unit: storedSchema.unit } : {}),
    }
  } catch {
    return null
  }
}

function categoricalValues(value: unknown): string[] {
  if (typeof value === 'boolean' || typeof value === 'string') return [String(value)]
  if (!Array.isArray(value)) return []
  return value.flatMap(categoricalValues)
}

function forEachRecordedCategoricalValue(row: RecordedDataRecord, visit: (value: string) => void): void {
  if (isRecord(row.data) && !isDataTensor(row.data)) {
    categoricalValues(row.data.value).forEach(visit)
    return
  }
  const tensor = recordedTensor(row)
  if (!tensor) return
  for (let index = 0; index < tensor.accessor.size; index += 1) {
    const value = tensor.accessor.at(index)
    if (typeof value === 'boolean' || typeof value === 'string') visit(String(value))
  }
}

function describeColumn(state: ColumnState, values: Float64Array, rowCount: number): AnalysisColumnDescriptor {
  const finite = Array.from(values).filter(Number.isFinite)
  const sorted = [...finite].sort((left, right) => left - right)
  const distinctCount = new Set(finite).size
  const missingRatio = rowCount === 0 ? 1 : 1 - finite.length / rowCount
  const reasons: string[] = []
  if (state.invalidReason) reasons.push(state.invalidReason)
  if (state.kind === 'feature' && missingRatio > 0.3) reasons.push('누락률이 30%를 초과합니다.')
  if (distinctCount <= 1) reasons.push('값이 하나뿐인 상수 열입니다.')
  if (finite.length === 0) reasons.push('유효한 숫자 값이 없습니다.')
  const eligible = reasons.length === 0
  const histogram =
    finite.length === 0
      ? []
      : (() => {
          const binCount = Math.min(12, Math.max(1, Math.ceil(Math.sqrt(finite.length))))
          const minimum = sorted[0]
          const maximum = sorted[sorted.length - 1]
          if (minimum === maximum) return [{ min: minimum, max: maximum, count: finite.length }]
          const width = (maximum - minimum) / binCount
          const counts = Array(binCount).fill(0) as number[]
          finite.forEach((value) => {
            counts[Math.min(binCount - 1, Math.floor((value - minimum) / width))] += 1
          })
          return counts.map((count, index) => ({
            min: minimum + width * index,
            max: index === binCount - 1 ? maximum : minimum + width * (index + 1),
            count,
          }))
        })()

  return {
    key: state.key,
    label: state.label,
    kind: state.kind,
    source: state.source,
    count: finite.length,
    distinctCount,
    missingRatio,
    eligible,
    ...(reasons.length > 0 ? { exclusionReason: reasons.join(' ') } : {}),
    ...(state.unit ? { unit: state.unit } : {}),
    ...(state.quantityKind ? { quantityKind: state.quantityKind } : {}),
    ...(state.statistic ? { statistic: state.statistic } : {}),
    ...(histogram.length > 0 ? { histogram } : {}),
    ...(finite.length > 0
      ? {
          min: sorted[0],
          max: sorted[sorted.length - 1],
          mean: mean(finite),
          std: finite.length > 1 ? sampleStandardDeviation(finite) : 0,
          p05: quantileSorted(sorted, 0.05),
          p25: quantileSorted(sorted, 0.25),
          p50: quantileSorted(sorted, 0.5),
          p75: quantileSorted(sorted, 0.75),
          p95: quantileSorted(sorted, 0.95),
        }
      : {}),
  }
}

function sourceOrder(source: AnalysisColumnDescriptor['source']) {
  return {
    'sample-vars': 0,
    'setup-vars': 1,
    'sample-material': 2,
    'setup-material': 3,
    'recorded-data': 4,
  }[source]
}

export function stableSignature(rows: readonly Readonly<{ id?: number; updated_at?: string | null }>[]) {
  const source = rows
    .map((row) => `${row.id ?? ''}:${row.updated_at ?? ''}`)
    .sort()
    .join('|')
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

export function createMeasurementRanges(ids: readonly number[]) {
  const normalized = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b)
  const ranges: Readonly<{ min: number; max: number; ids: readonly number[] }>[] = []
  let current: number[] = []
  for (const id of normalized) {
    const first = current[0]
    if (current.length > 0 && (current.length >= 500 || id - first > 2_000)) {
      ranges.push({ min: current[0], max: current[current.length - 1], ids: current })
      current = []
    }
    current.push(id)
  }
  if (current.length > 0) ranges.push({ min: current[0], max: current[current.length - 1], ids: current })
  return ranges
}

export function buildAnalysisDataset({
  experimentId,
  fingerprint,
  measurements,
  recordedData,
  samples,
  setups,
  structureId,
}: {
  experimentId: number
  fingerprint: string
  measurements: readonly MeasurementRecord[]
  recordedData: readonly RecordedDataRecord[]
  samples: readonly SampleRecord[]
  setups: readonly SetupRecord[]
  structureId: number
}): AnalysisDataset {
  if (measurements.length > ANALYSIS_MAX_ROWS) {
    throw new Error(`Analysis는 최대 ${ANALYSIS_MAX_ROWS.toLocaleString()}개 Measurement까지 지원합니다.`)
  }

  const usableMeasurements = measurements.filter(
    (row): row is MeasurementRecord & { id: number } => Number.isSafeInteger(row.id) && (row.id ?? 0) > 0,
  )
  const sampleById = new Map(
    samples.filter((row): row is SampleRecord & { id: number } => Boolean(row.id)).map((row) => [row.id, row]),
  )
  const setupById = new Map(
    setups.filter((row): row is SetupRecord & { id: number } => Boolean(row.id)).map((row) => [row.id, row]),
  )
  const recordedByMeasurement = new Map<number, RecordedDataRecord[]>()
  recordedData.forEach((row) => {
    const rows = recordedByMeasurement.get(row.measurement_id) ?? []
    rows.push(row)
    recordedByMeasurement.set(row.measurement_id, rows)
  })

  const states = new Map<string, ColumnState>()
  const materialSignatures = new Map<string, Set<string>>()
  const targetSignatures = new Map<string, Set<string>>()
  const targetKeysByName = new Map<string, Set<string>>()
  const categoricalStates = new Map<
    string,
    {
      counts: Map<string, number>
      dtype: string
      name: string
      quantityKind?: string
      signatures: Set<string>
    }
  >()
  const identities: RowIdentity[] = []
  let recordedDataCount = 0

  const observe = (observation: NumericObservation, rowIndex: number) => {
    let state = states.get(observation.key)
    if (!state) {
      if (states.size >= ANALYSIS_MAX_COLUMNS) {
        throw new Error(`Analysis는 최대 ${ANALYSIS_MAX_COLUMNS}개 scalar column까지 지원합니다.`)
      }
      state = {
        key: observation.key,
        label: observation.label,
        kind: 'feature',
        source: observation.source,
        values: Array(rowIndex + 1).fill(Number.NaN),
        ...(observation.unit ? { unit: observation.unit } : {}),
        ...(observation.root ? { root: observation.root } : {}),
      }
      states.set(observation.key, state)
    } else {
      while (state.values.length <= rowIndex) state.values.push(Number.NaN)
      if (state.unit !== observation.unit) state.invalidReason = 'Material unit이 행마다 다릅니다.'
    }
    state.values[rowIndex] = observation.value
    if (observation.root && observation.signature) {
      const signatures = materialSignatures.get(observation.root) ?? new Set<string>()
      signatures.add(observation.signature)
      materialSignatures.set(observation.root, signatures)
    }
  }

  usableMeasurements.forEach((measurement) => {
    const rowIndex = identities.length
    const sample = sampleById.get(measurement.sample_id)
    const setup = setupById.get(measurement.setup_id)
    if (!sample || !setup) return
    identities.push({
      measurementId: measurement.id,
      sampleId: measurement.sample_id,
      setupId: measurement.setup_id,
    })
    states.forEach((state) => state.values.push(Number.NaN))

    const observations: NumericObservation[] = []
    extractVars(sample.vars, 'sample.vars', 'sample-vars', observations)
    extractVars(setup.vars, 'setup.vars', 'setup-vars', observations)
    extractMaterials(sample.material_parameters, 'sample', 'sample-material', observations)
    extractMaterials(setup.material_parameters, 'setup', 'setup-material', observations)
    observations.forEach((observation) => observe(observation, rowIndex))

    const resultRows = recordedByMeasurement.get(measurement.id) ?? []
    recordedDataCount += resultRows.length
    resultRows.forEach((resultRow) => {
      const storedSchema = resultRow.data_schema
      const quantityKind = storedSchema?.quantityKind ?? resultRow.quantity_kind ?? undefined
      const schemaSignature = storedSchema
        ? `schema:${JSON.stringify(storedSchema)}`
        : `legacy:${resultRow.dtype}:${resultRow.quantity_kind ?? ''}:${resultRow.tensor_order}`
      const signatures = targetSignatures.get(resultRow.name) ?? new Set<string>()
      signatures.add(schemaSignature)
      targetSignatures.set(resultRow.name, signatures)
      if (resultRow.dtype === 'bool' || resultRow.dtype === 'string') {
        const state = categoricalStates.get(resultRow.name) ?? {
          counts: new Map<string, number>(),
          dtype: resultRow.dtype,
          name: resultRow.name,
          ...(quantityKind ? { quantityKind } : {}),
          signatures: new Set<string>(),
        }
        state.signatures.add(schemaSignature)
        forEachRecordedCategoricalValue(resultRow, (value) => {
          state.counts.set(value, (state.counts.get(value) ?? 0) + 1)
        })
        categoricalStates.set(resultRow.name, state)
      }
      const extracted = recordedTargets(resultRow)
      if (!extracted) return
      const keys = targetKeysByName.get(resultRow.name) ?? new Set<string>()
      extracted.observations.forEach((target) => {
        keys.add(target.key)
        let state = states.get(target.key)
        if (!state) {
          if (states.size >= ANALYSIS_MAX_COLUMNS) {
            throw new Error(`Analysis는 최대 ${ANALYSIS_MAX_COLUMNS}개 scalar column까지 지원합니다.`)
          }
          state = {
            key: target.key,
            label: target.label,
            kind: 'target',
            source: 'recorded-data',
            values: Array(rowIndex + 1).fill(Number.NaN),
            ...(extracted.quantityKind ? { quantityKind: extracted.quantityKind } : {}),
            ...(extracted.unit ? { unit: extracted.unit } : {}),
            ...(target.statistic ? { statistic: target.statistic } : {}),
          }
          states.set(target.key, state)
        } else {
          while (state.values.length <= rowIndex) state.values.push(Number.NaN)
          if (state.quantityKind !== extracted.quantityKind || state.unit !== extracted.unit) {
            state.invalidReason = 'Recorded Data QuantityKind가 행마다 다릅니다.'
          }
        }
        state.values[rowIndex] = target.value
      })
      targetKeysByName.set(resultRow.name, keys)
    })
  })

  materialSignatures.forEach((signatures, root) => {
    if (signatures.size <= 1) return
    states.forEach((state) => {
      if (state.root === root) state.invalidReason = 'Material shape 또는 unit이 행마다 다릅니다.'
    })
  })
  targetSignatures.forEach((signatures, name) => {
    if (signatures.size <= 1) return
    targetKeysByName.get(name)?.forEach((key) => {
      const state = states.get(key)
      if (state) state.invalidReason = 'Recorded Data schema가 행마다 다릅니다.'
    })
  })

  const columns = new Map<string, AnalysisColumn>()
  states.forEach((state) => {
    while (state.values.length < identities.length) state.values.push(Number.NaN)
    const values = Float64Array.from(state.values)
    columns.set(state.key, {
      descriptor: describeColumn(state, values, identities.length),
      values,
    })
  })
  const descriptors = [...columns.values()]
    .map((column) => column.descriptor)
    .sort((left, right) => sourceOrder(left.source) - sourceOrder(right.source) || left.key.localeCompare(right.key))

  const warnings: string[] = []
  if (identities.length !== usableMeasurements.length) {
    warnings.push('부모 Sample 또는 Setup을 찾을 수 없는 Measurement를 제외했습니다.')
  }
  if (recordedDataCount === 0 && identities.length > 0) {
    warnings.push('분석할 Recorded Data가 없습니다.')
  }

  return {
    profile: {
      fingerprint,
      structureId,
      experimentId,
      rowCount: identities.length,
      sampleCount: new Set(identities.map((row) => row.sampleId)).size,
      setupCount: new Set(identities.map((row) => row.setupId)).size,
      recordedDataCount,
      columns: descriptors,
      categoricalSummaries: [...categoricalStates.values()]
        .map((state) => ({
          name: state.name,
          dtype: state.dtype,
          ...(state.quantityKind ? { quantityKind: state.quantityKind } : {}),
          counts: [...state.counts.entries()]
            .map(([value, count]) => ({ value, count }))
            .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value)),
          ...(state.signatures.size > 1 ? { excludedReason: 'Recorded Data schema가 행마다 다릅니다.' } : {}),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      warnings,
    },
    rows: identities,
    columns,
    lastMining: null,
    lastPrediction: null,
  }
}

function requireColumns(dataset: AnalysisDataset, keys: readonly string[], kind?: 'feature' | 'target') {
  return keys.map((key) => {
    const column = dataset.columns.get(key)
    if (!column || !column.descriptor.eligible || (kind && column.descriptor.kind !== kind)) {
      throw new Error(`분석에 사용할 수 없는 column입니다: ${key}`)
    }
    return column
  })
}

function median(values: readonly number[]) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (finite.length === 0) return 0
  return quantileSorted(finite, 0.5)
}

function fittedPreprocessor(
  raw: readonly (readonly number[])[],
  trainIndexes: readonly number[],
  featureKeys: readonly string[],
): FittedPreprocessor {
  const medians = featureKeys.map((_, feature) => median(trainIndexes.map((row) => raw[row][feature])))
  const indicatorIndexes = featureKeys
    .map((_, feature) => feature)
    .filter((feature) => trainIndexes.some((row) => !Number.isFinite(raw[row][feature])))
  const imputed = trainIndexes.map((row) =>
    featureKeys.map((_, feature) => (Number.isFinite(raw[row][feature]) ? raw[row][feature] : medians[feature])),
  )
  const expanded = imputed.map((row, rowIndex) => [
    ...row,
    ...indicatorIndexes.map((feature) => (Number.isFinite(raw[trainIndexes[rowIndex]][feature]) ? 0 : 1)),
  ])
  const means = expanded[0].map((_, column) => mean(expanded.map((row) => row[column])))
  const standardDeviations = expanded[0].map((_, column) => {
    const values = expanded.map((row) => row[column])
    const value = values.length > 1 ? sampleStandardDeviation(values) : 0
    return value > 0 && Number.isFinite(value) ? value : 1
  })
  return {
    featureKeys,
    medians,
    means,
    standardDeviations,
    indicatorIndexes,
    expandedFeatureIndexes: [...featureKeys.map((_, feature) => feature), ...indicatorIndexes],
  }
}

function transformRows(
  raw: readonly (readonly number[])[],
  indexes: readonly number[],
  preprocessor: FittedPreprocessor,
) {
  return indexes.map((rowIndex) => {
    const original = raw[rowIndex]
    const expanded = [
      ...preprocessor.featureKeys.map((_, feature) =>
        Number.isFinite(original[feature]) ? original[feature] : preprocessor.medians[feature],
      ),
      ...preprocessor.indicatorIndexes.map((feature) => (Number.isFinite(original[feature]) ? 0 : 1)),
    ]
    return expanded.map(
      (value, column) => (value - preprocessor.means[column]) / preprocessor.standardDeviations[column],
    )
  })
}

function fitRidge(matrix: readonly (readonly number[])[], target: readonly number[], alpha: number): RidgeModel {
  const x = new Matrix(matrix as number[][])
  const yMean = mean(target as number[])
  const y = Matrix.columnVector(target.map((value) => value - yMean))
  const xt = x.transpose()
  const regularized = xt.mmul(x)
  for (let index = 0; index < regularized.rows; index += 1) {
    regularized.set(index, index, regularized.get(index, index) + alpha)
  }
  const coefficients = solve(regularized, xt.mmul(y), true).getColumn(0)
  return { coefficients, intercept: yMean }
}

function predictRidge(model: RidgeModel, matrix: readonly (readonly number[])[]) {
  return matrix.map(
    (row) => model.intercept + row.reduce((sum, value, index) => sum + value * model.coefficients[index], 0),
  )
}

function fitForest(matrix: number[][], target: number[], seed: number) {
  const featureCount = matrix[0].length
  const model = new RandomForestRegression({
    maxFeatures: Math.max(1, Math.floor(Math.sqrt(featureCount))),
    replacement: false,
    nEstimators: 50,
    seed,
    useSampleBagging: true,
    noOOB: true,
    selectionMethod: 'mean',
    treeOptions: { maxDepth: 20, minNumSamples: 3 },
  })
  model.train(matrix, target)
  return model
}

function metrics(observed: readonly number[], predicted: readonly number[]) {
  const residuals = observed.map((value, index) => value - predicted[index])
  const mae = mean(residuals.map(Math.abs))
  const rmse = Math.sqrt(mean(residuals.map((value) => value ** 2)))
  const observedMean = mean(observed as number[])
  const total = observed.reduce((sum, value) => sum + (value - observedMean) ** 2, 0)
  const error = residuals.reduce((sum, value) => sum + value ** 2, 0)
  return { r2: total > 0 ? 1 - error / total : 0, mae, rmse }
}

function groupFolds(rows: readonly RowIdentity[], rowIndexes: readonly number[]) {
  const groups = new Map<number, number[]>()
  rowIndexes.forEach((rowIndex) => {
    const sampleId = rows[rowIndex].sampleId
    const group = groups.get(sampleId) ?? []
    group.push(rowIndex)
    groups.set(sampleId, group)
  })
  if (groups.size < 5) throw new Error('Prediction에는 서로 다른 Sample이 5개 이상 필요합니다.')
  const foldCount = Math.min(5, groups.size)
  const folds = Array.from({ length: foldCount }, () => [] as number[])
  const sizes = Array(foldCount).fill(0) as number[]
  ;[...groups.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0] - right[0])
    .forEach(([, group]) => {
      const targetFold = sizes.indexOf(Math.min(...sizes))
      folds[targetFold].push(...group)
      sizes[targetFold] += group.length
    })
  return folds
}

function rawFeatureRows(dataset: AnalysisDataset, featureKeys: readonly string[]) {
  const columns = requireColumns(dataset, featureKeys, 'feature')
  return dataset.rows.map((_, rowIndex) => columns.map((column) => column.values[rowIndex]))
}

function pairwiseCorrelation(left: Float64Array, right: Float64Array) {
  const pairs: [number, number][] = []
  for (let index = 0; index < left.length; index += 1) {
    if (Number.isFinite(left[index]) && Number.isFinite(right[index])) pairs.push([left[index], right[index]])
  }
  if (
    pairs.length < 3 ||
    new Set(pairs.map((pair) => pair[0])).size <= 1 ||
    new Set(pairs.map((pair) => pair[1])).size <= 1
  )
    return null
  const first = pairs.map((pair) => pair[0])
  const second = pairs.map((pair) => pair[1])
  const value = sampleCorrelation(first, second)
  return Number.isFinite(value) ? value : null
}

function rankValues(values: Float64Array) {
  const ranked = new Float64Array(values.length)
  ranked.fill(Number.NaN)
  const ordered = Array.from(values)
    .map((value, index) => ({ index, value }))
    .filter((entry) => Number.isFinite(entry.value))
    .sort((left, right) => left.value - right.value || left.index - right.index)
  let start = 0
  while (start < ordered.length) {
    let end = start + 1
    while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1
    const rank = (start + end - 1) / 2 + 1
    for (let index = start; index < end; index += 1) ranked[ordered[index].index] = rank
    start = end
  }
  return ranked
}

function medianImputedValues(values: Float64Array) {
  const replacement = median(Array.from(values))
  return Float64Array.from(values, (value) => (Number.isFinite(value) ? value : replacement))
}

function standardizedMatrix(dataset: AnalysisDataset, featureKeys: readonly string[]) {
  const raw = rawFeatureRows(dataset, featureKeys)
  const indexes = dataset.rows.map((_, index) => index)
  const preprocessor = fittedPreprocessor(raw, indexes, featureKeys)
  const transformed = transformRows(raw, indexes, {
    ...preprocessor,
    indicatorIndexes: [],
    expandedFeatureIndexes: featureKeys.map((_, index) => index),
    means: preprocessor.means.slice(0, featureKeys.length),
    standardDeviations: preprocessor.standardDeviations.slice(0, featureKeys.length),
  })
  return transformed
}

function evenlySpacedIndexes(length: number, maximum: number) {
  if (length <= maximum) return Array.from({ length }, (_, index) => index)
  return Array.from({ length: maximum }, (_, index) => Math.floor((index * (length - 1)) / (maximum - 1)))
}

export function mineDataset(
  dataset: AnalysisDataset,
  {
    featureKeys,
    outlierFraction,
    targetKey,
    xKey,
    yKey,
  }: {
    featureKeys: readonly string[]
    outlierFraction: number
    targetKey: string | null
    xKey: string | null
    yKey: string | null
  },
): AnalysisMiningResult {
  if (dataset.rows.length < 3) throw new Error('Mining에는 Measurement가 3개 이상 필요합니다.')
  if (featureKeys.length < 2 || featureKeys.length > ANALYSIS_MAX_PREDICTION_FEATURES) {
    throw new Error(`Mining feature는 2개 이상 ${ANALYSIS_MAX_PREDICTION_FEATURES}개 이하여야 합니다.`)
  }
  requireColumns(dataset, featureKeys, 'feature')
  if (targetKey) requireColumns(dataset, [targetKey], 'target')
  const boundedOutlierFraction = Math.min(0.1, Math.max(0.01, outlierFraction))
  const matrix = standardizedMatrix(dataset, featureKeys)
  const pca = new PCA(matrix, { center: false, scale: false })
  const projected = pca.predict(matrix, { nComponents: 2 }).to2DArray()
  const explainedVariance = pca.getExplainedVariance()
  const loadingsMatrix = pca.getLoadings()
  const loadings = featureKeys.map((key, index) => ({
    key,
    pc1: loadingsMatrix.get(index, 0),
    pc2: loadingsMatrix.columns > 1 ? loadingsMatrix.get(index, 1) : 0,
  }))

  const selectionIndexes = evenlySpacedIndexes(matrix.length, 1_000)
  const selectionMatrix = selectionIndexes.map((index) => matrix[index])
  const maximumK = Math.max(2, Math.min(8, Math.floor(Math.sqrt(matrix.length)), matrix.length - 1))
  let bestK = 2
  let bestSilhouette = Number.NEGATIVE_INFINITY
  for (let clusterCount = 2; clusterCount <= maximumK; clusterCount += 1) {
    const candidate = kmeans(selectionMatrix, clusterCount, { initialization: 'kmeans++', seed: 42 })
    const values = silhouette(selectionMatrix, candidate.clusters)
    const score = values.length > 0 ? mean(values) : Number.NEGATIVE_INFINITY
    if (score > bestSilhouette) {
      bestSilhouette = score
      bestK = clusterCount
    }
  }
  const clusters = kmeans(matrix, bestK, { initialization: 'kmeans++', seed: 42 }).clusters

  const cumulative = pca.getCumulativeVariance()
  let retained = cumulative.findIndex((value) => value >= 0.9) + 1
  if (retained <= 0) retained = Math.min(matrix[0].length, 2)
  retained = Math.max(1, Math.min(retained, matrix[0].length))
  const eigenvectors = pca.getEigenvectors().subMatrix(0, matrix[0].length - 1, 0, retained - 1)
  const sourceMatrix = new Matrix(matrix)
  const reconstructed = sourceMatrix.mmul(eigenvectors).mmul(eigenvectors.transpose())
  const errors = matrix.map((row, rowIndex) =>
    row.reduce((sum, value, column) => sum + (value - reconstructed.get(rowIndex, column)) ** 2, 0),
  )
  const outlierCount = Math.max(1, Math.ceil(errors.length * boundedOutlierFraction))
  const outlierIndexes = new Set(
    errors
      .map((value, index) => ({ index, value }))
      .sort((left, right) => right.value - left.value || left.index - right.index)
      .slice(0, outlierCount)
      .map((entry) => entry.index),
  )

  const correlationKeys = [...featureKeys, ...(targetKey ? [targetKey] : [])]
  const correlationColumns = requireColumns(dataset, correlationKeys)
  const imputedColumns = correlationColumns.map((column) => medianImputedValues(column.values))
  const correlations = imputedColumns.map((left) => imputedColumns.map((right) => pairwiseCorrelation(left, right)))
  const rankedColumns = imputedColumns.map(rankValues)
  const spearmanCorrelations = rankedColumns.map((left) =>
    rankedColumns.map((right) => pairwiseCorrelation(left, right)),
  )
  const xValues = xKey ? requireColumns(dataset, [xKey])[0].values : null
  const yValues = yKey ? requireColumns(dataset, [yKey])[0].values : null
  const result: AnalysisMiningResult = {
    fingerprint: dataset.profile.fingerprint,
    featureKeys,
    correlationKeys,
    correlations,
    spearmanCorrelations,
    explainedVariance: explainedVariance.slice(0, 2),
    loadings,
    points: dataset.rows.map((row, index) => ({
      ...row,
      pc1: projected[index]?.[0] ?? 0,
      pc2: projected[index]?.[1] ?? 0,
      cluster: clusters[index],
      anomalyScore: errors[index],
      outlier: outlierIndexes.has(index),
      ...(xValues && Number.isFinite(xValues[index]) ? { x: xValues[index] } : {}),
      ...(yValues && Number.isFinite(yValues[index]) ? { y: yValues[index] } : {}),
    })),
    clusterCount: bestK,
    silhouette: bestSilhouette,
    outlierFraction: boundedOutlierFraction,
  }
  dataset.lastMining = result
  return result
}

export function predictDataset(
  dataset: AnalysisDataset,
  {
    featureKeys,
    targetKey,
    whatIf,
  }: {
    featureKeys: readonly string[]
    targetKey: string
    whatIf: Readonly<Record<string, number>>
  },
  onFinalTraining?: () => void,
): AnalysisPredictionResult {
  if (featureKeys.length === 0 || featureKeys.length > ANALYSIS_MAX_PREDICTION_FEATURES) {
    throw new Error(`Prediction feature는 1개 이상 ${ANALYSIS_MAX_PREDICTION_FEATURES}개 이하여야 합니다.`)
  }
  const target = requireColumns(dataset, [targetKey], 'target')[0]
  requireColumns(dataset, featureKeys, 'feature')
  const validIndexes = dataset.rows.map((_, index) => index).filter((index) => Number.isFinite(target.values[index]))
  if (validIndexes.length < 20) throw new Error('Prediction에는 target이 있는 Measurement가 20개 이상 필요합니다.')
  const observed = validIndexes.map((index) => target.values[index])
  if (new Set(observed).size < 5) throw new Error('Prediction target에는 서로 다른 값이 5개 이상 필요합니다.')
  const folds = groupFolds(dataset.rows, validIndexes)
  const rawAll = rawFeatureRows(dataset, featureKeys)
  const ridgeAlphas = [1e-4, 1e-3, 1e-2, 1e-1, 1, 10, 100, 1_000, 10_000]
  const ridgePredictions = new Map(ridgeAlphas.map((alpha) => [alpha, new Map<number, number>()]))
  const forestPredictions = new Map<number, number>()
  const foldByRow = new Map<number, number>()

  folds.forEach((testIndexes, foldIndex) => {
    const testSet = new Set(testIndexes)
    const trainIndexes = validIndexes.filter((index) => !testSet.has(index))
    const preprocessor = fittedPreprocessor(rawAll, trainIndexes, featureKeys)
    const trainMatrix = transformRows(rawAll, trainIndexes, preprocessor)
    const testMatrix = transformRows(rawAll, testIndexes, preprocessor)
    const trainTarget = trainIndexes.map((index) => target.values[index])
    ridgeAlphas.forEach((alpha) => {
      const model = fitRidge(trainMatrix, trainTarget, alpha)
      predictRidge(model, testMatrix).forEach((value, index) => {
        ridgePredictions.get(alpha)?.set(testIndexes[index], value)
      })
    })
    const forest = fitForest(trainMatrix, trainTarget, 42)
    forest.predict(testMatrix).forEach((value, index) => forestPredictions.set(testIndexes[index], value))
    testIndexes.forEach((rowIndex) => foldByRow.set(rowIndex, foldIndex))
  })

  const ridgeMetrics = ridgeAlphas.map((alpha) => {
    const predictions = validIndexes.map((index) => ridgePredictions.get(alpha)?.get(index) ?? Number.NaN)
    return { alpha, predictions, metrics: metrics(observed, predictions) }
  })
  const bestRidge = ridgeMetrics.reduce((best, candidate) =>
    candidate.metrics.rmse < best.metrics.rmse ? candidate : best,
  )
  const forestOof = validIndexes.map((index) => forestPredictions.get(index) ?? Number.NaN)
  const forestMetrics = metrics(observed, forestOof)
  const selectedModel = forestMetrics.rmse < bestRidge.metrics.rmse ? 'random-forest' : 'ridge'
  const selectedOof = selectedModel === 'random-forest' ? forestOof : bestRidge.predictions

  onFinalTraining?.()
  const finalPreprocessor = fittedPreprocessor(rawAll, validIndexes, featureKeys)
  const finalMatrix = transformRows(rawAll, validIndexes, finalPreprocessor)
  const rawWhatIf = [featureKeys.map((key) => whatIf[key])]
  const whatIfMatrix = transformRows(rawWhatIf, [0], finalPreprocessor)
  let prediction: number
  let expandedImportance: readonly number[]
  let importanceMethod: string
  if (selectedModel === 'ridge') {
    const model = fitRidge(finalMatrix, observed, bestRidge.alpha)
    prediction = predictRidge(model, whatIfMatrix)[0]
    expandedImportance = model.coefficients.map(Math.abs)
    importanceMethod = '표준화 Ridge coefficient 절댓값'
  } else {
    const model = fitForest(finalMatrix, observed, 42)
    prediction = model.predict(whatIfMatrix)[0]
    expandedImportance = (model as RandomForestRegression & { featureImportance(): number[] })
      .featureImportance()
      .map((value: number) => (Number.isFinite(value) ? value : 0))
    importanceMethod = 'Random Forest impurity importance'
  }
  const importanceByFeature = featureKeys.map(() => 0)
  expandedImportance.forEach((value, index) => {
    const featureIndex = finalPreprocessor.expandedFeatureIndexes[index]
    importanceByFeature[featureIndex] += value
  })
  const importanceTotal = importanceByFeature.reduce((sum, value) => sum + value, 0) || 1
  const importances = featureKeys
    .map((key, index) => ({ key, value: importanceByFeature[index] / importanceTotal }))
    .sort((left, right) => right.value - left.value)

  const residuals = observed.map((value, index) => value - selectedOof[index])
  const absoluteResiduals = residuals.map(Math.abs).sort((left, right) => left - right)
  const radius = quantileSorted(absoluteResiduals, 0.9)
  const extrapolatedFeatureKeys = featureKeys.filter((key) => {
    const descriptor = dataset.columns.get(key)?.descriptor
    const value = whatIf[key]
    return (
      !Number.isFinite(value) ||
      (descriptor?.min !== undefined && value < descriptor.min) ||
      (descriptor?.max !== undefined && value > descriptor.max)
    )
  })

  const result: AnalysisPredictionResult = {
    fingerprint: dataset.profile.fingerprint,
    targetKey,
    featureKeys,
    selectedModel,
    ridgeAlpha: bestRidge.alpha,
    metrics: { ridge: bestRidge.metrics, randomForest: forestMetrics },
    importanceMethod,
    importances,
    rows: validIndexes.map((rowIndex, index) => ({
      ...dataset.rows[rowIndex],
      observed: observed[index],
      predicted: selectedOof[index],
      residual: residuals[index],
      fold: foldByRow.get(rowIndex) ?? 0,
    })),
    prediction,
    interval: [prediction - radius, prediction + radius],
    extrapolatedFeatureKeys,
  }
  dataset.lastPrediction = result
  return result
}

export function getTablePage(
  dataset: AnalysisDataset,
  columnKeys: readonly string[],
  offset: number,
  limit: number,
): AnalysisTablePage {
  const columns = requireColumns(dataset, columnKeys)
  const boundedOffset = Math.max(0, Math.min(dataset.rows.length, Math.floor(offset)))
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  return {
    fingerprint: dataset.profile.fingerprint,
    offset: boundedOffset,
    total: dataset.rows.length,
    columns: columnKeys,
    rows: dataset.rows.slice(boundedOffset, boundedOffset + boundedLimit).map((row, pageIndex) => {
      const rowIndex = boundedOffset + pageIndex
      return {
        ...row,
        values: columns.map((column) => (Number.isFinite(column.values[rowIndex]) ? column.values[rowIndex] : null)),
      }
    }),
  }
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function createCsv(dataset: AnalysisDataset, kind: 'dataset' | 'prediction', columnKeys: readonly string[]) {
  const lines: string[] = []
  if (kind === 'prediction') {
    const prediction = dataset.lastPrediction
    if (!prediction) throw new Error('먼저 Prediction을 실행하세요.')
    lines.push(
      [
        'measurement_id',
        'sample_id',
        'setup_id',
        'observed',
        'predicted',
        'residual',
        'fold',
        'cluster',
        'anomaly_score',
      ].join(','),
    )
    const miningByMeasurement = new Map((dataset.lastMining?.points ?? []).map((point) => [point.measurementId, point]))
    prediction.rows.forEach((row) => {
      const mining = miningByMeasurement.get(row.measurementId)
      lines.push(
        [
          row.measurementId,
          row.sampleId,
          row.setupId,
          row.observed,
          row.predicted,
          row.residual,
          row.fold,
          mining?.cluster,
          mining?.anomalyScore,
        ]
          .map(csvCell)
          .join(','),
      )
    })
  } else {
    const columns = requireColumns(dataset, columnKeys)
    lines.push(['measurement_id', 'sample_id', 'setup_id', ...columnKeys].map(csvCell).join(','))
    dataset.rows.forEach((row, rowIndex) => {
      lines.push(
        [
          row.measurementId,
          row.sampleId,
          row.setupId,
          ...columns.map((column) => (Number.isFinite(column.values[rowIndex]) ? column.values[rowIndex] : null)),
        ]
          .map(csvCell)
          .join(','),
      )
    })
  }
  return new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' })
}
