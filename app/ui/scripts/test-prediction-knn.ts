import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  CalculationDataOutput,
  CalculationDataRecord,
  MeasurementRecord,
  MeasurementRecordedData,
} from '../src/api'
import { createDataTensorAccessor, isDataTensor } from '../src/lib/cad/model/dataTensor'
import {
  buildPredictionKnnModel,
  estimatePredictionMemory,
  predictWithKnn,
  predictionModelIsStale,
  PredictionModelError,
  PREDICTION_NUMERIC_CELL_LIMIT,
  selectPredictionCohort,
  type PredictionTensorLayout,
  type PredictionTensorSample,
  type PredictionTrainingRow,
} from '../src/features/cae-workbench/prediction/knn'
import { predictionWorkerResponseIsCurrent } from '../src/features/cae-workbench/prediction/protocol'
import {
  calculationOutputFromSample,
  calculationOutputSample,
  calculationOutputTensor,
  calculationOutputWithTensor,
  inverseTrainingRows,
  predictedRecordedData,
  predictionFingerprint,
  predictionRecordedSamples,
  predictionRecordedSamplesMatchRules,
  predictionVarsLayouts,
  predictionVarsSamples,
} from '../src/features/cae-workbench/prediction/data'
import {
  comparePredictionOutput,
  inverseValidationAggregateError,
  inverseValidationAggregateErrorFromScales,
  predictionOutputRange,
} from '../src/features/cae-workbench/prediction/metrics'
import { TensorEditor } from '../src/features/cae-workbench/calculation/TensorEditor'
import { VarsPanel } from '../src/features/cae-workbench/calculation/VarsPanel'
import { fitTensorDisplayDomain } from '../src/features/cae-workbench/calculation/tensorDisplayDomain'
import { createRuntimeConsoleStore } from '../src/features/runtime-console/store'
import { PredictionWorkerClient, PredictionWorkerRestartError } from '../src/features/cae-workbench/prediction/client'
import {
  emitPredictionCohortDiagnostics,
  emitPredictionQueryDiagnostics,
  PREDICTION_CONSOLE_DIAGNOSTIC_LIMIT,
} from '../src/features/cae-workbench/prediction/diagnostics'
import { PredictionCalculationPane } from '../src/features/cae-workbench/prediction/PredictionPanels'
import type {
  PredictionWorkerRequest,
  PredictionWorkerResponse,
} from '../src/features/cae-workbench/prediction/protocol'

const scalar = (key: string, value: number, extra: Partial<PredictionTensorLayout> = {}): PredictionTensorSample => ({
  layout: { key, dtype: 'float64', shape: [], ...extra },
  values: [value],
})
const tensor = (
  key: string,
  values: readonly number[],
  shape: readonly number[] = [values.length],
): PredictionTensorSample => ({
  layout: { key, dtype: 'float64', shape, axes: [{ name: 'index', ticks: values.map((_value, index) => index) }] },
  values,
})
const row = (
  measurementId: number,
  inputs: readonly PredictionTensorSample[],
  outputs: readonly PredictionTensorSample[],
): PredictionTrainingRow => ({ measurementId, inputs, outputs })

const balancedRows = [
  row(1, [scalar('small', 0), tensor('large', [0, 0, 0, 0])], [scalar('result', 0, { minimum: 0, maximum: 10 })]),
  row(2, [scalar('small', 10), tensor('large', [10, 10, 10, 10])], [scalar('result', 10, { minimum: 0, maximum: 10 })]),
]

const originalWorker = globalThis.Worker
const fakeWorkers: FakeWorker[] = []
class FakeWorker {
  lastRequest: PredictionWorkerRequest | null = null
  onerror: ((event: Readonly<{ message: string }>) => void) | null = null
  onmessage: ((event: Readonly<{ data: PredictionWorkerResponse }>) => void) | null = null
  terminated = false

  constructor() {
    fakeWorkers.push(this)
  }

  postMessage(request: PredictionWorkerRequest) {
    this.lastRequest = request
  }

  terminate() {
    this.terminated = true
  }
}
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker, writable: true })
try {
  const workerClient = new PredictionWorkerClient()
  assert.equal(workerClient.epoch, 1)
  const crashedBuild = workerClient.build('forward', 1, 'worker-crash', {
    direction: 'forward',
    fingerprint: 'worker-crash',
    inputKeys: ['x'],
    outputKeys: ['y'],
    rows: [row(1, [scalar('x', 0)], [scalar('y', 0)])],
  })
  fakeWorkers[0].onerror?.({ message: 'synthetic crash' })
  await assert.rejects(crashedBuild, (error: unknown) => error instanceof PredictionWorkerRestartError)
  assert.equal(workerClient.epoch, 2)
  assert.equal(fakeWorkers[0].terminated, true)

  const stalePrediction = workerClient.predict('forward', 1, 'worker-crash', [scalar('x', 0)])
  const staleRequest = fakeWorkers[1].lastRequest!
  fakeWorkers[1].onmessage?.({
    data: {
      type: 'stale',
      requestId: staleRequest.requestId,
      modelId: 'forward',
      generation: 1,
      fingerprint: 'worker-crash',
    },
  })
  await assert.rejects(stalePrediction, (error: unknown) => error instanceof PredictionWorkerRestartError)
  assert.equal(workerClient.epoch, 3)

  const cancelledPrediction = workerClient.predict('forward', 1, 'worker-crash', [scalar('x', 0)])
  assert.equal(workerClient.cancelPending(), true)
  await assert.rejects(cancelledPrediction, (error: unknown) => (error as { name?: string }).name === 'AbortError')
  assert.equal(workerClient.epoch, 4)
  workerClient.dispose()
} finally {
  if (originalWorker === undefined) Reflect.deleteProperty(globalThis, 'Worker')
  else Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker, writable: true })
}

const balancedModel = buildPredictionKnnModel({
  direction: 'inverse',
  fingerprint: 'balanced-v1',
  k: 2,
  inputKeys: ['large', 'small'],
  outputKeys: ['result'],
  rows: balancedRows,
  fixedOutputLayouts: [scalar('result', 0, { minimum: 0, maximum: 10 }).layout],
})
const midpoint = predictWithKnn(balancedModel, [scalar('small', 5), tensor('large', [5, 5, 5, 5])])
assert.ok(Math.abs(midpoint.output[0].values[0] - 5) < 1e-12)
assert.deepEqual(
  midpoint.neighbors.map((neighbor) => neighbor.measurementId),
  [1, 2],
)
assert.ok(Math.abs(midpoint.neighbors[0].weight - 0.5) < 1e-12)
const blockBalanced = predictWithKnn(balancedModel, [scalar('small', 0), tensor('large', [10, 10, 10, 10])])
assert.ok(Math.abs(blockBalanced.output[0].values[0] - 5) < 1e-12)
const smallOnlyModel = buildPredictionKnnModel({
  direction: 'inverse',
  fingerprint: 'weighted-blocks-v1',
  inputKeys: ['large', 'small'],
  outputKeys: ['result'],
  rows: balancedRows,
  fixedOutputLayouts: [scalar('result', 0, { minimum: 0, maximum: 10 }).layout],
  inputBlockWeights: { large: 0, small: 3 },
  k: 2,
})
const smallOnly = predictWithKnn(smallOnlyModel, [scalar('small', 0), tensor('large', [10, 10, 10, 10])])
assert.equal(smallOnly.output[0].values[0], 0)
assert.deepEqual(smallOnlyModel.inputBlockWeights, { large: 0, small: 3 })
const hugeFiniteWeightModel = buildPredictionKnnModel({
  direction: 'inverse',
  fingerprint: 'huge-finite-block-weights',
  inputKeys: ['large', 'small'],
  outputKeys: ['result'],
  rows: balancedRows,
  inputBlockWeights: { large: Number.MAX_VALUE, small: Number.MAX_VALUE },
  k: 2,
})
const hugeFiniteWeightPrediction = predictWithKnn(hugeFiniteWeightModel, [
  scalar('small', 5),
  tensor('large', [5, 5, 5, 5]),
])
assert.equal(hugeFiniteWeightModel.activeInputWeightScale, Number.MAX_VALUE)
assert.equal(hugeFiniteWeightModel.activeInputWeightSum, 2)
assert.ok(Math.abs(hugeFiniteWeightPrediction.output[0].values[0] - 5) < 1e-12)
assert.throws(
  () =>
    buildPredictionKnnModel({
      direction: 'inverse',
      fingerprint: 'zero-block-weights',
      inputKeys: ['large', 'small'],
      outputKeys: ['result'],
      rows: balancedRows,
      inputBlockWeights: { large: 0, small: 0 },
    }),
  (error: unknown) => error instanceof PredictionModelError && error.code === 'invalid-data',
)

const duplicateModel = buildPredictionKnnModel({
  direction: 'inverse',
  fingerprint: 'duplicate-v1',
  k: 1,
  inputKeys: ['x'],
  outputKeys: ['y'],
  rows: [
    row(5, [scalar('x', 0)], [scalar('y', 2)]),
    row(3, [scalar('x', 0)], [scalar('y', 4)]),
    row(8, [scalar('x', 2)], [scalar('y', 20)]),
  ],
})
const duplicate = predictWithKnn(duplicateModel, [scalar('x', 0)])
assert.deepEqual(
  duplicate.neighbors.map((neighbor) => neighbor.measurementId),
  [3, 5],
)
assert.deepEqual(
  duplicate.neighbors.map((neighbor) => neighbor.weight),
  [0.5, 0.5],
)
assert.equal(duplicate.output[0].values[0], 3)

const tieModel = buildPredictionKnnModel({
  direction: 'inverse',
  fingerprint: 'ties-v1',
  k: 5,
  inputKeys: ['x'],
  outputKeys: ['y'],
  rows: [1, 2, 3, 4, 5, 6].map((measurementId, index) =>
    row(measurementId, [scalar('x', index < 3 ? -1 : 1)], [scalar('y', index)]),
  ),
})
const ties = predictWithKnn(tieModel, [scalar('x', 0)])
assert.equal(ties.neighbors.length, 5)
assert.deepEqual(
  ties.neighbors.map((neighbor) => neighbor.measurementId),
  [1, 2, 3, 4, 5],
)

const distanceRows = [row(1, [scalar('x', 0)], [scalar('y', 0)]), row(2, [scalar('x', 3)], [scalar('y', 9)])]
const distancePrediction = predictWithKnn(
  buildPredictionKnnModel({
    direction: 'inverse',
    fingerprint: 'distance-v1',
    inputKeys: ['x'],
    outputKeys: ['y'],
    rows: distanceRows,
    k: 2,
  }),
  [scalar('x', 1)],
)
assert.ok(Math.abs(distancePrediction.output[0].values[0] - 3) < 1e-12)
const uniformPrediction = predictWithKnn(
  buildPredictionKnnModel({
    direction: 'inverse',
    fingerprint: 'uniform-v1',
    inputKeys: ['x'],
    outputKeys: ['y'],
    rows: distanceRows,
    k: 2,
    weighting: 'uniform',
  }),
  [scalar('x', 1)],
)
assert.equal(uniformPrediction.output[0].values[0], 4.5)

const extrapolation = predictWithKnn(
  buildPredictionKnnModel({
    direction: 'inverse',
    fingerprint: 'constant-v1',
    inputKeys: ['active', 'constant'],
    outputKeys: ['bounded'],
    rows: [
      row(1, [scalar('active', 0), scalar('constant', 2)], [scalar('bounded', 0, { minimum: 0, maximum: 1 })]),
      row(2, [scalar('active', 1), scalar('constant', 2)], [scalar('bounded', 1, { minimum: 0, maximum: 1 })]),
    ],
    fixedOutputLayouts: [scalar('bounded', 0, { minimum: 0, maximum: 1 }).layout],
  }),
  [scalar('active', 2), scalar('constant', 3)],
)
assert.deepEqual(extrapolation.extrapolatedInputKeys, ['active', 'constant'])
assert.deepEqual(extrapolation.constantInputKeysChanged, ['constant'])
assert.ok(extrapolation.output[0].values[0] >= 0 && extrapolation.output[0].values[0] <= 1)

const intLayout = { key: 'count', dtype: 'uint8', shape: [] } as const
const integerForward = buildPredictionKnnModel({
  direction: 'forward',
  fingerprint: 'integer-v1',
  k: 2,
  inputKeys: ['x'],
  outputKeys: ['count'],
  rows: [
    row(1, [scalar('x', 0)], [{ layout: intLayout, values: [0] }]),
    row(2, [scalar('x', 2)], [{ layout: intLayout, values: [3] }]),
  ],
})
assert.equal(predictWithKnn(integerForward, [scalar('x', 1)]).output[0].values[0], 2)
const currentSchemaNormalizedForward = buildPredictionKnnModel({
  direction: 'forward',
  fingerprint: 'current-output-dtype',
  k: 2,
  weighting: 'uniform',
  inputKeys: ['x'],
  outputKeys: ['count'],
  outputDtypes: { count: 'float64' },
  rows: [
    row(1, [scalar('x', 0)], [{ layout: intLayout, values: [0] }]),
    row(2, [scalar('x', 2)], [{ layout: intLayout, values: [3] }]),
  ],
})
const currentSchemaNormalizedResult = predictWithKnn(currentSchemaNormalizedForward, [scalar('x', 1)]).output[0]
assert.equal(currentSchemaNormalizedResult.layout.dtype, 'float64')
assert.equal(currentSchemaNormalizedResult.values[0], 1.5)
const float16Layout = { key: 'half', dtype: 'float16', shape: [] } as const
const float16Forward = buildPredictionKnnModel({
  direction: 'forward',
  fingerprint: 'float16-exponent-carry',
  k: 2,
  weighting: 'uniform',
  inputKeys: ['x'],
  outputKeys: ['half'],
  rows: [
    row(1, [scalar('x', 0)], [{ layout: float16Layout, values: [127.9375] }]),
    row(2, [scalar('x', 2)], [{ layout: float16Layout, values: [128] }]),
  ],
})
assert.equal(predictWithKnn(float16Forward, [scalar('x', 1)]).output[0].values[0], 128)

const layoutA = tensor('target', [1, 2], [2])
const layoutB: PredictionTensorSample = {
  layout: { key: 'target', dtype: 'float64', shape: [2], axes: [{ name: 'index', ticks: [10, 20] }] },
  values: [1, 2],
}
const selected = selectPredictionCohort({
  direction: 'inverse',
  fingerprint: 'cohort-v1',
  inputKeys: ['target'],
  outputKeys: ['v'],
  rows: [
    row(1, [layoutB], [scalar('v', 1)]),
    row(2, [layoutA], [scalar('v', 2)]),
    row(3, [layoutA], [scalar('v', 3)]),
    row(4, [], [scalar('v', 4)]),
    row(5, [layoutA, scalar('extra', 1)], [scalar('v', 5)]),
  ],
})
assert.deepEqual(selected.summary.includedMeasurementIds, [1, 2, 3])
assert.deepEqual(selected.summary.warningMeasurementIds, [2, 3])
assert.equal(selected.summary.excluded['layout-mismatch'], 0)
assert.equal(selected.summary.excluded['missing-block'], 1)
assert.equal(selected.summary.excluded['extra-block'], 1)
const axesTickWarning = selected.summary.diagnostics.find(
  (diagnostic) => diagnostic.blockKey === 'target' && diagnostic.fieldPath === 'axes[0].ticks',
)
assert.ok(axesTickWarning)
assert.equal(axesTickWarning.direction, 'inverse')
assert.equal(axesTickWarning.disposition, 'included-with-warning')
assert.equal(axesTickWarning.baselineMeasurementId, 1)
assert.deepEqual(axesTickWarning.measurementIds, [2, 3])
assert.equal(axesTickWarning.firstMismatchIndex, 0)
assert.equal(axesTickWarning.mismatchCount, 2)
assert.equal(axesTickWarning.maxAbsoluteDifference, 19)

const schemaCohort = selectPredictionCohort({
  direction: 'forward',
  fingerprint: 'strict-data-schema',
  inputKeys: ['x'],
  outputKeys: ['recorded'],
  rows: [
    row(1, [scalar('x', 0)], [scalar('recorded', 1, { dataSchemaSignature: 'schema-a' })]),
    row(2, [scalar('x', 1)], [scalar('recorded', 2, { dataSchemaSignature: 'schema-b' })]),
    row(3, [scalar('x', 2)], [scalar('recorded', 3, { dataSchemaSignature: 'schema-a' })]),
  ],
})
assert.deepEqual(schemaCohort.summary.includedMeasurementIds, [1, 2, 3])
assert.deepEqual(schemaCohort.summary.warningMeasurementIds, [2])
assert.equal(schemaCohort.summary.excluded['layout-mismatch'], 0)
assert.deepEqual(
  schemaCohort.summary.diagnostics.find((diagnostic) => diagnostic.fieldPath === 'dataSchemaSignature')?.measurementIds,
  [2],
)

const twentyFiveRows = selectPredictionCohort({
  direction: 'forward',
  fingerprint: 'same-shape-different-ticks',
  inputKeys: ['x'],
  outputKeys: ['recorded'],
  rows: Array.from({ length: 25 }, (_item, index) =>
    row(
      index + 1,
      [scalar('x', index)],
      [
        {
          layout: {
            key: 'recorded',
            dtype: 'float64',
            shape: [2],
            axes: [{ name: 'sample', ticks: index < 3 ? [0, 1] : [0, 2] }],
          },
          values: [index, index + 1],
        },
      ],
    ),
  ),
})
assert.equal(twentyFiveRows.summary.includedRows, 25)
assert.equal(twentyFiveRows.summary.excluded['layout-mismatch'], 0)
assert.deepEqual(
  twentyFiveRows.summary.warningMeasurementIds,
  Array.from({ length: 22 }, (_item, index) => index + 4),
)
const twentyFiveTickWarning = twentyFiveRows.summary.diagnostics.find(
  (diagnostic) => diagnostic.fieldPath === 'axes[0].ticks',
)
assert.ok(twentyFiveTickWarning)
assert.equal(twentyFiveTickWarning.baselineMeasurementId, 1)
assert.deepEqual(
  twentyFiveTickWarning.measurementIds,
  Array.from({ length: 22 }, (_item, index) => index + 4),
)
assert.equal(twentyFiveTickWarning.firstMismatchIndex, 1)
assert.equal(twentyFiveTickWarning.mismatchCount, 1)
assert.equal(twentyFiveTickWarning.maxAbsoluteDifference, 1)

const metadataCohort = selectPredictionCohort({
  direction: 'forward',
  fingerprint: 'metadata-warning-only',
  inputKeys: ['x'],
  outputKeys: ['recorded'],
  rows: [
    row(
      1,
      [scalar('x', 0)],
      [
        {
          layout: {
            key: 'recorded',
            dtype: 'float64',
            shape: [2],
            axes: [{ name: 'time', ticks: [0, 1], unit: 's' }],
            tensorOrder: 0,
            unit: 'Pa',
            quantityKind: 'Pressure',
            dataSchemaSignature: 'schema-a',
          },
          values: [1, 2],
        },
      ],
    ),
    row(
      2,
      [scalar('x', 1)],
      [
        {
          layout: {
            key: 'recorded',
            dtype: 'float32',
            shape: [2],
            tensorOrder: 1,
            unit: 'kPa',
            quantityKind: 'Stress',
            dataSchemaSignature: 'schema-b',
          },
          values: [3, 4],
        },
      ],
    ),
  ],
})
assert.deepEqual(metadataCohort.summary.includedMeasurementIds, [1, 2])
assert.deepEqual(metadataCohort.summary.warningMeasurementIds, [2])
for (const fieldPath of ['dtype', 'tensorOrder', 'unit', 'quantityKind', 'dataSchemaSignature', 'axes.length']) {
  assert.ok(metadataCohort.summary.diagnostics.some((diagnostic) => diagnostic.fieldPath === fieldPath))
}

const shapeCohort = selectPredictionCohort({
  direction: 'inverse',
  fingerprint: 'shape-only-groups',
  inputKeys: ['target'],
  outputKeys: ['v'],
  rows: [
    row(1, [tensor('target', [1, 2], [2])], [scalar('v', 1)]),
    row(2, [tensor('target', [3, 4], [2])], [scalar('v', 2)]),
    row(3, [tensor('target', [5, 6], [1, 2])], [scalar('v', 3)]),
    row(4, [tensor('target', [7, 8], [1, 2])], [scalar('v', 4)]),
  ],
})
assert.deepEqual(shapeCohort.summary.includedMeasurementIds, [1, 2])
assert.equal(shapeCohort.summary.excluded['layout-mismatch'], 2)
const shapeDiagnostic = shapeCohort.summary.diagnostics.find(
  (diagnostic) => diagnostic.reason === 'layout-mismatch' && diagnostic.fieldPath === 'shape',
)
assert.ok(shapeDiagnostic)
assert.equal(shapeDiagnostic.baselineMeasurementId, 1)
assert.equal(shapeDiagnostic.expected, '[2]')
assert.equal(shapeDiagnostic.actual, '[1,2]')
assert.deepEqual(shapeDiagnostic.measurementIds, [3, 4])

const independentRecordA = selectPredictionCohort({
  direction: 'forward',
  fingerprint: 'record-a-independent-shape',
  inputKeys: ['v'],
  outputKeys: ['record-a'],
  rows: [
    row(1, [scalar('v', 1)], [tensor('record-a', [1, 2], [2])]),
    row(2, [scalar('v', 2)], [tensor('record-a', [3, 4], [2])]),
    row(3, [scalar('v', 3)], [tensor('record-a', [5, 6], [1, 2])]),
    row(4, [scalar('v', 4)], [tensor('record-a', [7, 8], [1, 2])]),
  ],
})
const independentRecordB = selectPredictionCohort({
  direction: 'forward',
  fingerprint: 'record-b-independent-shape',
  inputKeys: ['v'],
  outputKeys: ['record-b'],
  rows: [1, 2, 3, 4].map((measurementId) =>
    row(measurementId, [scalar('v', measurementId)], [scalar('record-b', measurementId * 10)]),
  ),
})
assert.deepEqual(independentRecordA.summary.includedMeasurementIds, [1, 2])
assert.equal(independentRecordA.summary.excluded['layout-mismatch'], 2)
assert.deepEqual(independentRecordB.summary.includedMeasurementIds, [1, 2, 3, 4])
assert.equal(independentRecordB.summary.excluded['layout-mismatch'], 0)

const queryModel = buildPredictionKnnModel({
  direction: 'inverse',
  fingerprint: 'shape-only-query',
  inputKeys: ['target'],
  outputKeys: ['v'],
  rows: [row(1, [layoutB], [scalar('v', 1)]), row(2, [layoutA], [scalar('v', 2)])],
})
const metadataQueryResult = predictWithKnn(queryModel, [
  {
    layout: {
      key: 'target',
      dtype: 'float32',
      shape: [2],
      axes: [{ name: 'renamed', ticks: ['a', 'b'], unit: 'index' }],
      unit: 'other',
    },
    values: [1, 2],
  },
])
assert.ok(metadataQueryResult.queryDiagnostics.some((diagnostic) => diagnostic.fieldPath === 'dtype'))
assert.ok(metadataQueryResult.queryDiagnostics.some((diagnostic) => diagnostic.fieldPath === 'axes[0].ticks'))
const queryActivities: string[] = []
const queryFingerprints = new Set<string>()
assert.equal(
  emitPredictionQueryDiagnostics(metadataQueryResult, 'shape-only-query', queryFingerprints, (activity) => {
    queryActivities.push(activity.message)
  }),
  true,
)
assert.ok(queryActivities.some((message) => message.includes('cell index 기준')))
assert.equal(
  emitPredictionQueryDiagnostics(metadataQueryResult, 'shape-only-query', queryFingerprints, (activity) => {
    queryActivities.push(activity.message)
  }),
  false,
)
assert.throws(
  () => predictWithKnn(queryModel, [tensor('target', [1, 2], [1, 2])]),
  (error: unknown) => error instanceof PredictionModelError && error.code === 'invalid-data',
)

const cappedDiagnostics = selectPredictionCohort({
  direction: 'forward',
  fingerprint: 'diagnostic-group-cap',
  inputKeys: ['x'],
  outputKeys: ['recorded'],
  rows: Array.from({ length: 502 }, (_item, index) =>
    row(index + 1, [scalar('x', index)], [scalar('recorded', index, { unit: `unit-${index}` })]),
  ),
})
assert.equal(cappedDiagnostics.summary.diagnostics.length, 500)
assert.equal(cappedDiagnostics.summary.omittedDiagnosticGroups, 1)
const diagnosticActivities: { message: string; source: string }[] = []
const diagnosticFingerprints = new Set<string>()
const cappedProfile = {
  direction: 'forward',
  activeInputBlockCount: 1,
  rowCount: cappedDiagnostics.summary.includedRows,
  k: 15,
  weighting: 'distance',
  inputScaling: 'range',
  inputLayouts: cappedDiagnostics.inputLayouts,
  inputScales: new Float64Array(),
  inputBlockWeights: { x: 1 },
  inputSize: 1,
  outputSize: 1,
  persistentBytes: 0,
  workingSetBytes: 0,
  includedMeasurementIds: cappedDiagnostics.summary.includedMeasurementIds,
  warningMeasurementIds: cappedDiagnostics.summary.warningMeasurementIds,
  dominantShapeSignature: cappedDiagnostics.summary.dominantShapeSignature,
  baselineMeasurementId: cappedDiagnostics.summary.baselineMeasurementId,
  diagnostics: cappedDiagnostics.summary.diagnostics,
  omittedDiagnosticGroups: cappedDiagnostics.summary.omittedDiagnosticGroups,
  excluded: cappedDiagnostics.summary.excluded,
} as const
assert.equal(PREDICTION_CONSOLE_DIAGNOSTIC_LIMIT, 100)
assert.equal(
  emitPredictionCohortDiagnostics(cappedProfile, 'diagnostic-group-cap', diagnosticFingerprints, (activity) => {
    diagnosticActivities.push({ message: activity.message, source: activity.source })
  }),
  true,
)
assert.equal(diagnosticActivities.length, 101)
const runtimeConsole = createRuntimeConsoleStore({ createId: () => 'prediction-event', now: () => 1 })
runtimeConsole.append({ source: 'prediction', level: 'warning', message: 'shape metadata warning' })
assert.equal(runtimeConsole.getSnapshot().events[0].source, 'prediction')
assert.ok(diagnosticActivities.every((activity) => activity.source === 'prediction'))
assert.match(diagnosticActivities.at(-1)!.message, /401개 진단 그룹/u)
assert.equal(
  emitPredictionCohortDiagnostics(cappedProfile, 'diagnostic-group-cap', diagnosticFingerprints, (activity) => {
    diagnosticActivities.push({ message: activity.message, source: activity.source })
  }),
  false,
)
assert.equal(diagnosticActivities.length, 101)

const allConstantModel = buildPredictionKnnModel({
  direction: 'inverse',
  fingerprint: 'all-constant',
  inputKeys: ['x'],
  outputKeys: ['y'],
  rows: [row(1, [scalar('x', 1)], [scalar('y', 1)]), row(2, [scalar('x', 1)], [scalar('y', 2)])],
})
assert.equal(allConstantModel.activeInputBlockCount, 0)
assert.equal(predictWithKnn(allConstantModel, [scalar('x', 2)]).output[0].values[0], 1.5)

assert.throws(
  () =>
    buildPredictionKnnModel({
      direction: 'inverse',
      fingerprint: 'one-row-invalid-k',
      inputKeys: ['x'],
      outputKeys: ['y'],
      rows: [row(1, [scalar('x', 1)], [scalar('y', 7)])],
      k: 99,
    }),
  /integer from 1 to 1/u,
)
const oneRowModel = buildPredictionKnnModel({
  direction: 'inverse',
  fingerprint: 'one-row',
  inputKeys: ['x'],
  outputKeys: ['y'],
  rows: [row(1, [scalar('x', 1)], [scalar('y', 7)])],
  k: 1,
})
assert.equal(predictWithKnn(oneRowModel, [scalar('x', 4)]).output[0].values[0], 7)

const boundedInput = (value: number) => scalar('x', value, { minimum: 0, maximum: 10 })
const rangeModel = buildPredictionKnnModel({
  direction: 'forward',
  fingerprint: 'range-v1',
  inputKeys: ['x'],
  outputKeys: ['y'],
  inputScaling: 'range',
  rows: [row(1, [boundedInput(4)], [scalar('y', 0)]), row(2, [boundedInput(6)], [scalar('y', 1)])],
  fixedInputLayouts: [boundedInput(0).layout],
})
assert.equal(rangeModel.inputScales[0], 10)
assert.equal(rangeModel.inputScaling, 'range')
const extremeRangeInput = (value: number) =>
  scalar('x', value, { minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE })
const extremeRangeModel = buildPredictionKnnModel({
  direction: 'forward',
  fingerprint: 'extreme-range-v1',
  inputKeys: ['x'],
  outputKeys: ['y'],
  inputScaling: 'range',
  rows: [row(1, [extremeRangeInput(-1)], [scalar('y', 0)]), row(2, [extremeRangeInput(1)], [scalar('y', 10)])],
  fixedInputLayouts: [extremeRangeInput(0).layout],
  k: 1,
})
const extremeRangePrediction = predictWithKnn(extremeRangeModel, [extremeRangeInput(-1)])
assert.equal(extremeRangeModel.inputScales[0], 2)
assert.equal(extremeRangePrediction.output[0].values[0], 0)
assert.deepEqual(
  extremeRangePrediction.neighbors.map((neighbor) => neighbor.measurementId),
  [1],
)

const autoKModel = buildPredictionKnnModel({
  direction: 'inverse',
  fingerprint: 'auto-k-cap',
  inputKeys: ['x'],
  outputKeys: ['y'],
  rows: Array.from({ length: 256 }, (_item, index) => row(index + 1, [scalar('x', index)], [scalar('y', index)])),
})
assert.equal(autoKModel.k, 15)
assert.throws(
  () =>
    buildPredictionKnnModel({
      direction: 'inverse',
      fingerprint: 'memory',
      inputKeys: ['x'],
      outputKeys: ['y'],
      rows: [row(1, [scalar('x', 0)], [scalar('y', 0)]), row(2, [scalar('x', 1)], [scalar('y', 1)])],
      persistentArrayLimitBytes: 1,
    }),
  (error: unknown) => error instanceof PredictionModelError && error.code === 'memory-limit',
)
assert.deepEqual(estimatePredictionMemory(2, 1, 1), { persistentBytes: 72, workingSetBytes: 160 })
assert.equal(PREDICTION_NUMERIC_CELL_LIMIT, 10_000_000)
assert.doesNotThrow(() => estimatePredictionMemory(2, 2_500_000, 2_500_000))
assert.throws(
  () => estimatePredictionMemory(2, 2_500_000, 2_500_001),
  (error: unknown) => error instanceof PredictionModelError && error.code === 'memory-limit',
)
assert.throws(
  () => estimatePredictionMemory(2, Number.MAX_SAFE_INTEGER, 1),
  (error: unknown) => error instanceof PredictionModelError && error.code === 'memory-limit',
)
assert.equal(predictionModelIsStale(balancedModel, 'balanced-v1'), false)
assert.equal(predictionModelIsStale(balancedModel, 'balanced-v2'), true)
assert.throws(
  () => predictWithKnn(balancedModel, [scalar('small', 5), tensor('large', [5, 5, 5, 5])], 'balanced-v2'),
  (error: unknown) => error instanceof PredictionModelError && error.code === 'stale-model',
)
assert.equal(
  predictionWorkerResponseIsCurrent(
    { type: 'stale', requestId: 'r', modelId: 'inverse', generation: 4, fingerprint: 'f' },
    { modelId: 'inverse', generation: 4, fingerprint: 'f' },
  ),
  true,
)
assert.equal(
  predictionWorkerResponseIsCurrent(
    { type: 'stale', requestId: 'r', modelId: 'inverse', generation: 3, fingerprint: 'f' },
    { modelId: 'inverse', generation: 4, fingerprint: 'f' },
  ),
  false,
)

const varsSchema = {
  beta: { shape: [2], min: -5, max: 5 },
  alpha: { shape: [], min: 0, max: 10 },
} as const
const varsLayouts = predictionVarsLayouts(varsSchema)
assert.deepEqual(
  varsLayouts.map((layout) => layout.key),
  ['alpha', 'beta'],
)
assert.deepEqual(
  predictionVarsSamples({ alpha: 3, beta: [1, 2] }, varsSchema).map((sample) => sample.values),
  [[3], [1, 2]],
)
assert.throws(() => predictionVarsSamples({ alpha: 3, beta: [1] }, varsSchema))

const encodedBytes = Buffer.alloc(16)
encodedBytes.writeDoubleLE(3.5, 0)
encodedBytes.writeDoubleLE(-2.25, 8)
const recordedTree = {
  group: {
    inline: {
      quantity_kind: null,
      tensor_order: 0,
      dtype: 'float64',
      data_schema: { dtype: 'float64', axes: [{ name: 'sample', length: 2 }] },
      data: {
        shape: [2],
        axes: [{ implicitOrdinal: true }],
        storage: { kind: 'inline', value: [1.5, 2.5] },
      },
    },
    encoded: {
      quantity_kind: null,
      tensor_order: 0,
      dtype: 'float64',
      data_schema: { dtype: 'float64', axes: [{ name: 'frequency', ticks: [10, 20] }] },
      data: {
        shape: [2],
        axes: [{ ticks: [10, 20] }],
        storage: { kind: 'base64', data: encodedBytes.toString('base64'), byteLength: encodedBytes.byteLength },
      },
    },
  },
} as const satisfies MeasurementRecordedData
const recordedSamples = predictionRecordedSamples(recordedTree, 41)
assert.equal(predictionRecordedSamplesMatchRules(recordedSamples.samples, recordedSamples.rules), true)
const incompatibleRecordedRules = recordedSamples.rules.map((rule, index) =>
  index === 0 ? { ...rule, result: { ...rule.result, unit: 'incompatible-unit' } } : rule,
)
assert.equal(predictionRecordedSamplesMatchRules(recordedSamples.samples, incompatibleRecordedRules), false)
const recordedByKey = new Map(recordedSamples.samples.map((sample) => [sample.layout.key, sample]))
assert.deepEqual(recordedByKey.get('group.inline')?.layout.axes?.[0].ticks, [0, 1])
assert.deepEqual(recordedByKey.get('group.inline')?.values, [1.5, 2.5])
assert.deepEqual(recordedByKey.get('group.encoded')?.values, [3.5, -2.25])
const reconstructedRecorded = predictedRecordedData(recordedSamples.samples, recordedSamples.rules)
const reconstructedInline = reconstructedRecorded['group.inline']
assert.ok(isDataTensor(reconstructedInline))
const inlineRule = recordedSamples.rules.find((rule) => rule.label === 'group.inline')!
assert.deepEqual(createDataTensorAccessor(inlineRule.result, reconstructedInline).materialize(), [1.5, 2.5])
const ordinalFallbacks: { axisIndex: number; blockKey: string; length: number }[] = []
predictedRecordedData(
  recordedSamples.samples.map((sample) =>
    sample.layout.key === 'group.inline' ? { ...sample, layout: { ...sample.layout, axes: undefined } } : sample,
  ),
  recordedSamples.rules,
  (warning) => ordinalFallbacks.push(warning),
)
assert.deepEqual(ordinalFallbacks, [{ axisIndex: 0, blockKey: 'group.inline', length: 2 }])
assert.throws(() => predictedRecordedData(recordedSamples.samples.slice(1), recordedSamples.rules))

const calculationTensor = {
  dtype: 'float64',
  shape: [2],
  data: [1, 2],
  axes: [{ name: 'time', ticks: [0, 1], unit: 's' }],
} as const satisfies CalculationDataOutput
const calculationTensorSample = calculationOutputSample(7, calculationTensor)
assert.deepEqual(calculationOutputFromSample(calculationTensorSample), calculationTensor)
const dtypeMetadataOnlySample = calculationOutputSample(8, {
  dtype: 'uint8',
  shape: [],
  data: 300,
  axes: [],
})
assert.equal(dtypeMetadataOnlySample.values[0], 300)
assert.throws(() => calculationOutputFromSample(dtypeMetadataOnlySample), /uint8 범위/u)
assert.deepEqual(calculationOutputTensor(calculationTensor), [1, 2])
assert.deepEqual(calculationOutputWithTensor(calculationTensor, [4, 5]).data, [4, 5])
assert.throws(() =>
  calculationOutputFromSample({
    layout: { key: 'calculation:7', dtype: 'float64', shape: [1], axes: [{ name: 'x', ticks: ['bad'] }] },
    values: [1],
  }),
)
assert.throws(() =>
  calculationOutputFromSample({
    layout: { key: 'calculation:8', dtype: 'uint8', shape: [], axes: [] },
    values: [1.5],
  }),
)

const measurementRows = [
  { id: 1, vars: { alpha: 1, beta: [0, 1] } },
  { id: 2, vars: { alpha: 2, beta: [1, 2] } },
  { id: 3, vars: { alpha: 3, beta: [2, 3] } },
  { id: 4, vars: { alpha: 4, beta: [3] } },
] as unknown as readonly MeasurementRecord[]
const calculationRows = [
  { id: 11, calculation_id: 7, measurement_id: 1, data: calculationTensor },
  { id: 12, calculation_id: 7, measurement_id: 3, data: { ...calculationTensor, data: [1] } },
  { id: 13, calculation_id: 7, measurement_id: 4, data: calculationTensor },
] as unknown as readonly CalculationDataRecord[]
const inverseRows = inverseTrainingRows(measurementRows, calculationRows, [7], varsSchema)
assert.equal(inverseRows.length, 4)
assert.equal(inverseRows[1].inputs.length, 0)
assert.deepEqual(inverseRows[2].inputs[0].values, [1])
assert.ok(Number.isNaN(inverseRows[3].outputs[0].values[0]))
const inverseCohort = selectPredictionCohort({
  direction: 'inverse',
  fingerprint: 'adapter-cohort',
  inputKeys: ['calculation:7'],
  outputKeys: ['alpha', 'beta'],
  rows: inverseRows,
  fixedOutputLayouts: varsLayouts,
})
assert.deepEqual(inverseCohort.summary.includedMeasurementIds, [1])
assert.equal(inverseCohort.summary.excluded['missing-block'], 1)
assert.equal(inverseCohort.summary.excluded['invalid-tensor'], 2)
assert.equal(inverseCohort.summary.totalRows, 4)
assert.ok(
  inverseCohort.summary.diagnostics.some(
    (diagnostic) =>
      diagnostic.disposition === 'excluded' &&
      diagnostic.measurementIds.includes(3) &&
      diagnostic.fieldPath === 'data.length' &&
      diagnostic.expected === '2' &&
      diagnostic.actual === '1',
  ),
)
assert.ok(inverseCohort.summary.diagnostics.every((diagnostic) => diagnostic.baselineMeasurementId === 1))
assert.throws(() => inverseTrainingRows(measurementRows, calculationRows, [7, 7], varsSchema))

assert.equal(predictionFingerprint([{ z: 1, a: 2 }]), predictionFingerprint([{ a: 2, z: 1 }]))

const scalarMetric = comparePredictionOutput(
  { dtype: 'float64', shape: [], data: 10, axes: [] },
  { dtype: 'float64', shape: [], data: 12, axes: [] },
)
assert.deepEqual(scalarMetric, {
  compatible: true,
  message: null,
  mae: 2,
  rmse: 2,
  maxAbsoluteError: 2,
  relativeError: 0.2,
})
const tensorMetric = comparePredictionOutput(calculationTensor, {
  dtype: 'float64',
  shape: [2],
  data: [2, 4],
  axes: [{ unit: 's', ticks: [0, 1], name: 'time' }],
})
assert.equal(tensorMetric.compatible, true)
assert.equal(tensorMetric.mae, 1.5)
assert.ok(Math.abs(tensorMetric.rmse! - Math.sqrt(2.5)) < 1e-12)
assert.equal(tensorMetric.maxAbsoluteError, 2)
assert.equal(tensorMetric.relativeError, null)
assert.equal(
  comparePredictionOutput(calculationTensor, {
    ...calculationTensor,
    axes: [{ name: 'time', ticks: [0, 2], unit: 's' }],
  }).compatible,
  false,
)
assert.equal(
  comparePredictionOutput(
    { dtype: 'float64', shape: [], data: Number.MAX_VALUE, axes: [] },
    { dtype: 'float64', shape: [], data: -Number.MAX_VALUE, axes: [] },
  ).compatible,
  false,
)

const aggregateTrainingRows = [
  row(101, [scalar('calculation:1', 0), scalar('calculation:2', 0)], [scalar('var', 0)]),
  row(102, [scalar('calculation:1', 2), scalar('calculation:2', 4)], [scalar('var', 1)]),
]
const aggregateError = inverseValidationAggregateError(
  [
    {
      calculationId: 1,
      reference: { dtype: 'float64', shape: [], data: 0, axes: [] },
      actual: { dtype: 'float64', shape: [], data: 1, axes: [] },
    },
    {
      calculationId: 2,
      reference: { dtype: 'float64', shape: [], data: 0, axes: [] },
      actual: { dtype: 'float64', shape: [], data: 4, axes: [] },
    },
  ],
  { 1: 1, 2: 3 },
  aggregateTrainingRows,
  [101, 102],
)
assert.ok(Math.abs(aggregateError! - Math.sqrt(13 / 4)) < 1e-12)
const aggregateErrorFromScales = inverseValidationAggregateErrorFromScales(
  [
    {
      calculationId: 1,
      reference: { dtype: 'float64', shape: [], data: 0, axes: [] },
      actual: { dtype: 'float64', shape: [], data: 1, axes: [] },
    },
    {
      calculationId: 2,
      reference: { dtype: 'float64', shape: [], data: 0, axes: [] },
      actual: { dtype: 'float64', shape: [], data: 4, axes: [] },
    },
  ],
  { 1: 1, 2: 3 },
  [
    { key: 'calculation:1', dtype: 'float64', shape: [] },
    { key: 'calculation:2', dtype: 'float64', shape: [] },
  ],
  new Float64Array([1, 2]),
)
assert.ok(Math.abs(aggregateErrorFromScales! - Math.sqrt(13 / 4)) < 1e-12)

assert.deepEqual(
  predictionOutputRange([
    { dtype: 'float64', shape: [], data: 2, axes: [] },
    { dtype: 'float64', shape: [], data: 5, axes: [] },
  ]),
  [1.85, 5.15],
)
assert.deepEqual(fitTensorDisplayDomain([]), [-1, 1])
assert.deepEqual(fitTensorDisplayDomain([0, 0]), [-0.5, 0.5])
assert.deepEqual(fitTensorDisplayDomain([-2, 2]), [-2.2, 2.2])
assert.ok(Math.abs(fitTensorDisplayDomain([0.001, 0.001])[0] - 0.00095) < 1e-15)
assert.ok(Math.abs(fitTensorDisplayDomain([0.001, 0.001])[1] - 0.00105) < 1e-15)

const varsPanelMarkup = renderToStaticMarkup(
  createElement(VarsPanel, {
    candidateSessionKey: 'experiment:1',
    disabled: false,
    schema: {
      pressure: { min: -10, max: 10, shape: [2] },
      temperature: { min: 0, max: 100, shape: [] },
    },
    vars: { pressure: [1, 2], temperature: 25 },
    onVariableChange: () => undefined,
  }),
)
assert.doesNotMatch(varsPanelMarkup, /role="dialog"/u)
assert.equal((varsPanelMarkup.match(/aria-expanded="false"/gu) ?? []).length, 2)
assert.match(varsPanelMarkup, /schema \[-10, 10\]/u)
assert.match(varsPanelMarkup, /2 cells/u)

const calculationPaneMarkup = renderToStaticMarkup(
  createElement(PredictionCalculationPane, {
    disabled: false,
    items: [],
    mode: 'prediction',
    resetKey: 'prediction:1',
    status: 'ready',
    updating: false,
    onOutputChange: () => undefined,
  }),
)
assert.doesNotMatch(calculationPaneMarkup, /기준 Measurement/u)
assert.doesNotMatch(calculationPaneMarkup, /reference measurement/i)

let comparisonCommitCount = 0
const scalarComparisonMarkup = renderToStaticMarkup(
  createElement(TensorEditor, {
    comparison: {
      primaryColor: '#f97316',
      primaryLabel: 'Target',
      series: [
        {
          color: '#7c3aed',
          id: 'repredicted',
          label: 'Re-predicted',
          lineDash: [7, 4],
          status: 'ready',
          value: 11,
        },
        {
          color: '#059669',
          id: 'actual',
          label: 'Save + Run Actual',
          lineDash: [3, 3],
          status: 'ready',
          value: 12,
        },
      ],
    },
    label: 'Scalar comparison',
    maximum: 10,
    minimum: 0,
    shape: [],
    value: 10,
    onValueChange: () => {
      comparisonCommitCount += 1
    },
  }),
)
assert.match(scalarComparisonMarkup, /data-comparison-series="repredicted"/u)
assert.match(scalarComparisonMarkup, /data-comparison-series="actual"/u)
assert.match(scalarComparisonMarkup, /Target/u)
assert.match(scalarComparisonMarkup, /Re-predicted/u)
assert.match(scalarComparisonMarkup, /Save \+ Run Actual/u)
assert.match(scalarComparisonMarkup, /Display range \[0, 10\]/u)
assert.match(scalarComparisonMarkup, /data-display-domain-clipped="2"/u)
assert.match(scalarComparisonMarkup, />Fit</u)
assert.equal(comparisonCommitCount, 0)

const updatingComparisonMarkup = renderToStaticMarkup(
  createElement(TensorEditor, {
    axes: [{ name: 'time', ticks: [0, 1], unit: 's' }],
    comparison: {
      primaryColor: '#2563eb',
      primaryLabel: 'Predicted',
      series: [
        {
          color: '#059669',
          id: 'actual',
          label: 'Save + Run Actual',
          status: 'updating',
          value: null,
        },
      ],
    },
    label: 'Forward comparison',
    maximum: 10,
    minimum: 0,
    shape: [2],
    value: [1, 2],
    onValueChange: () => {
      comparisonCommitCount += 1
    },
  }),
)
assert.match(updatingComparisonMarkup, /Predicted/u)
assert.match(updatingComparisonMarkup, /Updating…/u)

const heatmapComparisonMarkup = renderToStaticMarkup(
  createElement(TensorEditor, {
    axes: [
      { name: 'row', ticks: [0, 1] },
      { name: 'column', ticks: [10, 20] },
    ],
    comparison: {
      primaryColor: '#f97316',
      primaryLabel: 'Target',
      series: [
        {
          color: '#7c3aed',
          id: 'repredicted',
          label: 'Re-predicted',
          status: 'ready',
          value: [
            [2, 3],
            [4, 5],
          ],
        },
        {
          color: '#059669',
          id: 'actual',
          label: 'Save + Run Actual',
          message: '실제 결과가 없습니다.',
          status: 'unavailable',
          value: null,
        },
      ],
    },
    label: 'Heatmap comparison',
    maximum: 10,
    minimum: 0,
    shape: [2, 2],
    value: [
      [1, 2],
      [3, 4],
    ],
    onValueChange: () => {
      comparisonCommitCount += 1
    },
  }),
)
assert.match(heatmapComparisonMarkup, /data-comparison-layout="parallel-heatmaps"/u)
assert.match(heatmapComparisonMarkup, /data-comparison-series="primary"/u)
assert.match(heatmapComparisonMarkup, /data-comparison-series="repredicted"/u)
assert.match(heatmapComparisonMarkup, /실제 결과가 없습니다\./u)
assert.equal((heatmapComparisonMarkup.match(/type="number"/gu) ?? []).length, 1)
assert.equal(comparisonCommitCount, 0)

console.info('Prediction kNN tests passed.')
