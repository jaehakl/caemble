import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dbTables, type PersistedMeasurementRecord, type PersistedRecordedDataRecord } from '@/api'
import { BOX_GRID_AXES, type BoxGridData } from '@/contracts/boxGrid'
import { createDataTensor } from '@/lib/cad/model/dataTensor'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import type { RecordedDataRule } from '@/lib/cad/model'
import { browserPredictionTrainingPolicy } from './browserTrainingPolicy'
import {
  calculationOutputSample,
  inverseTrainingRows,
  predictionRecordedRowSample,
  predictionVarsLayouts,
  predictionVarsSamples,
} from './data'
import {
  PredictionInstanceInvalidatedError,
  type PredictionAlgorithm,
  type PredictionExecution,
  type PredictionExecutionResult,
  type PredictionInput,
  type PredictionModelDefinition,
  type PredictionModelInstance,
  type PredictionRequest,
  type PreparedPredictionModel,
} from './execution'
import { buildPredictionKnnModel, predictWithKnn, type PredictionDirection, type PredictionKnnModel } from './knn'
import type { PredictionContext } from './predictionContextData'
import { createTrainingSnapshot, loadTrainingSnapshot, type TrainingSnapshot } from './trainingSnapshot'
import { PredictionRuntimeController } from './usePredictionController'

const algorithm: PredictionAlgorithm = {
  kind: 'knn',
  kMode: 'manual',
  manualK: 2,
  weighting: 'uniform',
  calculationWeights: {},
}
const runtimes: PredictionRuntimeController[] = []

beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose())
  vi.unstubAllGlobals()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function snapshotFixture(direction: PredictionDirection = 'forward') {
  const varsSchema = { x: { shape: [], min: 0, max: 10 } }
  const measurements = [0, 10].map((x, index) => ({
    id: index + 1,
    experiment_id: 3,
    vars: { x },
    recorded_at: '2026-01-01',
    calculation_data_count: 1,
    material_snapshot: {} as PersistedMeasurementRecord['material_snapshot'],
  }))
  const common = { experimentId: 3, sourceFingerprint: 'source-v1', measurements, varsSchema }
  const calculation = {
    id: 9,
    source_id: 9,
    revision: 1,
    experiment_id: 3,
    name: 'maximum',
    source_code: 'return 1',
    contract_status: 'ready' as const,
    experiment_record_ids: [7],
    calculation_data_count: 2,
    recorded_measurement_count: 2,
    measurement_count: 2,
  }
  if (direction === 'inverse')
    return createTrainingSnapshot({
      ...common,
      direction,
      calculations: [calculation],
      calculationData: measurements.map((measurement) => ({
        id: 20 + measurement.id,
        measurement_id: measurement.id,
        calculation_id: 9,
        data: { dtype: 'float64', shape: [], axes: [], data: measurement.vars.x * 2 },
      })),
    })
  const record = {
    id: 7,
    experiment_id: 3,
    name: 'temperature',
    quantity_kind: null,
    dtype: 'float64',
    tensor_order: 0,
    contract_hash: 'contract-v1',
  }
  const rules: RecordedDataRule[] = []
  const recorded = measurements.map((measurement): PersistedRecordedDataRecord => {
    const boxGrid: BoxGridData = {
      version: 1,
      sampling: 'point',
      components: ['scalar'],
      channels: ['value'],
      channelUnits: ['K'],
      origin: [measurement.vars.x, 0, 0],
      size: [1, 1, 1],
      rotation: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      gridShape: [1, 1, 1],
      lengthUnit: 'm',
      source: 'experiment',
      rootId: 'box',
    }
    const axes = BOX_GRID_AXES.map((name, index) => ({
      name,
      ticks: index === 5 ? ['value'] : index === 6 ? ['scalar'] : [index === 0 ? measurement.vars.x + 0.5 : 0],
    }))
    const rule: RecordedDataRule = {
      label: 'temperature',
      target: [],
      methodId: 'fixture',
      parameters: {},
      result: { dtype: 'float64', axes, boxGrid, unit: 'K', quantityKind: 'thermodynamics.Temperature' },
    }
    if (!rules.length) rules.push(rule)
    return {
      id: 10 + measurement.id,
      measurement_id: measurement.id,
      experiment_record_id: 7,
      name: 'temperature',
      quantity_kind: null,
      dtype: 'float64',
      tensor_order: 0,
      data_schema: rule.result,
      data: createDataTensor(rule.result, {
        value: varsTensorFromFlat([measurement.vars.x * 2], [1, 1, 1, 1, 1, 1, 1]),
        boxGrid,
        axes: axes.map((axis) => ({ ticks: axis.ticks })),
      }),
    }
  })
  return createTrainingSnapshot({ ...common, direction, records: [record], recorded, rules, resultContracts: {} })
}

/** No Worker, WebRTC, browser capacity policy, or mandatory kNN diagnostics. */
class RemoteKnnExecution implements PredictionExecution {
  readonly location = 'remote'
  id = 'remote.knn.test'
  sessionId = 'remote-session-1'
  implementationVersion = '1'
  preprocessingVersion = '1'
  algorithms: readonly PredictionAlgorithm['kind'][] = ['knn']
  directions: readonly PredictionDirection[] = ['forward', 'inverse']
  preparationGate: Promise<void> | null = null
  predictionGate: Promise<void> | null = null
  readonly prepared: PreparedPredictionModel[] = []
  private generation = 0
  private readonly models = new Map<string, { model: PredictionKnnModel; snapshot: TrainingSnapshot }>()

  prepare = vi.fn(
    async (snapshot: TrainingSnapshot, definition: PredictionModelDefinition, _request: PredictionRequest) => {
      const gate = this.preparationGate
      const rows =
        snapshot.direction === 'forward'
          ? snapshot.measurements.map((measurement) => ({
              measurementId: measurement.id,
              inputs: predictionVarsSamples(measurement.vars as Record<string, number>, snapshot.varsSchema),
              outputs: snapshot.recorded
                .filter((row) => row.measurement_id === measurement.id)
                .map(predictionRecordedRowSample),
            }))
          : inverseTrainingRows(
              snapshot.measurements,
              snapshot.calculationData,
              snapshot.calculations.map((calculation) => calculation.id),
              snapshot.varsSchema,
            )
      const model = buildPredictionKnnModel({
        direction: snapshot.direction,
        fingerprint: definition.fingerprint,
        rows,
        inputKeys: rows[0].inputs.map((sample) => sample.layout.key),
        outputKeys: rows[0].outputs.map((sample) => sample.layout.key),
        k: definition.algorithm.manualK,
        weighting: definition.algorithm.weighting,
        inputScaling: snapshot.direction === 'forward' ? 'range' : 'standard-deviation',
        diagnoseMetadata: false,
        ...(snapshot.direction === 'forward'
          ? { fixedInputLayouts: predictionVarsLayouts(snapshot.varsSchema) }
          : { fixedOutputLayouts: predictionVarsLayouts(snapshot.varsSchema) }),
      })
      const instance = {
        executionId: this.id,
        sessionId: this.sessionId,
        generation: ++this.generation,
        handle: `remote-model-${this.generation}`,
      }
      const prepared: PreparedPredictionModel = {
        fingerprint: definition.fingerprint,
        instance,
        profile: {
          direction: snapshot.direction,
          rowCount: model.rowCount,
          inputLayouts: model.inputLayouts,
          inputSize: model.inputSize,
          outputSize: model.outputSize,
          includedMeasurementIds: model.cohort.includedMeasurementIds,
          warningMeasurementIds: model.cohort.warningMeasurementIds,
          diagnostics: model.cohort.diagnostics,
          omittedDiagnosticGroups: model.cohort.omittedDiagnosticGroups,
          excluded: model.cohort.excluded,
        },
        errors: {},
        recordProfiles: [],
        rules: snapshot.direction === 'forward' ? snapshot.rules : [],
      }
      this.models.set(instance.handle, { model, snapshot })
      this.prepared.push(prepared)
      if (gate) await gate
      return prepared
    },
  )

  predict = vi.fn(
    async (
      instance: PredictionModelInstance,
      input: PredictionInput,
      _request: PredictionRequest,
    ): Promise<PredictionExecutionResult> => {
      const stored = this.models.get(instance.handle)
      if (!stored) throw new PredictionInstanceInvalidatedError('Remote model was released.')
      const query =
        input.direction === 'forward'
          ? predictionVarsSamples(input.vars, stored.snapshot.varsSchema)
          : Object.entries(input.targets).map(([id, output]) => calculationOutputSample(Number(id), output))
      const result = predictWithKnn(stored.model, query)
      if (this.predictionGate) await this.predictionGate
      return {
        direction: result.direction,
        fingerprint: result.fingerprint,
        output: result.output,
        extrapolatedInputKeys: result.extrapolatedInputKeys,
        constantInputKeysChanged: result.constantInputKeysChanged,
        queryDiagnostics: result.queryDiagnostics,
      }
    },
  )

  cancel = vi.fn((_requestId: string) => undefined)
  release = vi.fn(async (instance: PredictionModelInstance) => {
    this.models.delete(instance.handle)
  })
  dispose = vi.fn(() => {
    this.models.clear()
  })
}

function runtimeFixture() {
  const remote = new RemoteKnnExecution()
  const runtime = new PredictionRuntimeController(() => remote)
  runtimes.push(runtime)
  runtime.start()
  const transaction = runtime.beginTransaction()
  return { remote, runtime, transaction }
}

describe('Prediction execution boundary', () => {
  it.each(['forward', 'inverse'] as const)(
    'runs %s kNN remotely with optional kNN result fields omitted',
    async (direction) => {
      const { remote, runtime, transaction } = runtimeFixture()
      const snapshot = await snapshotFixture(direction)
      const prepared = await runtime.prepareModel(snapshot, algorithm, transaction, remote.id)
      const input: PredictionInput =
        direction === 'forward'
          ? { direction, vars: { x: 5 } }
          : { direction, targets: { 9: { dtype: 'float64', shape: [], axes: [], data: 10 } } }
      const result = await runtime.predict(prepared, input, transaction)
      expect(result.output[0].values).toEqual([direction === 'forward' ? 10 : 5])
      expect(result.knn).toBeUndefined()
      expect(prepared.profile.knn).toBeUndefined()
      expect(prepared.profile.rowCount).toBe(2)
      expect(remote.prepare.mock.calls[0][0]).toBe(snapshot)
      expect(remote.prepare.mock.calls[0][1].algorithm.kind).toBe('knn')
      expect(remote.prepare.mock.calls[0][2].signal).toBe(runtime.transactionSignal())
    },
  )

  it('reuses snapshot and model across requests while releasing instances independently', async () => {
    const { remote, runtime, transaction } = runtimeFixture()
    const snapshot = await snapshotFixture()
    const load = vi.fn().mockResolvedValue(snapshot)
    expect(await runtime.trainingSnapshot('forward', 'selection', load, transaction)).toBe(snapshot)
    expect(await runtime.trainingSnapshot('forward', 'selection', load, transaction)).toBe(snapshot)
    const first = await runtime.prepareModel(snapshot, algorithm, transaction, remote.id)
    const nextTransaction = runtime.beginTransaction()
    expect(await runtime.prepareModel(snapshot, algorithm, nextTransaction, remote.id)).toBe(first)
    expect(remote.prepare).toHaveBeenCalledOnce()
    runtime.clearModelCaches()
    expect(remote.release).toHaveBeenCalledExactlyOnceWith(first.instance)
    expect(runtime.modelIsCurrent(first)).toBe(false)
    expect(await runtime.trainingSnapshot('forward', 'selection', load, nextTransaction)).toBe(snapshot)
    expect(load).toHaveBeenCalledOnce()
    runtime.clearTrainingSnapshots()
    await runtime.trainingSnapshot('forward', 'selection', load, nextTransaction)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it.each(['algorithm', 'snapshot', 'implementation', 'preprocessing'] as const)(
    'prepares a new model when %s meaning changes',
    async (change) => {
      const { remote, runtime, transaction } = runtimeFixture()
      const snapshot = await snapshotFixture()
      const first = await runtime.prepareModel(snapshot, algorithm, transaction, remote.id)
      if (change === 'implementation') remote.implementationVersion = '2'
      if (change === 'preprocessing') remote.preprocessingVersion = '2'
      const second = await runtime.prepareModel(
        change === 'snapshot' ? { ...snapshot, fingerprint: 'different-content' } : snapshot,
        change === 'algorithm' ? { ...algorithm, manualK: 1 } : algorithm,
        transaction,
        remote.id,
      )
      expect(second.fingerprint).not.toBe(first.fingerprint)
      expect(second.instance.handle).not.toBe(first.instance.handle)
      expect(remote.release).toHaveBeenCalledExactlyOnceWith(first.instance)
      expect(remote.prepare).toHaveBeenCalledTimes(2)
    },
  )

  it('recreates an instance after a session changes while retaining the same model definition', async () => {
    const { remote, runtime, transaction } = runtimeFixture()
    const snapshot = await snapshotFixture()
    const first = await runtime.prepareModel(snapshot, algorithm, transaction, remote.id)
    remote.sessionId = 'remote-session-2'
    expect(runtime.modelIsCurrent(first)).toBe(false)
    const second = await runtime.prepareModel(snapshot, algorithm, transaction, remote.id)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.instance.sessionId).not.toBe(first.instance.sessionId)
    expect(remote.prepare).toHaveBeenCalledTimes(2)
  })

  it('settles canceled preparation immediately and releases an eventual late model', async () => {
    const { remote, runtime, transaction } = runtimeFixture()
    const gate = deferred()
    remote.preparationGate = gate.promise
    const pending = runtime.prepareModel(await snapshotFixture(), algorithm, transaction, remote.id)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(remote.prepare).toHaveBeenCalledOnce())
    runtime.invalidateTransaction()
    await rejected
    expect(remote.cancel).toHaveBeenCalledWith(remote.prepare.mock.calls[0][2].requestId)
    gate.resolve()
    await vi.waitFor(() => expect(remote.release).toHaveBeenCalledExactlyOnceWith(remote.prepared[0].instance))
    expect(runtime.cachedForwardModel()).toBeUndefined()
    expect(runtime.cancelPendingPrediction()).toBe(false)
  })

  it('releases a late preparation after switching execution without touching the new execution', async () => {
    const { remote, runtime, transaction } = runtimeFixture()
    const gate = deferred()
    remote.preparationGate = gate.promise
    const snapshot = await snapshotFixture()
    const old = runtime.prepareModel(snapshot, algorithm, transaction, remote.id)
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(remote.prepare).toHaveBeenCalledOnce())
    const replacement = new RemoteKnnExecution()
    replacement.id = 'remote.replacement'
    runtime.setExecution(() => replacement)
    await rejected
    const current = await runtime.prepareModel(snapshot, algorithm, runtime.beginTransaction(), replacement.id)
    gate.resolve()
    await vi.waitFor(() => expect(remote.release).toHaveBeenCalledOnce())
    expect(runtime.cachedForwardModel()).toBe(current)
    expect(replacement.release).not.toHaveBeenCalled()
    expect(remote.dispose).toHaveBeenCalledOnce()
  })

  it.each(['cancel', 'release', 'session', 'switch'] as const)(
    'blocks a delayed prediction after %s',
    async (change) => {
      const { remote, runtime, transaction } = runtimeFixture()
      const model = await runtime.prepareModel(await snapshotFixture(), algorithm, transaction, remote.id)
      const gate = deferred()
      remote.predictionGate = gate.promise
      const pending = runtime.predict(model, { direction: 'forward', vars: { x: 5 } }, transaction)
      const rejected = expect(pending).rejects.toMatchObject({
        name: change === 'session' ? 'PredictionInstanceInvalidatedError' : 'AbortError',
      })
      await vi.waitFor(() => expect(remote.predict).toHaveBeenCalledOnce())
      if (change === 'cancel') runtime.invalidateTransaction()
      if (change === 'release') runtime.clearModelCaches()
      if (change === 'session') remote.sessionId = 'replacement-session'
      if (change === 'switch') runtime.setExecution(() => new RemoteKnnExecution())
      gate.resolve()
      await rejected
      expect(runtime.cancelPendingPrediction()).toBe(false)
    },
  )

  it('prevents an older preparation from replacing a newer one in the same transaction', async () => {
    const { remote, runtime, transaction } = runtimeFixture()
    const gate = deferred()
    remote.preparationGate = gate.promise
    const snapshot = await snapshotFixture()
    const older = runtime.prepareModel(snapshot, algorithm, transaction, remote.id)
    const rejected = expect(older).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(remote.prepare).toHaveBeenCalledOnce())
    remote.preparationGate = null
    const newer = await runtime.prepareModel(snapshot, { ...algorithm, manualK: 1 }, transaction, remote.id)
    gate.resolve()
    await rejected
    expect(runtime.cachedForwardModel()).toBe(newer)
    expect(remote.release).toHaveBeenCalledExactlyOnceWith(remote.prepared[0].instance)
  })

  it('does not reinstall a model that finishes after model caches were cleared', async () => {
    const { remote, runtime, transaction } = runtimeFixture()
    const gate = deferred()
    remote.preparationGate = gate.promise
    const pending = runtime.prepareModel(await snapshotFixture(), algorithm, transaction, remote.id)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(remote.prepare).toHaveBeenCalledOnce())
    runtime.clearModelCaches()
    gate.resolve()
    await rejected
    expect(runtime.cachedForwardModel()).toBeUndefined()
    expect(remote.release).toHaveBeenCalledExactlyOnceWith(remote.prepared[0].instance)
  })

  it('rejects unsupported algorithm, direction, and execution combinations before transport', async () => {
    const { remote, runtime, transaction } = runtimeFixture()
    const snapshot = await snapshotFixture()
    await expect(runtime.prepareModel(snapshot, algorithm, transaction, 'unavailable')).rejects.toThrow('조합')
    remote.algorithms = []
    await expect(runtime.prepareModel(snapshot, algorithm, transaction, remote.id)).rejects.toThrow('조합')
    remote.algorithms = ['knn']
    remote.directions = ['inverse']
    await expect(runtime.prepareModel(snapshot, algorithm, transaction, remote.id)).rejects.toThrow('조합')
    expect(remote.prepare).not.toHaveBeenCalled()
  })

  it('lets remote input capture exceed browser policy using compact object references', async () => {
    const { runtime } = runtimeFixture()
    const snapshot = await snapshotFixture()
    if (snapshot.direction !== 'forward') throw new Error('Expected forward fixture')
    const largeRecord: PersistedRecordedDataRecord = {
      ...snapshot.recorded[0],
      id: 11,
      data: {
        shape: [10_000_001, 1, 1, 1, 1, 1, 1],
        storage: {
          kind: 'inline',
          value: {
            kind: 'caemble.object',
            version: 1,
            id: 'large',
            encoding: 'json',
            sha256: 'a'.repeat(64),
            byteLength: 80_000_008,
          },
        },
      },
    }
    const context: PredictionContext = {
      experimentId: 3,
      fingerprint: 'source-v1',
      measurements: snapshot.measurements,
      experimentRecords: snapshot.records,
      calculations: [],
      analysis: { fingerprint: 'empty', total: 0, measurement_count: 0, items: [] },
    }
    vi.spyOn(dbTables.RecordedData, 'listRows').mockResolvedValue({ total: 1, items: [largeRecord] })
    const options = {
      context,
      experimentId: 3,
      direction: 'forward' as const,
      varsSchema: snapshot.varsSchema,
      requiredRecordIds: [7],
    }
    expect(runtime.trainingPolicy).toBeUndefined()
    await expect(loadTrainingSnapshot({ ...options, policy: runtime.trainingPolicy })).resolves.toMatchObject({
      direction: 'forward',
    })
    await expect(loadTrainingSnapshot({ ...options, policy: browserPredictionTrainingPolicy })).rejects.toThrow('제한')
  })

  it('does not cache a snapshot that finishes after its transaction is superseded', async () => {
    const { runtime, transaction } = runtimeFixture()
    const snapshot = await snapshotFixture()
    const gate = deferred()
    const load = vi.fn(async () => {
      await gate.promise
      return snapshot
    })
    const pending = runtime.trainingSnapshot('forward', 'selection', load, transaction)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const current = runtime.beginTransaction()
    gate.resolve()
    await rejected
    await runtime.trainingSnapshot('forward', 'selection', load, current)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('propagates remote failures and allows a fresh preparation', async () => {
    const { remote, runtime, transaction } = runtimeFixture()
    const snapshot = await snapshotFixture()
    remote.prepare.mockRejectedValueOnce(new Error('Remote unavailable'))
    await expect(runtime.prepareModel(snapshot, algorithm, transaction, remote.id)).rejects.toThrow(
      'Remote unavailable',
    )
    expect(runtime.cachedForwardModel()).toBeUndefined()
    const model = await runtime.prepareModel(snapshot, algorithm, transaction, remote.id)
    remote.predict.mockRejectedValueOnce(new Error('Connection lost'))
    await expect(runtime.predict(model, { direction: 'forward', vars: { x: 5 } }, transaction)).rejects.toThrow(
      'Connection lost',
    )
    expect(runtime.cancelPendingPrediction()).toBe(false)
  })
})
