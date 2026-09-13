import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import { useMeasurementForward } from './useMeasurementForward'

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  predict: vi.fn(),
  records: vi.fn(),
  rows: vi.fn(),
  dispose: vi.fn(),
}))
vi.mock('@/api', () => ({
  getListRequest: () => ({}),
  dbTables: { ExperimentRecord: { listRows: mocks.records }, Measurement: { listRows: mocks.rows } },
}))
vi.mock('@/features/prediction/forwardModel', () => ({
  buildForwardModel: mocks.build,
  predictForwardRecorded: mocks.predict,
}))
vi.mock('@/features/prediction/usePredictionModels', () => ({
  defaultPredictionSetup: { kMode: 'auto', manualK: 1, weighting: 'distance' },
}))
vi.mock('@/features/prediction/usePredictionController', () => ({
  PredictionRuntimeController: class {
    workerEpoch = 0
    start() {}
    beginTransaction() {
      return 1
    }
    transactionSignal() {
      return undefined
    }
    invalidateTransaction() {}
    dispose() {
      mocks.dispose()
    }
  },
}))

const document = {
  varsSchema: { x: { min: 0, max: 1, shape: [] } },
  simulationProgram: { recordedData: {}, resultContracts: {}, boxGrids: {} },
} as unknown as CadDocumentController
const model = { models: [{ workerEpoch: 0 }], rules: [], errors: {} }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.records.mockResolvedValue({ items: [{ id: 1 }] })
  mocks.rows.mockResolvedValue({ items: [] })
  mocks.build.mockResolvedValue(model)
  mocks.predict.mockResolvedValue({ recorded: { result: 'predicted' } })
})

describe('Measurement manual Forward lifecycle', () => {
  it('never trains on mount or Vars changes; manual model survives tab switches and failed refresh', async () => {
    const hook = renderHook(
      ({ value, active }) =>
        useMeasurementForward({
          experimentId: 1,
          contextKey: 'one',
          document,
          measurements: [],
          vars: { x: value },
          ready: true,
          active,
        }),
      { initialProps: { value: 0.1, active: true } },
    )
    hook.rerender({ value: 0.2, active: true })
    expect(mocks.build).not.toHaveBeenCalled()
    await act(async () => {
      await hook.result.current.build()
    })
    await waitFor(() => expect(hook.result.current.data).toEqual({ result: 'predicted' }))
    expect(mocks.build).toHaveBeenCalledTimes(1)
    hook.rerender({ value: 0.3, active: false })
    expect(hook.result.current.model).toBe(model)
    hook.rerender({ value: 0.3, active: true })
    await waitFor(() => expect(mocks.predict).toHaveBeenCalledTimes(2))
    mocks.build.mockRejectedValueOnce(new Error('training failed'))
    await act(async () => {
      await hook.result.current.build()
    })
    expect(hook.result.current.model).toBe(model)
    expect(hook.result.current.error).toBe('training failed')
  })
  it('drops a model on context changes and discards late inference', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.predict.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const hook = renderHook(
      ({ contextKey }) =>
        useMeasurementForward({
          experimentId: 1,
          contextKey,
          document,
          measurements: [],
          vars: { x: 0.2 },
          ready: true,
          active: true,
        }),
      { initialProps: { contextKey: 'one' } },
    )
    await act(async () => {
      await hook.result.current.build()
    })
    await waitFor(() => expect(mocks.predict).toHaveBeenCalled())
    hook.rerender({ contextKey: 'two' })
    await act(async () => {
      finish({ recorded: { result: 'stale' } })
    })
    expect(hook.result.current.model).toBeNull()
    expect(hook.result.current.data).toBeUndefined()
    expect(mocks.dispose).toHaveBeenCalled()
  })
})
