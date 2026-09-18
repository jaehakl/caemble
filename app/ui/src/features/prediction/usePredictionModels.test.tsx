import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { calculationExampleInput } from '@/authoring/examples'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import { defaultPredictionSetup, usePredictionModels } from './usePredictionModels'

const mocks = vi.hoisted(() => ({ build: vi.fn(), predict: vi.fn(), calculate: vi.fn() }))
vi.mock('./forwardModel', () => ({
  buildForwardModel: mocks.build,
  predictForwardRecorded: mocks.predict,
  assertTrainingCellLimit: vi.fn(),
  assertPredictionRecordedMemory: vi.fn(),
}))
vi.mock('@/lib/calculation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/calculation')>()),
  runCalculation: mocks.calculate,
}))

const signal = calculationExampleInput.signal
const rule = {
  label: 'signal',
  target: [],
  methodId: 'fixture',
  parameters: {},
  result: { dtype: 'float64' as const, axes: signal.axes, boxGrid: signal.boxGrid, tensorOrder: 0 },
}
const recorded = {
  signal: {
    shape: signal.shape,
    axes: signal.axes,
    boxGrid: signal.boxGrid,
    storage: { kind: 'inline' as const, value: varsTensorFromFlat(signal.data as number[], signal.shape) },
  },
}
const model = { rules: [rule], fingerprint: 'model-v2' }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.build.mockResolvedValue(model)
  mocks.predict.mockResolvedValue({ recorded, result: { neighbors: [] } })
})

function models() {
  let current = true
  const runtime = {
    transactionIsCurrent: () => current,
    runWithWorkerRestartRetry: (_transaction: number, run: () => Promise<unknown>) => run(),
    beginCalculation: () => new AbortController(),
  }
  const options = {
    runtime,
    candidateReady: true,
    candidateBoxGrids: { signal: signal.boxGrid },
    context: { experimentRecords: [{ id: 7, name: 'signal' }] },
    experimentId: 1,
    recordedData: {},
    resultContracts: {},
    varsSchema: { x: { shape: [], min: 0, max: 10 } },
    selectedCalculations: [
      {
        id: 2,
        experiment_record_ids: [7],
        source_code: 'source',
        contract_status: 'ready',
        output_layout: { dtype: 'float64', shape: [], axes: [] },
      },
    ],
    setup: { ...defaultPredictionSetup, calculationIds: [2] },
    clearModelCaches: vi.fn(),
    onForwardRecordProfilesChange: vi.fn(),
    onProfile: vi.fn(),
  } as unknown as Parameters<typeof usePredictionModels>[0]
  return {
    ...renderHook(() => usePredictionModels(options)),
    cancel: () => {
      current = false
    },
  }
}

it('publishes native RecordedData before a delayed Calculation and preserves the final return contract on failure', async () => {
  let fail!: (error: Error) => void
  mocks.calculate.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      }),
  )
  const { result } = models()
  const published = vi.fn()
  const pending = result.current.forwardOutputs({ x: 2 }, 1, published)
  await waitFor(() => expect(mocks.calculate).toHaveBeenCalledTimes(1))
  expect(published).toHaveBeenCalledExactlyOnceWith({
    recorded,
    rules: [rule],
    resultContracts: {},
    modelFingerprint: 'model-v2',
  })
  expect(mocks.build.mock.calls[0][0].requiredRecordIds).toEqual([7])
  fail(new Error('Calculation unavailable'))
  const completed = await pending
  expect(completed.calculated.errors).toEqual({ 2: 'Calculation unavailable' })
  expect(completed.model).toBe(model)
  expect(published).toHaveBeenCalledTimes(1)
})

it('does not publish or execute Calculation when a prediction arrives after cancellation', async () => {
  let release!: (value: unknown) => void
  mocks.predict.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const { result, cancel } = models()
  const published = vi.fn()
  const pending = result.current.forwardOutputs({ x: 2 }, 1, published)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await waitFor(() => expect(mocks.predict).toHaveBeenCalledTimes(1))
  cancel()
  release({ recorded, result: {} })
  await rejected
  expect(published).not.toHaveBeenCalled()
  expect(mocks.calculate).not.toHaveBeenCalled()
})

it('does not publish incomplete data when the prediction fails', async () => {
  mocks.predict.mockRejectedValue(new Error('Prediction failed'))
  const { result } = models()
  const published = vi.fn()
  await expect(result.current.forwardOutputs({ x: 2 }, 1, published)).rejects.toThrow('Prediction failed')
  expect(published).not.toHaveBeenCalled()
  expect(mocks.calculate).not.toHaveBeenCalled()
})
