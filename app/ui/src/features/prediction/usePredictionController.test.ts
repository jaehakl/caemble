import { describe, expect, it, vi } from 'vitest'
import { PredictionWorkerRestartError } from './client'
import { PredictionRuntimeController } from './usePredictionController'

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
