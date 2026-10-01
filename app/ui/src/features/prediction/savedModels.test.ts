import { beforeEach, describe, expect, it } from 'vitest'
import type { PersistedCalculationRecord } from '@/api'
import type { SavedPredictionModel } from './execution'
import type { PredictionContext } from './predictionContextData'
import type { PredictionSetup } from './usePredictionModels'
import { assertSavedPredictionCompatible, savedContractFromSource, savedPredictionContract } from './savedModels'
import { persistPredictionSetup, restorePredictionSetup } from './setupPersistence'

const launcherId = '10000000-0000-4000-8000-000000000001'
const storageId = '10000000-0000-4000-8000-000000000002'
const varsSchema = { width: { shape: [], min: 0, max: 10 } }

function contextWith(calculation: Partial<PersistedCalculationRecord> = {}): PredictionContext {
  return {
    experimentId: 3,
    fingerprint: 'current-data',
    measurements: [],
    analysis: { fingerprint: 'current-analysis', total: 0, measurement_count: 0, items: [] },
    experimentRecords: [
      {
        id: 5,
        experiment_id: 3,
        name: 'Stress',
        quantity_kind: 'Pressure',
        tensor_order: 1,
        dtype: 'float64',
        contract_hash: 'record-contract',
      },
    ],
    calculations: [
      {
        id: 7,
        source_id: 2,
        experiment_id: 3,
        name: 'Average',
        revision: 1,
        source_code: 'return data',
        source_hash: 'calculation-source',
        contract_status: 'ready',
        calculation_data_count: 2,
        recorded_measurement_count: 2,
        measurement_count: 2,
        experiment_record_ids: [5],
        output_layout: { dtype: 'float64', shape: [2], axes: [{ name: 'frequency', ticks: [10, 20], unit: 'Hz' }] },
        ...calculation,
      },
    ],
  }
}

function savedModel(direction: 'forward' | 'inverse' = 'forward'): SavedPredictionModel {
  return {
    modelId: direction === 'forward' ? '20000000-0000-4000-8000-000000000001' : '20000000-0000-4000-8000-000000000002',
    modelRevision: direction === 'forward' ? 2 : 5,
    datasetId: '30000000-0000-4000-8000-000000000001',
    datasetRevision: 1,
    direction,
    fingerprint: `${direction}-fingerprint`,
    storageId,
    launcherId,
    manifestChecksum: 'a'.repeat(64),
    contract: savedPredictionContract(contextWith(), varsSchema),
  }
}

function setupWithModels(): PredictionSetup {
  return {
    executionId: 'remote-knn',
    launcherId,
    datasetId: '30000000-0000-4000-8000-000000000001',
    calculationIds: [7],
    algorithm: { kind: 'knn', kMode: 'manual', manualK: 2, weighting: 'distance', calculationWeights: { 7: 1 } },
    models: { forward: savedModel(), inverse: savedModel('inverse') },
  }
}

beforeEach(() => localStorage.clear())

describe('saved Prediction contracts', () => {
  it('accepts tick-coordinate changes while preserving ordinal tensor compatibility', () => {
    const context = contextWith({
      output_layout: { dtype: 'float64', shape: [2], axes: [{ name: 'frequency', ticks: [100, 300], unit: 'Hz' }] },
    })
    expect(() => assertSavedPredictionCompatible(savedModel(), context, varsSchema, [5], [7])).not.toThrow()
  })

  it('normalizes nullable metadata axis units to an omitted unit', () => {
    const context = contextWith({
      output_layout: { dtype: 'float64', shape: [2], axes: [{ name: 'index', ticks: [0, 1] }] },
    })
    const source = {
      experimentId: 3,
      varsSchema,
      records: context.experimentRecords,
      calculations: [
        {
          ...context.calculations[0],
          output_layout: { dtype: 'float64', shape: [2], axes: [{ name: 'index', length: 2, unit: null }] },
        },
      ],
    }
    expect(savedContractFromSource(source)).toEqual(savedPredictionContract(context, varsSchema))
  })

  it.each([
    { dtype: 'float32' as const, shape: [2], axes: [{ name: 'frequency', ticks: [10, 20], unit: 'Hz' }] },
    { dtype: 'float64' as const, shape: [3], axes: [{ name: 'frequency', ticks: [10, 20, 30], unit: 'Hz' }] },
    { dtype: 'float64' as const, shape: [2], axes: [{ name: 'time', ticks: [10, 20], unit: 'Hz' }] },
    { dtype: 'float64' as const, shape: [2], axes: [{ name: 'frequency', ticks: [10, 20], unit: 'kHz' }] },
  ])('rejects changed Calculation dtype, shape, name or unit: %j', (output_layout) => {
    expect(() =>
      assertSavedPredictionCompatible(savedModel(), contextWith({ output_layout }), varsSchema, [5], [7]),
    ).toThrow('Calculation #7')
  })

  it('rejects changed source, Record or Vars contracts', () => {
    expect(() =>
      assertSavedPredictionCompatible(savedModel(), contextWith({ source_hash: 'new-source' }), varsSchema, [5], [7]),
    ).toThrow('Calculation #7')
    const changedRecord = contextWith()
    expect(() =>
      assertSavedPredictionCompatible(
        savedModel(),
        {
          ...changedRecord,
          experimentRecords: [{ ...changedRecord.experimentRecords[0], contract_hash: 'new-record' }],
        },
        varsSchema,
        [5],
        [7],
      ),
    ).toThrow('Record #5')
    expect(() =>
      assertSavedPredictionCompatible(savedModel(), contextWith(), { width: { shape: [], min: 0, max: 20 } }, [5], [7]),
    ).toThrow('Vars')
  })

  it('requires the saved Inverse calculation selection', () => {
    expect(() => assertSavedPredictionCompatible(savedModel('inverse'), contextWith(), varsSchema, [5], [])).toThrow(
      'Inverse',
    )
  })
})

describe('saved Prediction setup persistence', () => {
  it('restores independent Forward and Inverse revisions with their contracts and checksums', () => {
    const setup = setupWithModels()
    persistPredictionSetup('owner-a', 3, setup)
    expect(restorePredictionSetup('owner-a', 3)).toEqual(setup)
    expect(restorePredictionSetup('owner-a', 3)?.models?.forward?.modelRevision).toBe(2)
    expect(restorePredictionSetup('owner-a', 3)?.models?.inverse?.modelRevision).toBe(5)
  })

  it('uses owner and Experiment scoped storage and rejects copied foreign setup envelopes', () => {
    persistPredictionSetup('owner-a', 3, setupWithModels())
    expect(restorePredictionSetup('owner-b', 3)).toBeNull()
    expect(restorePredictionSetup('owner-a', 4)).toBeNull()
    const saved = localStorage.getItem('caemble.prediction.setup:owner-a:3')!
    localStorage.setItem('caemble.prediction.setup:owner-b:3', saved)
    expect(restorePredictionSetup('owner-b', 3)).toBeNull()
  })

  it('persists references without live handles, session IDs or grants', () => {
    const setup = setupWithModels()
    const withRuntimeData = {
      ...setup,
      sessionId: 'private-session',
      grant: { token: 'private-token' },
      models: { ...setup.models, forward: { ...setup.models!.forward!, handle: 'private-handle', generation: 42 } },
    }
    persistPredictionSetup('owner-a', 3, withRuntimeData)
    const stored = localStorage.getItem('caemble.prediction.setup:owner-a:3')!
    expect(stored).not.toContain('private-')
    expect(stored).not.toContain('generation')
    expect(restorePredictionSetup('owner-a', 3)).toEqual(setup)
  })

  it('rejects a saved Model bound to another launcher or Experiment', () => {
    for (const forward of [
      { ...savedModel(), launcherId: '40000000-0000-4000-8000-000000000001' },
      { ...savedModel(), contract: { ...savedModel().contract!, experimentId: 4 } },
    ]) {
      persistPredictionSetup('owner-a', 3, { ...setupWithModels(), models: { forward } })
      expect(restorePredictionSetup('owner-a', 3)).toBeNull()
    }
  })
})
