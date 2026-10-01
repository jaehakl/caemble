import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  PredictionInstanceInvalidatedError,
  type PredictionExecution,
  type PreparedPredictionModel,
  type SavedPredictionModel,
} from './execution'
import { PredictionRuntimeController, usePredictionController } from './usePredictionController'

const savedReference: SavedPredictionModel = {
  modelId: 'model-a',
  modelRevision: 1,
  datasetId: 'dataset-a',
  datasetRevision: 2,
  direction: 'forward',
  fingerprint: 'same-content',
}

function savedExecution() {
  let loaded = 0
  const execution: PredictionExecution = {
    id: 'remote-knn',
    location: 'remote',
    sessionId: 'session',
    implementationVersion: 'test',
    preprocessingVersion: 'test',
    algorithms: ['knn'],
    directions: ['forward', 'inverse'],
    prepare: vi.fn(),
    predict: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
    release: vi.fn(async () => undefined),
    load: vi.fn(async (reference): Promise<PreparedPredictionModel> => ({
      fingerprint: reference.fingerprint,
      provenance: {
        modelId: reference.modelId,
        modelRevision: reference.modelRevision,
        datasetId: reference.datasetId,
        datasetRevision: reference.datasetRevision,
      },
      instance: { executionId: 'remote-knn', sessionId: 'session', generation: 1, handle: `loaded-${++loaded}` },
      profile: {
        direction: reference.direction,
        rowCount: 1,
        inputLayouts: [],
        inputSize: 1,
        outputSize: 1,
        includedMeasurementIds: [1],
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
      errors: {},
      recordProfiles: [],
      rules: [],
    })),
  }
  const runtime = new PredictionRuntimeController(() => execution)
  runtime.start()
  return { execution, runtime }
}

it('observes lifecycle transitions synchronously and blocks duplicate work before rendering', () => {
  const start = vi.spyOn(PredictionRuntimeController.prototype, 'start').mockImplementation(() => undefined)
  const { result, unmount } = renderHook(() => usePredictionController())
  const run = vi.fn()
  const beginValidation = () => {
    if (result.current.lifecycleRef.current.operation !== 'idle') return
    result.current.startOperation('validation', 'validating')
    run()
  }

  act(() => {
    beginValidation()
    beginValidation()
    expect(result.current.lifecycleRef.current.operation).toBe('validation')
  })
  expect(run).toHaveBeenCalledOnce()
  expect(result.current).toMatchObject({ busy: true, validating: true, retryingValidation: false })

  act(() => {
    result.current.startOperation('validation-retry', 'retrying')
    result.current.setDataStale(true)
    result.current.setFreshnessPending(false)
  })
  expect(result.current).toMatchObject({ busy: true, validating: true, retryingValidation: true })
  expect(result.current.lifecycleRef.current).toEqual(result.current.lifecycle)
  act(() => result.current.cancelLifecycle({ dataStale: true, freshnessPending: false }))
  expect(result.current).toMatchObject({ busy: false, validating: false, retryingValidation: false })
  expect(result.current.lifecycleRef.current).toEqual(result.current.lifecycle)
  unmount()
  start.mockRestore()
})

describe('PredictionRuntimeController', () => {
  it('loads the selected Model identity and revision even when content fingerprints match', async () => {
    const { execution, runtime } = savedExecution()
    const transaction = runtime.beginTransaction()
    const first = await runtime.loadModel(savedReference, transaction)
    expect(await runtime.loadModel(savedReference, transaction)).toBe(first)
    const anotherModel = { ...savedReference, modelId: 'model-b' }
    const second = await runtime.loadModel(anotherModel, transaction)
    const anotherRevision = { ...anotherModel, modelRevision: 2 }
    const third = await runtime.loadModel(anotherRevision, transaction)
    expect(second.provenance?.modelId).toBe('model-b')
    expect(third.provenance?.modelRevision).toBe(2)
    expect(await runtime.loadModel(anotherRevision, transaction)).toBe(third)
    expect(execution.load).toHaveBeenCalledTimes(3)
    expect(execution.release).toHaveBeenNthCalledWith(1, first.instance)
    expect(execution.release).toHaveBeenNthCalledWith(2, second.instance)
    expect(runtime.modelIsCurrent(first)).toBe(false)
    expect(runtime.cachedForwardModel()).toBe(third)
    runtime.dispose()
  })

  it('awaits both Forward and Inverse release acknowledgements before allowing delete intent', async () => {
    const { execution, runtime } = savedExecution()
    const transaction = runtime.beginTransaction()
    const forward = await runtime.loadModel(savedReference, transaction)
    const inverse = await runtime.loadModel(
      { ...savedReference, direction: 'inverse', modelId: 'inverse-model' },
      transaction,
    )
    const acknowledgements: Array<() => void> = []
    vi.mocked(execution.release).mockImplementation(
      () => new Promise<void>((resolve) => acknowledgements.push(resolve)),
    )
    const deleteIntent = vi.fn()
    const deletion = runtime.releaseLoadedModels().then(() => {
      runtime.cancelCurrent({ cancelCalculationData: vi.fn(), cancelMeasurement: vi.fn(), samplingActive: false })
      deleteIntent()
    })
    expect(execution.release).toHaveBeenCalledWith(forward.instance)
    expect(execution.release).toHaveBeenCalledWith(inverse.instance)
    expect(runtime.transactionIsCurrent(transaction)).toBe(false)
    expect(runtime.cachedModel('forward')).toBeUndefined()
    expect(runtime.cachedModel('inverse')).toBeUndefined()
    expect(deleteIntent).not.toHaveBeenCalled()
    acknowledgements[0]()
    await Promise.resolve()
    expect(deleteIntent).not.toHaveBeenCalled()
    acknowledgements[1]()
    await deletion
    expect(deleteIntent).toHaveBeenCalledOnce()
    runtime.dispose()
  })

  it('does not start delete intent when a loaded Model release fails', async () => {
    const { execution, runtime } = savedExecution()
    await runtime.loadModel(savedReference, runtime.beginTransaction())
    vi.mocked(execution.release).mockRejectedValueOnce(new Error('release acknowledgement unavailable'))
    const deleteIntent = vi.fn()
    await expect(runtime.releaseLoadedModels().then(deleteIntent)).rejects.toThrow(
      'release acknowledgement unavailable',
    )
    expect(deleteIntent).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('invalidates every in-flight revision and releases owned resources on cancel', () => {
    const runtime = new PredictionRuntimeController()
    const load = runtime.beginLoad()
    const transaction = runtime.beginTransaction()
    const validation = runtime.beginValidation()
    const sampling = runtime.beginSampling()
    const calculation = runtime.beginCalculation()
    runtime.nextFingerprintCheck()
    const loadSignal = runtime.loadSignal()
    const transactionSignal = runtime.transactionSignal()
    const validationSignal = runtime.validationSignal()
    const fingerprintSignal = runtime.fingerprintSignal()
    const cancelCandidateWait = vi.fn()
    const cancelCalculationData = vi.fn()
    const cancelMeasurement = vi.fn()
    runtime.setSamplingCandidateWait(cancelCandidateWait)
    runtime.setCalculationDataOperationOwned(true)

    const outcome = runtime.cancelCurrent({
      cancelCalculationData,
      cancelMeasurement,
      samplingActive: true,
    })

    expect(outcome).toEqual({ modelsCleared: true, samplingActive: true, validationActive: true })
    expect(runtime.loadIsCurrent(load)).toBe(false)
    expect(runtime.transactionIsCurrent(transaction)).toBe(false)
    expect(runtime.validationIsCurrent(validation)).toBe(false)
    expect(runtime.samplingIsCurrent(sampling)).toBe(false)
    expect(calculation.signal.aborted).toBe(true)
    expect(loadSignal?.aborted).toBe(true)
    expect(transactionSignal?.aborted).toBe(true)
    expect(validationSignal?.aborted).toBe(true)
    expect(fingerprintSignal?.aborted).toBe(true)
    expect(cancelCandidateWait).toHaveBeenCalledOnce()
    expect(cancelCalculationData).toHaveBeenCalledOnce()
    expect(cancelMeasurement).toHaveBeenCalledOnce()
    expect(runtime.hasOwnedCalculationDataOperation()).toBe(false)
  })

  it('retries a current transaction once after a recoverable execution restart', async () => {
    const runtime = new PredictionRuntimeController()
    const transaction = runtime.beginTransaction()
    const onRestart = vi.fn()
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new PredictionInstanceInvalidatedError('restart'))
      .mockResolvedValueOnce('completed')

    await expect(runtime.runWithExecutionRetry(transaction, run, onRestart)).resolves.toBe('completed')
    expect(run).toHaveBeenCalledTimes(2)
    expect(onRestart).toHaveBeenCalledOnce()
  })

  it('does not retry a stale transaction', async () => {
    const runtime = new PredictionRuntimeController()
    const transaction = runtime.beginTransaction()
    runtime.invalidateTransaction()
    const onRestart = vi.fn()
    const restart = new PredictionInstanceInvalidatedError('restart')
    const run = vi.fn(async () => {
      throw restart
    })

    await expect(runtime.runWithExecutionRetry(transaction, run, onRestart)).rejects.toBe(restart)
    expect(run).toHaveBeenCalledOnce()
    expect(onRestart).not.toHaveBeenCalled()
  })
})

it('routes two directions independently and preserves the other owner when one route changes', async () => {
  const { execution: forward, runtime } = savedExecution()
  const { execution: inverse } = savedExecution()
  const { execution: replacement } = savedExecution()
  runtime.setExecutions({ forward: { key: 'A', create: () => forward }, inverse: { key: 'B', create: () => inverse } })
  const transaction = runtime.beginTransaction()
  const forwardModel = await runtime.loadModel(savedReference, transaction)
  const inverseModel = await runtime.loadModel(
    { ...savedReference, direction: 'inverse', modelId: 'inverse' },
    transaction,
  )
  expect(forward.load).toHaveBeenCalledOnce()
  expect(inverse.load).toHaveBeenCalledOnce()
  vi.mocked(forward.dispose).mockClear()
  runtime.setExecutions({
    forward: { key: 'A', create: () => forward },
    inverse: { key: 'C', create: () => replacement },
  })
  expect(runtime.modelIsCurrent(forwardModel)).toBe(true)
  expect(runtime.modelIsCurrent(inverseModel)).toBe(false)
  expect(inverse.release).toHaveBeenCalledWith(inverseModel.instance)
  expect(forward.dispose).not.toHaveBeenCalled()
  expect(inverse.dispose).toHaveBeenCalledOnce()
  runtime.dispose()
})

it('shares one execution for the same route and does not fall back to Browser for an empty remote selection', () => {
  const { execution, runtime } = savedExecution()
  const create = vi.fn(() => execution)
  runtime.setExecutions({ forward: { key: 'shared', create }, inverse: { key: 'shared', create } })
  expect(create).toHaveBeenCalledOnce()
  runtime.setExecutions({})
  runtime.start()
  expect(runtime.executionAvailableFor('forward')).toBe(false)
  expect(runtime.executionAvailableFor('inverse')).toBe(false)
  runtime.dispose()
})
