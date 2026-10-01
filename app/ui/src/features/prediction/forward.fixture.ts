import { vi } from 'vitest'
import { BOX_GRID_AXES, type BoxGridData } from '@/contracts/boxGrid'
import type { RecordedDataRule } from '@/lib/cad/model'
import type { PredictionExecution, PreparedPredictionModel, SavedPredictionModel } from './execution'
import type { PredictionContext, SavedPredictionCalculation } from './predictionContextData'
import { predictionFingerprint } from './data'
import { defaultPredictionSetup, type PredictionSetup } from './usePredictionModels'
import type { PredictionTensorSample } from './types'

export const varsSchema = { x: { dtype: 'float64' as const, shape: [], min: 0, max: 1 } }
export const grid: BoxGridData = {
  version: 1,
  sampling: 'point',
  components: ['scalar'],
  channels: ['value'],
  channelUnits: ['K'],
  origin: [0, 0, 0],
  size: [1, 1, 1],
  rotation: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  gridShape: [1, 1, 1],
  lengthUnit: 'm',
  source: 'task',
  rootId: 'box',
}
export const rule: RecordedDataRule = {
  label: 'heat.T',
  target: [],
  methodId: 'fixture',
  parameters: {},
  result: {
    dtype: 'float64',
    unit: 'K',
    quantityKind: 'thermodynamics.Temperature',
    tensorOrder: 0,
    boxGrid: grid,
    axes: BOX_GRID_AXES.map((name, i) => ({
      name,
      ...(i < 3
        ? { unit: 'm' as const, quantityKind: 'space.Length' }
        : { ticks: i === 5 ? ['value'] : i === 6 ? ['scalar'] : [0] }),
    })),
  } as RecordedDataRule['result'] & { tensorOrder: number },
}
export const sample: PredictionTensorSample = {
  layout: {
    key: 'heat.T',
    dtype: 'float64',
    shape: [1, 1, 1, 1, 1, 1, 1],
    axes: rule.result.axes!.map((axis) => ({ name: axis.name!, ticks: axis.ticks ?? [0.5] })),
    boxGrid: grid,
  },
  values: [15],
}
export const provenance = {
  modelId: '10000000-0000-4000-8000-000000000001',
  modelRevision: 1,
  datasetId: '10000000-0000-4000-8000-000000000002',
  datasetRevision: 2,
}
export const reference: SavedPredictionModel = {
  ...provenance,
  direction: 'forward',
  fingerprint: 'forward-model',
  contract: {
    experimentId: 3,
    varsSchemaFingerprint: predictionFingerprint([varsSchema]),
    records: { 7: 'record-contract' },
  },
}
export const setup: PredictionSetup = {
  ...defaultPredictionSetup,
  recordIds: [7],
  models: { forward: reference },
  routes: {
    forward: { storageId: '11111111111111111111111111111111', launcherId: '10000000-0000-4000-8000-000000000003' },
  },
}
export const calculation = {
  id: 2,
  name: 'Temperature',
  experiment_record_ids: [7],
  contract_status: 'ready',
  source_code: 'return 15',
  source_hash: 'calculation-source',
  output_layout: { dtype: 'float64', shape: [], axes: [] },
} as unknown as SavedPredictionCalculation
export const context = {
  experimentId: 3,
  calculations: [],
  experimentRecords: [{ id: 7, name: 'heat.T', contract_hash: 'record-contract' }],
  measurements: [],
  fingerprint: 'contracts',
  analysis: { fingerprint: '', total: 0, measurement_count: 0, items: [] },
} as unknown as PredictionContext
export const model: PreparedPredictionModel = {
  fingerprint: reference.fingerprint,
  provenance,
  instance: { executionId: 'remote-knn', sessionId: 'session', generation: 1, handle: 'handle' },
  rules: [rule],
  errors: {},
  recordProfiles: [],
  profile: {
    direction: 'forward',
    rowCount: 2,
    inputLayouts: [],
    inputSize: 1,
    outputSize: 1,
    includedMeasurementIds: [1, 2],
    warningMeasurementIds: [],
    diagnostics: [],
    omittedDiagnosticGroups: 0,
    excluded: {
      'missing-block': 0,
      'extra-block': 0,
      'invalid-tensor': 0,
      'fixed-layout-mismatch': 0,
      'layout-mismatch': 0,
    },
  },
}
export function remoteFixture() {
  return {
    id: 'remote-knn',
    location: 'remote',
    sessionId: 'session',
    implementationVersion: 'knn-v1',
    preprocessingVersion: 'box-relative-v2',
    algorithms: ['knn'],
    directions: ['forward'],
    prepare: vi.fn(),
    load: vi.fn(async () => model),
    predict: vi.fn(async () => ({
      direction: 'forward' as const,
      fingerprint: reference.fingerprint,
      output: [sample],
      extrapolatedInputKeys: [],
      constantInputKeysChanged: [],
      queryDiagnostics: [],
      provenance,
    })),
    cancel: vi.fn(),
    release: vi.fn(async () => undefined),
    dispose: vi.fn(),
  } satisfies PredictionExecution
}
