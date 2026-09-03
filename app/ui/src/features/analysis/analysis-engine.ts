import { kmeans } from 'ml-kmeans'
import { Matrix } from 'ml-matrix'
import { PCA } from 'ml-pca'
import { mean, quantileSorted, sampleCorrelation, sampleStandardDeviation, silhouette } from 'simple-statistics'
import type { CalculationDataAnalysisItem, MeasurementRecord } from '@/api'
import type {
  AnalysisColumnDescriptor,
  AnalysisMiningResult,
  AnalysisProfile,
  AnalysisRelationshipPlot,
  AnalysisRelationshipsResult,
  AnalysisTablePage,
} from './analysis-types'

type RowIdentity = Readonly<{
  measurementId: number
  inputFingerprint: string
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

function extractVars(value: unknown, prefix: string, source: 'measurement-vars', observations: NumericObservation[]) {
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
  prefix: string,
  source: 'measurement-material',
  observations: NumericObservation[],
) {
  if (!isRecord(value) || !isRecord(value.materials)) return
  Object.entries(value.materials).forEach(([materialName, rawParameters]) => {
    if (!isRecord(rawParameters)) return
    Object.entries(rawParameters).forEach(([parameterName, rawParameter]) => {
      if (!isRecord(rawParameter) || !isRecord(rawParameter.value)) return
      const parameterValue = rawParameter.value
      if (parameterValue.kind === 'sampled_relation' || typeof parameterValue.unit !== 'string') return
      const tensor = numericTensor(parameterValue.value)
      if (!tensor) return
      const root = `${prefix}.${materialName}.${parameterName}`
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
    'measurement-vars': 0,
    'measurement-material': 1,
    'calculation-data': 2,
  }[source]
}

function canonicalInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalInput)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalInput(value[key])]),
  )
}

function inputFingerprint(measurement: MeasurementRecord) {
  const source = JSON.stringify(
    canonicalInput({
      experimentId: measurement.experiment_id,
      vars: measurement.vars,
      materialParameters: measurement.material_parameters,
    }),
  )
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
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

export function buildAnalysisDataset({
  calculationData,
  experimentId,
  fingerprint,
  measurements,
}: {
  calculationData: readonly CalculationDataAnalysisItem[]
  experimentId: number
  fingerprint: string
  measurements: readonly MeasurementRecord[]
}): AnalysisDataset {
  const measurementIds = new Set(calculationData.map((row) => row.measurement_id))
  const usableMeasurements = measurements.filter(
    (row): row is MeasurementRecord & { id: number } =>
      Number.isSafeInteger(row.id) && (row.id ?? 0) > 0 && measurementIds.has(row.id as number),
  )
  const calculationDataByMeasurement = new Map<number, CalculationDataAnalysisItem[]>()
  calculationData.forEach((row) => {
    const rows = calculationDataByMeasurement.get(row.measurement_id) ?? []
    rows.push(row)
    calculationDataByMeasurement.set(row.measurement_id, rows)
  })

  const states = new Map<string, ColumnState>()
  const materialSignatures = new Map<string, Set<string>>()
  const targetSignatures = new Map<number, Set<string>>()
  const targetKeysByCalculation = new Map<number, Set<string>>()
  const identities: RowIdentity[] = []

  const observe = (observation: NumericObservation, rowIndex: number) => {
    let state = states.get(observation.key)
    if (!state) {
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
    identities.push({ measurementId: measurement.id, inputFingerprint: inputFingerprint(measurement) })
    states.forEach((state) => state.values.push(Number.NaN))

    const observations: NumericObservation[] = []
    extractVars(measurement.vars, 'measurement.vars', 'measurement-vars', observations)
    const materials = measurement.material_parameters
    if (isRecord(materials)) {
      extractMaterials(materials.experiment, 'measurement.material.experiment', 'measurement-material', observations)
      if (isRecord(materials.tasks)) {
        Object.entries(materials.tasks).forEach(([taskName, value]) => {
          extractMaterials(value, `measurement.material.tasks.${taskName}`, 'measurement-material', observations)
        })
      }
    }
    observations.forEach((observation) => observe(observation, rowIndex))

    const resultRows = calculationDataByMeasurement.get(measurement.id) ?? []
    resultRows.forEach((resultRow) => {
      const summary = resultRow.summary
      const rank = summary.kind === 'tensor' ? summary.rank : 0
      const signatures = targetSignatures.get(resultRow.calculation_id) ?? new Set<string>()
      signatures.add(`${resultRow.dtype}:${rank}`)
      targetSignatures.set(resultRow.calculation_id, signatures)
      const targets: readonly Readonly<{ key: string; statistic?: string; value: number }>[] =
        summary.kind === 'scalar'
          ? [{ key: `target:calculation:${resultRow.calculation_id}`, value: summary.value }]
          : (['mean', 'std'] as const).flatMap((statistic) => {
              const value = summary[statistic]
              return value === null
                ? []
                : [{ key: `target:calculation:${resultRow.calculation_id}:${statistic}`, statistic, value }]
            })
      const keys = targetKeysByCalculation.get(resultRow.calculation_id) ?? new Set<string>()
      targets.forEach((target) => {
        keys.add(target.key)
        let state = states.get(target.key)
        if (!state) {
          state = {
            key: target.key,
            label: `${resultRow.calculation_name}${target.statistic ? ` · ${target.statistic}` : ''}`,
            kind: 'target',
            source: 'calculation-data',
            values: Array(rowIndex + 1).fill(Number.NaN),
            ...(target.statistic ? { statistic: target.statistic } : {}),
          }
          states.set(target.key, state)
        } else {
          while (state.values.length <= rowIndex) state.values.push(Number.NaN)
          state.label = `${resultRow.calculation_name}${target.statistic ? ` · ${target.statistic}` : ''}`
        }
        state.values[rowIndex] = target.value
      })
      targetKeysByCalculation.set(resultRow.calculation_id, keys)
    })
  })

  materialSignatures.forEach((signatures, root) => {
    if (signatures.size <= 1) return
    states.forEach((state) => {
      if (state.root === root) state.invalidReason = 'Material shape 또는 unit이 행마다 다릅니다.'
    })
  })
  targetSignatures.forEach((signatures, calculationId) => {
    if (signatures.size <= 1) return
    targetKeysByCalculation.get(calculationId)?.forEach((key) => {
      const state = states.get(key)
      if (state) state.invalidReason = 'CalculationData dtype 또는 rank가 Measurement마다 다릅니다.'
    })
  })

  const columns = new Map<string, AnalysisColumn>()
  states.forEach((state) => {
    while (state.values.length < identities.length) state.values.push(Number.NaN)
    const values = Float64Array.from(state.values)
    const descriptor = describeColumn(state, values, identities.length)
    columns.set(state.key, { descriptor, values })
  })
  const descriptors = [...columns.values()]
    .map((column) => column.descriptor)
    .sort((left, right) => sourceOrder(left.source) - sourceOrder(right.source) || left.key.localeCompare(right.key))

  return {
    profile: {
      fingerprint,
      experimentId,
      rowCount: identities.length,
      measurementCount: identities.length,
      calculationDataCount: calculationData.length,
      calculationCount: new Set(calculationData.map((row) => row.calculation_id)).size,
      columns: descriptors,
      warnings: identities.length === 0 ? ['분석할 CalculationData가 없습니다.'] : [],
    },
    rows: identities,
    columns,
    lastMining: null,
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

function rawFeatureRows(dataset: AnalysisDataset, featureKeys: readonly string[]) {
  const columns = requireColumns(dataset, featureKeys, 'feature')
  return dataset.rows.map((_, rowIndex) => columns.map((column) => column.values[rowIndex]))
}

function pairedValues(left: Float64Array, right: Float64Array) {
  const first: number[] = []
  const second: number[] = []
  for (let index = 0; index < left.length; index += 1) {
    if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) continue
    first.push(left[index])
    second.push(right[index])
  }
  return { first, second }
}

function rankValues(values: readonly number[]) {
  const ranked = Array(values.length).fill(Number.NaN) as number[]
  const ordered = values
    .map((value, index) => ({ index, value }))
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

function relationshipStatistics(left: Float64Array, right: Float64Array) {
  const { first, second } = pairedValues(left, right)
  if (first.length < 3 || new Set(first).size <= 1 || new Set(second).size <= 1) {
    return { count: first.length, pearson: null, spearman: null }
  }
  const pearson = sampleCorrelation(first, second)
  const spearman = sampleCorrelation(rankValues(first), rankValues(second))
  return {
    count: first.length,
    pearson: Number.isFinite(pearson) ? pearson : null,
    spearman: Number.isFinite(spearman) ? spearman : null,
  }
}

export function analyzeRelationships(
  dataset: AnalysisDataset,
  onProgress?: (completed: number, total: number) => void,
): AnalysisRelationshipsResult {
  const inputs = [...dataset.columns.values()].filter(
    (column) =>
      column.descriptor.kind === 'feature' &&
      column.descriptor.source === 'measurement-vars' &&
      column.descriptor.eligible,
  )
  const targets = [...dataset.columns.values()].filter(
    (column) =>
      column.descriptor.kind === 'target' &&
      column.descriptor.source === 'calculation-data' &&
      column.descriptor.eligible,
  )
  const pairs: AnalysisRelationshipsResult['pairs'][number][] = []
  inputs.forEach((input, inputIndex) => {
    targets.forEach((target) => {
      const result = relationshipStatistics(input.values, target.values)
      if (result.pearson === null || result.spearman === null) return
      pairs.push({
        inputKey: input.descriptor.key,
        targetKey: target.descriptor.key,
        pearson: result.pearson,
        spearman: result.spearman,
        count: result.count,
      })
    })
    onProgress?.(inputIndex + 1, inputs.length)
  })
  pairs.sort(
    (left, right) =>
      Math.abs(right.pearson) - Math.abs(left.pearson) ||
      Math.abs(right.spearman) - Math.abs(left.spearman) ||
      left.inputKey.localeCompare(right.inputKey) ||
      left.targetKey.localeCompare(right.targetKey),
  )
  return { fingerprint: dataset.profile.fingerprint, pairs }
}

export function getRelationshipPlot(
  dataset: AnalysisDataset,
  inputKey: string,
  targetKey: string,
): AnalysisRelationshipPlot {
  const input = requireColumns(dataset, [inputKey], 'feature')[0]
  const target = requireColumns(dataset, [targetKey], 'target')[0]
  if (input.descriptor.source !== 'measurement-vars' || target.descriptor.source !== 'calculation-data') {
    throw new Error('관계 그래프는 input vars와 CalculationData 조합만 지원합니다.')
  }
  const result = relationshipStatistics(input.values, target.values)
  return {
    fingerprint: dataset.profile.fingerprint,
    inputKey,
    targetKey,
    pearson: result.pearson,
    spearman: result.spearman,
    count: result.count,
    points: dataset.rows.flatMap((row, index) =>
      Number.isFinite(input.values[index]) && Number.isFinite(target.values[index])
        ? [{ measurementId: row.measurementId, x: input.values[index], y: target.values[index] }]
        : [],
    ),
  }
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
  }: {
    featureKeys: readonly string[]
    outlierFraction: number
  },
): AnalysisMiningResult {
  if (dataset.rows.length < 3) throw new Error('Mining에는 Measurement가 3개 이상 필요합니다.')
  if (featureKeys.length < 2) throw new Error('Mining에는 feature가 2개 이상 필요합니다.')
  requireColumns(dataset, featureKeys, 'feature')
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

  const result: AnalysisMiningResult = {
    fingerprint: dataset.profile.fingerprint,
    featureKeys,
    explainedVariance: explainedVariance.slice(0, 2),
    loadings,
    points: dataset.rows.map((row, index) => ({
      ...row,
      pc1: projected[index]?.[0] ?? 0,
      pc2: projected[index]?.[1] ?? 0,
      cluster: clusters[index],
      anomalyScore: errors[index],
      outlier: outlierIndexes.has(index),
    })),
    clusterCount: bestK,
    silhouette: bestSilhouette,
    outlierFraction: boundedOutlierFraction,
  }
  dataset.lastMining = result
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

export function createCsv(dataset: AnalysisDataset, columnKeys: readonly string[]) {
  const lines: string[] = []
  const columns = requireColumns(dataset, columnKeys)
  lines.push(['measurement_id', 'input_fingerprint', ...columnKeys].map(csvCell).join(','))
  dataset.rows.forEach((row, rowIndex) => {
    lines.push(
      [
        row.measurementId,
        row.inputFingerprint,
        ...columns.map((column) => (Number.isFinite(column.values[rowIndex]) ? column.values[rowIndex] : null)),
      ]
        .map(csvCell)
        .join(','),
    )
  })
  return new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' })
}
