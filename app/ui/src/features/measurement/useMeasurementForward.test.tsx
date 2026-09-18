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
  start: vi.fn(),
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
    start() {
      mocks.start()
    }
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
  mocks.rows.mockResolvedValue({ items: [{ id: 1, recorded_at: '2026-09-18' }] })
  mocks.build.mockResolvedValue(model)
  mocks.predict.mockResolvedValue({ recorded: { result: 'predicted' } })
})

describe('Measurement manual Forward lifecycle', () => {
  it('falls back to CAD if the Prediction Worker cannot start', async () => {
    mocks.start.mockImplementationOnce(() => {
      throw new Error('Worker unavailable')
    })
    const hook = renderHook(() =>
      useMeasurementForward({
        experimentId: 1,
        contextKey: 'one',
        document,
        measurements: [],
        vars: { x: 0.2 },
        ready: true,
        active: false,
      }),
    )
    await act(async () => {
      expect(await hook.result.current.prepare(document, new AbortController().signal)).toEqual({
        session: null,
        error: 'Worker unavailable',
      })
    })
    expect(hook.result.current.building).toBe(false)
    expect(mocks.dispose).toHaveBeenCalled()
  })
  it('re-predicts unchanged Vars with the updated model and trains on newly recorded rows', async () => {
    const hook = renderHook(() =>
      useMeasurementForward({
        experimentId: 1,
        contextKey: 'one',
        document,
        measurements: [],
        vars: { x: 0.2 },
        ready: true,
        active: true,
      }),
    )
    await act(async () => {
      await hook.result.current.build()
    })
    await waitFor(() => expect(mocks.predict).toHaveBeenCalledTimes(1))
    const updated = { ...model, fingerprint: 'new-data' }
    mocks.rows.mockResolvedValue({
      items: [
        { id: 1, recorded_at: 'today' },
        { id: 2, recorded_at: 'today' },
        { id: 3, recorded_at: null },
      ],
    })
    mocks.build.mockResolvedValue(updated)
    mocks.predict.mockResolvedValue({ recorded: { result: 'updated prediction' } })
    await act(async () => {
      await hook.result.current.build()
    })
    await waitFor(() => expect(hook.result.current.data).toEqual({ result: 'updated prediction' }))
    expect(mocks.build.mock.calls[1][0].context.measurements.map((row: { id: number }) => row.id)).toEqual([1, 2])
    expect(mocks.predict.mock.calls[1][0].model).toBe(updated)
  })

  it('supports awaitable batch prediction without automatic inference and treats empty data as CAD-only', async () => {
    const hook = renderHook(() =>
      useMeasurementForward({
        experimentId: 1,
        contextKey: 'one',
        document,
        measurements: [],
        vars: { x: 0.2 },
        ready: false,
        active: false,
      }),
    )
    const signal = new AbortController().signal
    mocks.rows.mockResolvedValueOnce({ items: [] })
    await act(async () => {
      const empty = await hook.result.current.prepare(document, signal)
      expect(empty.session).toBeNull()
      const result = await hook.result.current.predict(empty, document, { x: 0.2 }, signal)
      expect(result.data).toBeUndefined()
      expect(result.error).toContain('실제 결과가 없습니다')
    })
    expect(mocks.build).not.toHaveBeenCalled()
    await act(async () => {
      const trained = await hook.result.current.prepare(document, signal)
      expect((await hook.result.current.predict(trained, document, { x: 0.4 }, signal)).data).toEqual({
        result: 'predicted',
      })
    })
    expect(mocks.predict).toHaveBeenCalledTimes(1)
    expect(mocks.predict.mock.calls[0][0].vars).toEqual({ x: 0.4 })
  })

  it('returns CAD-only on batch training or prediction failure instead of using an old prediction', async () => {
    const hook = renderHook(() =>
      useMeasurementForward({
        experimentId: 1,
        contextKey: 'one',
        document,
        measurements: [],
        vars: { x: 0.2 },
        ready: true,
        active: false,
      }),
    )
    const signal = new AbortController().signal
    await act(async () => {
      await hook.result.current.prepare(document, signal)
      mocks.build.mockRejectedValueOnce(new Error('training failed'))
      const failed = await hook.result.current.prepare(document, signal)
      expect(await hook.result.current.predict(failed, document, { x: 0.4 }, signal)).toMatchObject({
        data: undefined,
        error: 'training failed',
      })
      const trained = await hook.result.current.prepare(document, signal)
      mocks.predict.mockRejectedValueOnce(new Error('prediction failed'))
      expect(await hook.result.current.predict(trained, document, { x: 0.4 }, signal)).toMatchObject({
        data: undefined,
        error: 'prediction failed',
      })
    })
  })

  it('rejects a cancelled batch prediction even if the worker returns late', async () => {
    const hook = renderHook(() =>
      useMeasurementForward({
        experimentId: 1,
        contextKey: 'one',
        document,
        measurements: [],
        vars: { x: 0.2 },
        ready: true,
        active: false,
      }),
    )
    const controller = new AbortController()
    let finish!: (value: unknown) => void
    mocks.predict.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await act(async () => {
      const trained = await hook.result.current.prepare(document, controller.signal)
      const prediction = hook.result.current.predict(trained, document, { x: 0.4 }, controller.signal)
      const rejected = expect(prediction).rejects.toMatchObject({ name: 'AbortError' })
      controller.abort()
      finish({ recorded: { result: 'late' } })
      await rejected
    })
    expect(hook.result.current.data).toBeUndefined()
    expect(hook.result.current.model).toBeNull()
  })
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
