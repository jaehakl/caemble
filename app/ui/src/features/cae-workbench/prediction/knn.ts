export const PREDICTION_PERSISTENT_ARRAY_LIMIT_BYTES = 192 * 1024 * 1024
export const PREDICTION_WORKING_SET_LIMIT_BYTES = 256 * 1024 * 1024
export const PREDICTION_NUMERIC_CELL_LIMIT = 10_000_000

export const predictionNumericDtypes = [
  'float16',
  'float32',
  'float64',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
] as const

export type PredictionNumericDtype = (typeof predictionNumericDtypes)[number]
export type PredictionDirection = 'forward' | 'inverse'
export type PredictionWeighting = 'uniform' | 'distance'
export type PredictionInputScaling = 'range' | 'standard-deviation'

export type PredictionAxis = Readonly<{
  name: string
  ticks: readonly (number | string)[]
  unit?: string
}>

export type PredictionTensorLayout = Readonly<{
  key: string
  dtype: PredictionNumericDtype
  shape: readonly number[]
  axes?: readonly PredictionAxis[]
  dataSchemaSignature?: string
  tensorOrder?: number
  unit?: string
  quantityKind?: string
  minimum?: number
  maximum?: number
}>

export type PredictionTensorSample = Readonly<{
  layout: PredictionTensorLayout
  values: readonly number[]
}>

export type PredictionTrainingRow = Readonly<{
  measurementId: number
  inputs: readonly PredictionTensorSample[]
  outputs: readonly PredictionTensorSample[]
}>

export type PredictionCohortExclusionReason =
  'missing-block' | 'extra-block' | 'invalid-tensor' | 'fixed-layout-mismatch' | 'layout-mismatch'

export type PredictionCohortSummary = Readonly<{
  totalRows: number
  includedRows: number
  includedMeasurementIds: readonly number[]
  canonicalLayoutSignature: string
  excluded: Readonly<Record<PredictionCohortExclusionReason, number>>
}>

export type PredictionCohortOptions = Readonly<{
  direction: PredictionDirection
  fingerprint: string
  k?: number
  weighting?: PredictionWeighting
  inputScaling?: PredictionInputScaling
  inputBlockWeights?: Readonly<Record<string, number>>
  inputKeys: readonly string[]
  outputKeys: readonly string[]
  rows: readonly PredictionTrainingRow[]
  fixedInputLayouts?: readonly PredictionTensorLayout[]
  fixedOutputLayouts?: readonly PredictionTensorLayout[]
  persistentArrayLimitBytes?: number
  workingSetLimitBytes?: number
}>

export type PredictionCohort = Readonly<{
  rows: readonly PredictionTrainingRow[]
  inputLayouts: readonly PredictionTensorLayout[]
  outputLayouts: readonly PredictionTensorLayout[]
  summary: PredictionCohortSummary
}>

export type PredictionMemoryEstimate = Readonly<{
  persistentBytes: number
  workingSetBytes: number
}>

export type PredictionKnnModel = Readonly<{
  direction: PredictionDirection
  fingerprint: string
  k: number
  weighting: PredictionWeighting
  inputScaling: PredictionInputScaling
  inputBlockWeights: Readonly<Record<string, number>>
  rowCount: number
  inputSize: number
  outputSize: number
  inputLayouts: readonly PredictionTensorLayout[]
  outputLayouts: readonly PredictionTensorLayout[]
  inputOffsets: readonly number[]
  outputOffsets: readonly number[]
  input: Float64Array
  output: Float64Array
  inputMinimums: Float64Array
  inputMaximums: Float64Array
  inputScales: Float64Array
  inputBlockActiveCounts: readonly number[]
  activeInputBlockCount: number
  activeInputWeightScale: number
  activeInputWeightSum: number
  measurementIds: Float64Array
  memory: PredictionMemoryEstimate
  cohort: PredictionCohortSummary
}>

export type PredictionNeighbor = Readonly<{
  measurementId: number
  distanceSquared: number
  weight: number
}>

export type PredictionResult = Readonly<{
  direction: PredictionDirection
  fingerprint: string
  output: readonly PredictionTensorSample[]
  neighbors: readonly PredictionNeighbor[]
  extrapolatedInputKeys: readonly string[]
  constantInputKeysChanged: readonly string[]
}>

const numericDtypeSet = new Set<string>(predictionNumericDtypes)
const integerRanges: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  int8: [-128, 127],
  int16: [-32_768, 32_767],
  int32: [-2_147_483_648, 2_147_483_647],
  int64: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  uint8: [0, 255],
  uint16: [0, 65_535],
  uint32: [0, 4_294_967_295],
  uint64: [0, Number.MAX_SAFE_INTEGER],
})

export class PredictionModelError extends Error {
  readonly code: 'invalid-data' | 'insufficient-cohort' | 'memory-limit' | 'stale-model'

  constructor(code: PredictionModelError['code'], message: string) {
    super(message)
    this.name = 'PredictionModelError'
    this.code = code
  }
}

function tensorElementCount(shape: readonly number[]) {
  return shape.reduce((size, length) => {
    if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(size * length)) {
      throw new PredictionModelError('invalid-data', 'Prediction tensor shape is invalid or too large.')
    }
    return size * length
  }, 1)
}

function validateLayout(layout: PredictionTensorLayout) {
  if (!layout.key.trim() || !numericDtypeSet.has(layout.dtype)) {
    throw new PredictionModelError('invalid-data', 'Prediction tensor key or dtype is invalid.')
  }
  tensorElementCount(layout.shape)
  const tensorOrder = layout.tensorOrder ?? 0
  if (!Number.isSafeInteger(tensorOrder) || tensorOrder < 0 || tensorOrder > layout.shape.length) {
    throw new PredictionModelError('invalid-data', `Prediction tensor ${layout.key} has an invalid tensorOrder.`)
  }
  if ((layout.minimum === undefined) !== (layout.maximum === undefined)) {
    throw new PredictionModelError('invalid-data', `Prediction tensor ${layout.key} requires both bounds.`)
  }
  if (
    layout.minimum !== undefined &&
    (!Number.isFinite(layout.minimum) || !Number.isFinite(layout.maximum) || layout.minimum > layout.maximum!)
  ) {
    throw new PredictionModelError('invalid-data', `Prediction tensor ${layout.key} has invalid bounds.`)
  }
  const externalShape = layout.shape.slice(0, layout.shape.length - tensorOrder)
  if (layout.axes !== undefined && layout.axes.length !== externalShape.length) {
    throw new PredictionModelError('invalid-data', `Prediction tensor ${layout.key} axes do not match its shape.`)
  }
  layout.axes?.forEach((axis, index) => {
    if (
      !axis.name.trim() ||
      axis.ticks.length !== externalShape[index] ||
      axis.ticks.some((tick) => typeof tick !== 'string' && !Number.isFinite(tick)) ||
      (axis.unit !== undefined && !axis.unit.trim())
    ) {
      throw new PredictionModelError('invalid-data', `Prediction tensor ${layout.key} axis ${index} is invalid.`)
    }
  })
  if (
    (layout.unit !== undefined && !layout.unit.trim()) ||
    (layout.quantityKind !== undefined && !layout.quantityKind.trim()) ||
    (layout.dataSchemaSignature !== undefined && !layout.dataSchemaSignature.trim())
  ) {
    throw new PredictionModelError('invalid-data', `Prediction tensor ${layout.key} metadata is invalid.`)
  }
}

export function predictionLayoutSignature(layout: PredictionTensorLayout) {
  validateLayout(layout)
  return JSON.stringify({
    key: layout.key,
    dtype: layout.dtype,
    shape: [...layout.shape],
    axes: layout.axes?.map((axis) => ({
      name: axis.name,
      ticks: [...axis.ticks],
      ...(axis.unit === undefined ? {} : { unit: axis.unit }),
    })),
    ...(layout.dataSchemaSignature === undefined ? {} : { dataSchemaSignature: layout.dataSchemaSignature }),
    tensorOrder: layout.tensorOrder ?? 0,
    ...(layout.unit === undefined ? {} : { unit: layout.unit }),
    ...(layout.quantityKind === undefined ? {} : { quantityKind: layout.quantityKind }),
    ...(layout.minimum === undefined ? {} : { minimum: layout.minimum, maximum: layout.maximum }),
  })
}

function validateSample(sample: PredictionTensorSample) {
  validateLayout(sample.layout)
  if (sample.values.length !== tensorElementCount(sample.layout.shape)) {
    throw new PredictionModelError('invalid-data', `Prediction tensor ${sample.layout.key} does not match its shape.`)
  }
  const range = integerRanges[sample.layout.dtype]
  sample.values.forEach((value) => {
    if (
      !Number.isFinite(value) ||
      (range !== undefined && (!Number.isSafeInteger(value) || value < range[0] || value > range[1])) ||
      (sample.layout.dtype === 'float16' && !Number.isFinite(float16Number(value))) ||
      (sample.layout.dtype === 'float32' && !Number.isFinite(Math.fround(value))) ||
      (sample.layout.minimum !== undefined && (value < sample.layout.minimum || value > sample.layout.maximum!))
    ) {
      throw new PredictionModelError(
        'invalid-data',
        `Prediction tensor ${sample.layout.key} contains an invalid value.`,
      )
    }
  })
}

function uniqueKeys(keys: readonly string[], label: string) {
  const result = [...keys]
  if (result.some((key) => !key.trim()) || new Set(result).size !== result.length) {
    throw new PredictionModelError('invalid-data', `${label} keys must be non-empty and unique.`)
  }
  return result
}

function fixedLayoutMap(layouts: readonly PredictionTensorLayout[] | undefined, expectedKeys: readonly string[]) {
  if (layouts === undefined) return null
  const map = new Map(layouts.map((layout) => [layout.key, layout] as const))
  if (map.size !== layouts.length || map.size !== expectedKeys.length || expectedKeys.some((key) => !map.has(key))) {
    throw new PredictionModelError('invalid-data', 'Fixed Prediction layouts do not match their keys.')
  }
  layouts.forEach(validateLayout)
  return map
}

function orderedSamples(
  samples: readonly PredictionTensorSample[],
  keys: readonly string[],
  fixed: ReadonlyMap<string, PredictionTensorLayout> | null,
) {
  const map = new Map(samples.map((sample) => [sample.layout.key, sample] as const))
  if (map.size !== samples.length)
    throw new PredictionModelError('invalid-data', 'Prediction row contains duplicate blocks.')
  if (keys.some((key) => !map.has(key))) return { reason: 'missing-block' as const }
  if (samples.some((sample) => !keys.includes(sample.layout.key))) return { reason: 'extra-block' as const }
  const ordered = keys.map((key) => map.get(key)!)
  try {
    ordered.forEach(validateSample)
  } catch {
    return { reason: 'invalid-tensor' as const }
  }
  if (
    fixed &&
    ordered.some(
      (sample) => predictionLayoutSignature(sample.layout) !== predictionLayoutSignature(fixed.get(sample.layout.key)!),
    )
  ) {
    return { reason: 'fixed-layout-mismatch' as const }
  }
  return { samples: ordered }
}

export function selectPredictionCohort(options: PredictionCohortOptions): PredictionCohort {
  if (!options.fingerprint.trim()) throw new PredictionModelError('invalid-data', 'Prediction fingerprint is required.')
  const inputKeys = uniqueKeys(options.inputKeys, 'Input')
  const outputKeys = uniqueKeys(options.outputKeys, 'Output')
  if (inputKeys.length === 0 || outputKeys.length === 0) {
    throw new PredictionModelError('invalid-data', 'Prediction requires input and output blocks.')
  }
  const fixedInputs = fixedLayoutMap(options.fixedInputLayouts, inputKeys)
  const fixedOutputs = fixedLayoutMap(options.fixedOutputLayouts, outputKeys)
  const excluded: Record<PredictionCohortExclusionReason, number> = {
    'missing-block': 0,
    'extra-block': 0,
    'invalid-tensor': 0,
    'fixed-layout-mismatch': 0,
    'layout-mismatch': 0,
  }
  const ids = new Set<number>()
  const groups = new Map<string, PredictionTrainingRow[]>()
  options.rows.forEach((row) => {
    if (!Number.isSafeInteger(row.measurementId) || row.measurementId < 1 || ids.has(row.measurementId)) {
      throw new PredictionModelError('invalid-data', 'Prediction rows require unique positive Measurement IDs.')
    }
    ids.add(row.measurementId)
    const inputs = orderedSamples(row.inputs, inputKeys, fixedInputs)
    if ('reason' in inputs && inputs.reason !== undefined) {
      excluded[inputs.reason] += 1
      return
    }
    const outputs = orderedSamples(row.outputs, outputKeys, fixedOutputs)
    if ('reason' in outputs && outputs.reason !== undefined) {
      excluded[outputs.reason] += 1
      return
    }
    const normalized = { ...row, inputs: Object.freeze(inputs.samples), outputs: Object.freeze(outputs.samples) }
    const signature = JSON.stringify([
      ...inputs.samples.map((sample) => predictionLayoutSignature(sample.layout)),
      ...outputs.samples.map((sample) => predictionLayoutSignature(sample.layout)),
    ])
    const group = groups.get(signature) ?? []
    group.push(normalized)
    groups.set(signature, group)
  })
  const selected = [...groups.entries()].sort(
    ([leftSignature, left], [rightSignature, right]) =>
      right.length - left.length || (leftSignature < rightSignature ? -1 : leftSignature > rightSignature ? 1 : 0),
  )[0]
  if (!selected) {
    throw new PredictionModelError('insufficient-cohort', 'No complete Prediction cohort is available.')
  }
  const [canonicalLayoutSignature, selectedRows] = selected
  groups.forEach((rows, signature) => {
    if (signature !== canonicalLayoutSignature) excluded['layout-mismatch'] += rows.length
  })
  selectedRows.sort((left, right) => left.measurementId - right.measurementId)
  const summary: PredictionCohortSummary = Object.freeze({
    totalRows: options.rows.length,
    includedRows: selectedRows.length,
    includedMeasurementIds: Object.freeze(selectedRows.map((row) => row.measurementId)),
    canonicalLayoutSignature,
    excluded: Object.freeze(excluded),
  })
  return Object.freeze({
    rows: Object.freeze(selectedRows),
    inputLayouts: Object.freeze(selectedRows[0].inputs.map((sample) => sample.layout)),
    outputLayouts: Object.freeze(selectedRows[0].outputs.map((sample) => sample.layout)),
    summary,
  })
}

function blockOffsets(layouts: readonly PredictionTensorLayout[]) {
  const offsets = [0]
  layouts.forEach((layout) => offsets.push(offsets[offsets.length - 1] + tensorElementCount(layout.shape)))
  return offsets
}

export function estimatePredictionMemory(
  rowCount: number,
  inputSize: number,
  outputSize: number,
): PredictionMemoryEstimate {
  if (![rowCount, inputSize, outputSize].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new PredictionModelError('invalid-data', 'Prediction model dimensions are invalid.')
  }
  const cellsPerRow = inputSize + outputSize
  const trainingCells = rowCount * cellsPerRow
  if (!Number.isSafeInteger(cellsPerRow) || !Number.isSafeInteger(trainingCells)) {
    throw new PredictionModelError('memory-limit', 'Prediction training cell count exceeds safe numeric accounting.')
  }
  if (trainingCells > PREDICTION_NUMERIC_CELL_LIMIT) {
    throw new PredictionModelError(
      'memory-limit',
      `Prediction training data contains ${trainingCells.toLocaleString()} numeric cells; the limit is ${PREDICTION_NUMERIC_CELL_LIMIT.toLocaleString()}.`,
    )
  }
  const persistentValues = trainingCells + 3 * inputSize + rowCount
  const workingValues = persistentValues + inputSize + 2 * outputSize + 4 * rowCount
  const persistentBytes = persistentValues * 8
  const workingSetBytes = workingValues * 8
  if (
    !Number.isSafeInteger(persistentValues) ||
    !Number.isSafeInteger(workingValues) ||
    !Number.isSafeInteger(persistentBytes) ||
    !Number.isSafeInteger(workingSetBytes)
  ) {
    throw new PredictionModelError('memory-limit', 'Prediction model dimensions exceed safe memory accounting.')
  }
  return Object.freeze({ persistentBytes, workingSetBytes })
}

function stablePopulationStandardDeviation(values: Float64Array, offset: number, stride: number, count: number) {
  let maximum = 0
  for (let row = 0; row < count; row += 1) maximum = Math.max(maximum, Math.abs(values[row * stride + offset]))
  if (maximum === 0) return 0
  let mean = 0
  for (let row = 0; row < count; row += 1) mean += values[row * stride + offset] / maximum
  mean /= count
  let variance = 0
  for (let row = 0; row < count; row += 1) {
    const delta = values[row * stride + offset] / maximum - mean
    variance += delta * delta
  }
  const standardDeviation = maximum * Math.sqrt(variance / count)
  if (!Number.isFinite(standardDeviation)) {
    throw new PredictionModelError('invalid-data', 'Prediction standardization overflowed.')
  }
  return standardDeviation
}

export function buildPredictionKnnModel(options: PredictionCohortOptions): PredictionKnnModel {
  const cohort = selectPredictionCohort(options)
  if (options.weighting !== undefined && options.weighting !== 'uniform' && options.weighting !== 'distance') {
    throw new PredictionModelError('invalid-data', 'Prediction weighting is invalid.')
  }
  if (
    options.inputScaling !== undefined &&
    options.inputScaling !== 'range' &&
    options.inputScaling !== 'standard-deviation'
  ) {
    throw new PredictionModelError('invalid-data', 'Prediction input scaling is invalid.')
  }
  const inputOffsets = blockOffsets(cohort.inputLayouts)
  const outputOffsets = blockOffsets(cohort.outputLayouts)
  const inputSize = inputOffsets[inputOffsets.length - 1]
  const outputSize = outputOffsets[outputOffsets.length - 1]
  if (inputSize === 0 || outputSize === 0) {
    throw new PredictionModelError('invalid-data', 'Prediction input and output vectors must not be empty.')
  }
  const memory = estimatePredictionMemory(cohort.rows.length, inputSize, outputSize)
  const requestedPersistentLimit = options.persistentArrayLimitBytes ?? PREDICTION_PERSISTENT_ARRAY_LIMIT_BYTES
  const requestedWorkingLimit = options.workingSetLimitBytes ?? PREDICTION_WORKING_SET_LIMIT_BYTES
  if (!Number.isFinite(requestedPersistentLimit) || !Number.isFinite(requestedWorkingLimit)) {
    throw new PredictionModelError('memory-limit', 'Prediction memory limits must be finite.')
  }
  const persistentLimit = Math.min(requestedPersistentLimit, PREDICTION_PERSISTENT_ARRAY_LIMIT_BYTES)
  const workingLimit = Math.min(requestedWorkingLimit, PREDICTION_WORKING_SET_LIMIT_BYTES)
  if (
    persistentLimit <= 0 ||
    workingLimit <= 0 ||
    memory.persistentBytes > persistentLimit ||
    memory.workingSetBytes > workingLimit
  ) {
    throw new PredictionModelError(
      'memory-limit',
      `Prediction requires ${memory.persistentBytes.toLocaleString()} persistent bytes and ${memory.workingSetBytes.toLocaleString()} working bytes.`,
    )
  }

  const input = new Float64Array(cohort.rows.length * inputSize)
  const output = new Float64Array(cohort.rows.length * outputSize)
  const measurementIds = new Float64Array(cohort.rows.length)
  cohort.rows.forEach((row, rowIndex) => {
    measurementIds[rowIndex] = row.measurementId
    let inputIndex = rowIndex * inputSize
    row.inputs.forEach((sample) => {
      input.set(sample.values, inputIndex)
      inputIndex += sample.values.length
    })
    let outputIndex = rowIndex * outputSize
    row.outputs.forEach((sample) => {
      output.set(sample.values, outputIndex)
      outputIndex += sample.values.length
    })
  })

  const inputMinimums = new Float64Array(inputSize)
  const inputMaximums = new Float64Array(inputSize)
  const inputScales = new Float64Array(inputSize)
  for (let column = 0; column < inputSize; column += 1) {
    let minimum = Number.POSITIVE_INFINITY
    let maximum = Number.NEGATIVE_INFINITY
    for (let row = 0; row < cohort.rows.length; row += 1) {
      const value = input[row * inputSize + column]
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }
    inputMinimums[column] = minimum
    inputMaximums[column] = maximum
    inputScales[column] = stablePopulationStandardDeviation(input, column, inputSize, cohort.rows.length)
  }
  const inputScaling = options.inputScaling ?? 'standard-deviation'
  if (inputScaling === 'range') {
    cohort.inputLayouts.forEach((layout, block) => {
      if (layout.minimum === undefined || layout.maximum === undefined) {
        throw new PredictionModelError(
          'invalid-data',
          `Range scaling requires bounds for Prediction input ${layout.key}.`,
        )
      }
      const rawScale = layout.maximum - layout.minimum
      const magnitude = Math.max(Math.abs(layout.minimum), Math.abs(layout.maximum))
      const scale = Number.isFinite(rawScale) ? rawScale : layout.maximum / magnitude - layout.minimum / magnitude
      if (!Number.isFinite(scale) || scale < 0) {
        throw new PredictionModelError(
          'invalid-data',
          `Range scaling for Prediction input ${layout.key} is not numerically stable.`,
        )
      }
      for (let column = inputOffsets[block]; column < inputOffsets[block + 1]; column += 1) {
        inputScales[column] = scale
      }
    })
  }
  const inputBlockActiveCounts = cohort.inputLayouts.map((_layout, block) => {
    let count = 0
    for (let column = inputOffsets[block]; column < inputOffsets[block + 1]; column += 1) {
      if (inputScales[column] > 0) count += 1
    }
    return count
  })
  const inputKeySet = new Set(cohort.inputLayouts.map((layout) => layout.key))
  if (Object.keys(options.inputBlockWeights ?? {}).some((key) => !inputKeySet.has(key))) {
    throw new PredictionModelError('invalid-data', 'Prediction input block weights contain an unknown key.')
  }
  const inputBlockWeights = Object.freeze(
    Object.fromEntries(
      cohort.inputLayouts.map((layout) => {
        const weight = options.inputBlockWeights?.[layout.key] ?? 1
        if (!Number.isFinite(weight) || weight < 0) {
          throw new PredictionModelError('invalid-data', `Prediction input block ${layout.key} has an invalid weight.`)
        }
        return [layout.key, weight]
      }),
    ),
  )
  if (
    !cohort.inputLayouts.some(
      (layout, block) => inputOffsets[block + 1] > inputOffsets[block] && inputBlockWeights[layout.key] > 0,
    )
  ) {
    throw new PredictionModelError('invalid-data', 'Prediction requires at least one positive input block weight.')
  }
  const activeInputWeightScale = cohort.inputLayouts.reduce(
    (maximum, layout, block) =>
      inputBlockActiveCounts[block] > 0 ? Math.max(maximum, inputBlockWeights[layout.key]) : maximum,
    0,
  )
  const activeInputWeightSum = cohort.inputLayouts.reduce(
    (sum, layout, block) =>
      sum +
      (inputBlockActiveCounts[block] > 0 && activeInputWeightScale > 0
        ? inputBlockWeights[layout.key] / activeInputWeightScale
        : 0),
    0,
  )
  const activeInputBlockCount = cohort.inputLayouts.filter(
    (layout, block) => inputBlockActiveCounts[block] > 0 && inputBlockWeights[layout.key] > 0,
  ).length
  const k = options.k ?? Math.min(15, Math.max(1, Math.round(Math.sqrt(cohort.rows.length))))
  if (!Number.isSafeInteger(k) || k < 1 || k > cohort.rows.length) {
    throw new PredictionModelError('invalid-data', `Prediction k must be an integer from 1 to ${cohort.rows.length}.`)
  }

  return Object.freeze({
    direction: options.direction,
    fingerprint: options.fingerprint,
    k,
    weighting: options.weighting ?? 'distance',
    inputScaling,
    inputBlockWeights,
    rowCount: cohort.rows.length,
    inputSize,
    outputSize,
    inputLayouts: cohort.inputLayouts,
    outputLayouts: cohort.outputLayouts,
    inputOffsets: Object.freeze(inputOffsets),
    outputOffsets: Object.freeze(outputOffsets),
    input,
    output,
    inputMinimums,
    inputMaximums,
    inputScales,
    inputBlockActiveCounts: Object.freeze(inputBlockActiveCounts),
    activeInputBlockCount,
    activeInputWeightScale,
    activeInputWeightSum,
    measurementIds,
    memory,
    cohort: cohort.summary,
  })
}

function flattenQuery(model: PredictionKnnModel, samples: readonly PredictionTensorSample[]) {
  const expectedKeys = model.inputLayouts.map((layout) => layout.key)
  const ordered = orderedSamples(
    samples,
    expectedKeys,
    new Map(model.inputLayouts.map((layout) => [layout.key, layout])),
  )
  if ('reason' in ordered)
    throw new PredictionModelError('invalid-data', `Prediction query is invalid: ${ordered.reason}.`)
  const query = new Float64Array(model.inputSize)
  let offset = 0
  ordered.samples.forEach((sample) => {
    query.set(sample.values, offset)
    offset += sample.values.length
  })
  return query
}

function float16Number(value: number) {
  if (!Number.isFinite(value) || value === 0) return value
  const sign = value < 0 ? -1 : 1
  const absolute = Math.abs(value)
  const exponent = absolute < 2 ** -14 ? -24 : Math.floor(Math.log2(absolute)) - 10
  const quantum = 2 ** exponent
  const scaled = absolute / quantum
  const lower = Math.floor(scaled)
  const remainder = scaled - lower
  const rounded = remainder > 0.5 || (remainder === 0.5 && lower % 2 !== 0) ? lower + 1 : lower
  const result = rounded * quantum
  return result > 65_504 ? sign * Number.POSITIVE_INFINITY : sign * result
}

function postprocessPrediction(value: number, layout: PredictionTensorLayout, direction: PredictionDirection) {
  let result = value
  if (direction === 'forward') {
    const range = integerRanges[layout.dtype]
    if (range) result = Math.min(range[1], Math.max(range[0], Math.round(result)))
    else if (layout.dtype === 'float32') result = Math.fround(result)
    else if (layout.dtype === 'float16') result = float16Number(result)
  }
  if (layout.minimum !== undefined) result = Math.min(layout.maximum!, Math.max(layout.minimum, result))
  if (!Number.isFinite(result))
    throw new PredictionModelError('invalid-data', `Prediction output ${layout.key} is not finite.`)
  return result
}

export function predictWithKnn(
  model: PredictionKnnModel,
  querySamples: readonly PredictionTensorSample[],
  fingerprint = model.fingerprint,
): PredictionResult {
  if (fingerprint !== model.fingerprint) throw new PredictionModelError('stale-model', 'Prediction model is stale.')
  const query = flattenQuery(model, querySamples)
  const distanceNorms = new Float64Array(model.rowCount)
  const extrapolated = new Set<string>()
  const constantChanged = new Set<string>()
  model.inputLayouts.forEach((layout, block) => {
    for (let column = model.inputOffsets[block]; column < model.inputOffsets[block + 1]; column += 1) {
      if (query[column] < model.inputMinimums[column] || query[column] > model.inputMaximums[column]) {
        extrapolated.add(layout.key)
      }
      if (model.inputScales[column] === 0 && query[column] !== model.inputMinimums[column]) {
        constantChanged.add(layout.key)
      }
    }
  })
  for (let row = 0; row < model.rowCount; row += 1) {
    let distanceScale = 0
    let scaledSquareSum = 0
    for (let block = 0; block < model.inputLayouts.length; block += 1) {
      const active = model.inputBlockActiveCounts[block]
      const blockWeight = model.inputBlockWeights[model.inputLayouts[block].key]
      if (active === 0 || blockWeight === 0) continue
      const componentWeight = Math.sqrt(
        blockWeight / model.activeInputWeightScale / active / model.activeInputWeightSum,
      )
      const rangeMagnitude =
        model.inputScaling === 'range' &&
        !Number.isFinite(model.inputLayouts[block].maximum! - model.inputLayouts[block].minimum!)
          ? Math.max(Math.abs(model.inputLayouts[block].minimum!), Math.abs(model.inputLayouts[block].maximum!))
          : 1
      for (let column = model.inputOffsets[block]; column < model.inputOffsets[block + 1]; column += 1) {
        const scale = model.inputScales[column]
        if (scale === 0) continue
        const normalized =
          (query[column] / rangeMagnitude - model.input[row * model.inputSize + column] / rangeMagnitude) / scale
        const component = Math.abs(normalized) * componentWeight
        if (component === 0) continue
        if (distanceScale < component) {
          const ratio = distanceScale / component
          scaledSquareSum = 1 + scaledSquareSum * ratio * ratio
          distanceScale = component
        } else {
          const ratio = component / distanceScale
          scaledSquareSum += ratio * ratio
        }
      }
    }
    distanceNorms[row] = distanceScale === 0 ? 0 : distanceScale * Math.sqrt(scaledSquareSum)
  }
  const indices = Array.from({ length: model.rowCount }, (_item, index) => index).sort((left, right) => {
    const leftDistance = distanceNorms[left]
    const rightDistance = distanceNorms[right]
    if (leftDistance < rightDistance) return -1
    if (leftDistance > rightDistance) return 1
    return model.measurementIds[left] - model.measurementIds[right]
  })
  if (!Number.isFinite(distanceNorms[indices[0]])) {
    throw new PredictionModelError('invalid-data', 'Prediction distance overflowed for every cohort row.')
  }
  const zeroDistance = indices.filter((index) => distanceNorms[index] === 0)
  const neighbors = zeroDistance.length > 0 ? zeroDistance : indices.slice(0, model.k)
  const ratios = new Float64Array(neighbors.length)
  if (zeroDistance.length > 0 || model.weighting === 'uniform') ratios.fill(1)
  else {
    neighbors.forEach((row, index) => {
      ratios[index] = 1 / Math.max(distanceNorms[row], 1e-12)
    })
  }
  const ratioSum = ratios.reduce((sum, value) => sum + value, 0)
  const weights = ratios.map((value) => value / ratioSum)
  const predicted = new Float64Array(model.outputSize)
  for (let column = 0; column < model.outputSize; column += 1) {
    let maximum = 0
    neighbors.forEach((row) => {
      maximum = Math.max(maximum, Math.abs(model.output[row * model.outputSize + column]))
    })
    if (maximum === 0) continue
    let scaled = 0
    neighbors.forEach((row, index) => {
      scaled += weights[index] * (model.output[row * model.outputSize + column] / maximum)
    })
    predicted[column] = scaled * maximum
  }
  const output = model.outputLayouts.map((layout, block) =>
    Object.freeze({
      layout,
      values: Object.freeze(
        Array.from(predicted.slice(model.outputOffsets[block], model.outputOffsets[block + 1]), (value) =>
          postprocessPrediction(value, layout, model.direction),
        ),
      ),
    }),
  )
  return Object.freeze({
    direction: model.direction,
    fingerprint: model.fingerprint,
    output: Object.freeze(output),
    neighbors: Object.freeze(
      neighbors.map((row, index) =>
        Object.freeze({
          measurementId: model.measurementIds[row],
          distanceSquared: distanceNorms[row] * distanceNorms[row],
          weight: weights[index],
        }),
      ),
    ),
    extrapolatedInputKeys: Object.freeze([...extrapolated].sort()),
    constantInputKeysChanged: Object.freeze([...constantChanged].sort()),
  })
}

export function predictionModelIsStale(model: PredictionKnnModel, fingerprint: string) {
  return model.fingerprint !== fingerprint
}
