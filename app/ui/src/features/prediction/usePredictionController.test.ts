import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { PredictionWorkerRestartError } from './client'
import { PredictionRuntimeController, usePredictionController } from './usePredictionController'

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

  it('retries a current transaction once after a Worker restart', async () => {
    const runtime = new PredictionRuntimeController()
    const transaction = runtime.beginTransaction()
    const onRestart = vi.fn()
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new PredictionWorkerRestartError('restart'))
      .mockResolvedValueOnce('completed')

    await expect(runtime.runWithWorkerRestartRetry(transaction, run, onRestart)).resolves.toBe('completed')
    expect(run).toHaveBeenCalledTimes(2)
    expect(onRestart).toHaveBeenCalledOnce()
  })

  it('does not retry a stale transaction', async () => {
    const runtime = new PredictionRuntimeController()
    const transaction = runtime.beginTransaction()
    runtime.invalidateTransaction()
    const onRestart = vi.fn()
    const restart = new PredictionWorkerRestartError('restart')
    const run = vi.fn(async () => {
      throw restart
    })

    await expect(runtime.runWithWorkerRestartRetry(transaction, run, onRestart)).rejects.toBe(restart)
    expect(run).toHaveBeenCalledOnce()
    expect(onRestart).not.toHaveBeenCalled()
  })
})
