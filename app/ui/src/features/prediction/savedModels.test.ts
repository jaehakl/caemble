import { beforeEach, describe, expect, it } from 'vitest'
import type { SavedPredictionModel } from './execution'
import type { PredictionContext } from './predictionContextData'
import { predictionSetupFingerprint, type PredictionSetup } from './usePredictionModels'
import { assertSavedPredictionCompatible, savedContractFromSource, savedPredictionContract } from './savedModels'
import { persistPredictionSetup, restorePredictionSetup } from './setupPersistence'

const launcherId = '10000000-0000-4000-8000-000000000001'
const storageId = '10000000-0000-4000-8000-000000000002'
const varsSchema = { width: { shape: [], min: 0, max: 10 } }
const context = {
  experimentId: 3,
  calculations: [],
  experimentRecords: [{ id: 5, name: 'Stress', contract_hash: 'record-contract' }],
} as unknown as PredictionContext
function savedModel(): SavedPredictionModel {
  return {
    modelId: '20000000-0000-4000-8000-000000000001',
    modelRevision: 2,
    datasetId: '30000000-0000-4000-8000-000000000001',
    datasetRevision: 1,
    direction: 'forward',
    fingerprint: 'forward-fingerprint',
    manifestChecksum: 'a'.repeat(64),
    contract: savedPredictionContract(context, varsSchema),
  }
}
function setupWithModel(): PredictionSetup {
  return {
    executionId: 'remote-knn',
    recordIds: [5],
    calculationIds: [],
    routes: { forward: { storageId, launcherId } },
    datasetId: '30000000-0000-4000-8000-000000000001',
    algorithm: { kind: 'knn', kMode: 'manual', manualK: 2, weighting: 'distance' },
    models: { forward: savedModel() },
  }
}
beforeEach(() => localStorage.clear())

describe('Forward saved contracts', () => {
  it('accepts metadata without Calculations and ignores legacy Calculation contracts', () => {
    const source = { experimentId: 3, varsSchema, records: context.experimentRecords }
    expect(savedContractFromSource(source)).toEqual(savedPredictionContract(context, varsSchema))
    expect(savedContractFromSource({ ...source, calculations: [{ unsupportedLegacy: true }] })).toEqual(
      savedContractFromSource(source),
    )
    expect(() => assertSavedPredictionCompatible(savedModel(), context, varsSchema, [5])).not.toThrow()
  })
  it('rejects changed selected Record, missing output and Vars contracts', () => {
    expect(() =>
      assertSavedPredictionCompatible(
        savedModel(),
        {
          ...context,
          experimentRecords: [{ ...context.experimentRecords[0], contract_hash: 'changed' }],
        },
        varsSchema,
        [5],
      ),
    ).toThrow('Record #5')
    expect(() => assertSavedPredictionCompatible(savedModel(), context, varsSchema, [6])).toThrow('Record #6')
    expect(() =>
      assertSavedPredictionCompatible(savedModel(), context, { width: { shape: [], min: 0, max: 20 } }, [5]),
    ).toThrow('Vars')
  })
})

describe('Forward setup persistence', () => {
  it('restores exact revisions and opaque migrated storage/replica IDs without a live handle', () => {
    const setup = {
      ...setupWithModel(),
      routes: {
        forward: {
          replicaId: '5b42b8de-3de3-b05d-ea6f-1274e1a2a93a',
          storageId: 'da148b6d-bf41-e61f-cd2f-123456789abc',
          launcherId,
        },
      },
    }
    const input = {
      ...setup,
      sessionId: 'private-session',
      grant: { token: 'private-token' },
      models: { forward: { ...setup.models!.forward!, handle: 'private-handle', generation: 42 } },
    }
    persistPredictionSetup('owner-a', 3, input)
    expect(restorePredictionSetup('owner-a', 3)).toEqual(setup)
    const stored = localStorage.getItem('caemble.prediction.setup:owner-a:3')!
    expect(stored).not.toContain('private-')
    expect(stored).not.toContain('generation')
    expect(JSON.parse(stored).version).toBe(3)
  })
  it.each([1, 2])(
    'migrates v%s Forward references and drops browser/Inverse settings without touching assets',
    (version) => {
      const expected = setupWithModel()
      const forward = { ...savedModel(), contract: { ...savedModel().contract, calculations: { 7: 'legacy' } } }
      const old = {
        ...expected,
        executionId: 'browser-knn',
        recordIds: undefined,
        algorithm: { ...expected.algorithm, calculationWeights: { 7: 2 } },
        models: {
          forward: version === 1 ? { ...forward, storageId, launcherId } : forward,
          inverse: { unsupported: 'preserved in server assets only' },
        },
        routes: version === 1 ? undefined : { ...expected.routes, inverse: { storageId, launcherId } },
      }
      localStorage.setItem(
        'caemble.prediction.setup:owner-a:3',
        JSON.stringify({ version, owner: 'owner-a', experimentId: 3, setup: old }),
      )
      expect(restorePredictionSetup('owner-a', 3)).toEqual(expected)
      const written = JSON.parse(localStorage.getItem('caemble.prediction.setup:owner-a:3')!)
      expect(written.version).toBe(3)
      expect(written.setup.models).not.toHaveProperty('inverse')
      expect(written.setup.algorithm).not.toHaveProperty('calculationWeights')
    },
  )
  it('migrates an Inverse-only setup to an unselected remote setup', () => {
    localStorage.setItem(
      'caemble.prediction.setup:owner-a:3',
      JSON.stringify({
        version: 2,
        owner: 'owner-a',
        experimentId: 3,
        setup: {
          ...setupWithModel(),
          models: { inverse: { direction: 'inverse' } },
          recordIds: undefined,
        },
      }),
    )
    expect(restorePredictionSetup('owner-a', 3)).toMatchObject({ executionId: 'remote-knn', recordIds: [], models: {} })
  })
  it.each(['replicaId', 'storageId', 'launcherId'] as const)('rejects malformed persisted route %s', (field) => {
    localStorage.setItem(
      'caemble.prediction.setup:owner-a:3',
      JSON.stringify({
        version: 3,
        owner: 'owner-a',
        experimentId: 3,
        setup: { ...setupWithModel(), routes: { forward: { storageId, launcherId, [field]: 'not-an-id' } } },
      }),
    )
    expect(restorePredictionSetup('owner-a', 3)).toBeNull()
  })
  it('isolates owner and Experiment and rejects foreign model context', () => {
    persistPredictionSetup('owner-a', 3, setupWithModel())
    expect(restorePredictionSetup('owner-b', 3)).toBeNull()
    localStorage.setItem(
      'caemble.prediction.setup:owner-b:3',
      localStorage.getItem('caemble.prediction.setup:owner-a:3')!,
    )
    expect(restorePredictionSetup('owner-b', 3)).toBeNull()
    persistPredictionSetup('owner-a', 3, {
      ...setupWithModel(),
      models: {
        forward: { ...savedModel(), contract: { ...savedModel().contract!, experimentId: 4 } },
      },
    })
    expect(restorePredictionSetup('owner-a', 3)).toBeNull()
  })
  it('keeps routes, Calculation choices and new-model settings out of loaded model meaning', () => {
    const setup = setupWithModel()
    expect(
      predictionSetupFingerprint({
        ...setup,
        calculationIds: [7],
        routes: { forward: { storageId, launcherId: '40000000-0000-4000-8000-000000000001' } },
        algorithm: { ...setup.algorithm, manualK: 8 },
      }),
    ).toBe(predictionSetupFingerprint(setup))
    expect(
      predictionSetupFingerprint({ ...setup, models: { forward: { ...savedModel(), modelRevision: 10 } } }),
    ).not.toBe(predictionSetupFingerprint(setup))
  })
})
