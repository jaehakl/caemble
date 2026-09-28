import type { PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { calculationExampleInput } from '@/authoring/examples'
import { varsTensorFromFlat } from '@/lib/cad/model/tensor'
import { useCalculationDataActions } from './useCalculationDataActions'

const mocks = vi.hoisted(() => ({
  calculationList: vi.fn(),
  experimentRecordList: vi.fn(),
  measurementList: vi.fn(),
  upsert: vi.fn(),
  invalidate: vi.fn(),
  invalidateCalculation: vi.fn(),
  activity: vi.fn(),
  missing: vi.fn(),
  readRecordedData: vi.fn(),
  runCalculation: vi.fn(),
  save: vi.fn(),
  sourceHash: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    dbTables: {
      ...actual.dbTables,
      Calculation: { ...actual.dbTables.Calculation, listRows: mocks.calculationList, upsertRow: mocks.upsert },
      CalculationData: {
        ...actual.dbTables.CalculationData,
        missing: mocks.missing,
        save: mocks.save,
      },
      ExperimentRecord: { ...actual.dbTables.ExperimentRecord, listRows: mocks.experimentRecordList },
      Measurement: {
        ...actual.dbTables.Measurement,
        listRows: mocks.measurementList,
        readRecordedData: mocks.readRecordedData,
      },
    },
  }
})

vi.mock('@/features/auth/use-auth', () => ({
  usePrivateQueryScope: () => 'user:first',
}))

vi.mock('@/lib/calculation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/calculation')>()),
  calculationSourceHash: mocks.sourceHash,
  runCalculation: mocks.runCalculation,
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }))

vi.mock('./queryInvalidation', () => ({
  invalidateCalculationDataMutation: mocks.invalidate,
  invalidateCalculationMutation: mocks.invalidateCalculation,
}))

const pendingCalculation = {
  id: 7,
  experiment_id: 12,
  revision: 3,
  source_revision: 2,
  name: 'Power',
  description: 'Stored definition',
  contract_status: 'needs_preflight',
  experiment_record_ids: [],
  source_code: 'export default function calculate(record) { return record.power }',
  calculation_data_count: 0,
  recorded_measurement_count: 11,
  measurement_count: 11,
}
const recordedTree = {
  power: {
    experiment_record_id: 21,
    quantity_kind: null,
    tensor_order: 0,
    dtype: 'float64',
    data_schema: {
      dtype: 'float64',
      axes: calculationExampleInput.signal.axes.map(({ name, ticks }) => ({ name, ticks })),
      boxGrid: calculationExampleInput.signal.boxGrid,
    },
    data: {
      shape: calculationExampleInput.signal.shape,
      axes: calculationExampleInput.signal.axes.map(({ ticks }) => ({ ticks })),
      boxGrid: calculationExampleInput.signal.boxGrid,
      storage: {
        kind: 'inline',
        value: varsTensorFromFlat(calculationExampleInput.signal.data, calculationExampleInput.signal.shape),
      },
    },
  },
}

function mockPendingCalculations(calculations = [{ ...pendingCalculation }]) {
  let rows = calculations
  mocks.calculationList.mockImplementation(async () => ({ items: rows, total: rows.length }))
  mocks.experimentRecordList.mockResolvedValue({ items: [{ id: 21, name: 'power' }], total: 1 })
  mocks.readRecordedData.mockResolvedValue(recordedTree)
  mocks.missing.mockResolvedValue({ items: [], total: 0 })
  mocks.upsert.mockImplementation(async ([saved]) => {
    rows = rows.map((row) => (row.id === saved.id ? { ...row, ...saved, revision: row.revision + 1 } : row))
    return [{ id: saved.id, revision: saved.base_revision + 1, source_revision: saved.base_source_revision }]
  })
}

function abortablePending(context?: { signal?: AbortSignal }) {
  return new Promise<never>((_resolve, reject) => {
    context?.signal?.addEventListener(
      'abort',
      () => reject(context.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
      { once: true },
    )
  })
}

describe('useCalculationDataActions', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    mocks.calculationList.mockReset().mockResolvedValue({ items: [], total: 0 })
    mocks.experimentRecordList.mockReset().mockResolvedValue({ items: [], total: 0 })
    mocks.measurementList.mockReset().mockResolvedValue({ items: [{ id: 11, recorded_at: '2026-09-28' }], total: 1 })
    mocks.upsert.mockReset().mockResolvedValue([{ id: 7, revision: 4, source_revision: 2 }])
    mocks.invalidate.mockReset().mockResolvedValue([])
    mocks.invalidateCalculation.mockReset().mockResolvedValue([])
    mocks.activity.mockReset()
    mocks.missing.mockReset()
    mocks.readRecordedData.mockReset().mockResolvedValue({})
    mocks.runCalculation.mockReset().mockResolvedValue({ axes: [], data: 1, dtype: 'float64', shape: [] })
    mocks.save.mockReset()
    mocks.sourceHash.mockReset().mockResolvedValue('source-hash')
  })

  function renderActions() {
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    return renderHook(
      ({ experimentId }) =>
        useCalculationDataActions({ authenticated: true, experimentId, onActivity: mocks.activity }),
      {
        wrapper,
        initialProps: { experimentId: 12 },
      },
    )
  }

  it('aborts every target-discovery request and resolves as cancelled', async () => {
    let missingSignal: AbortSignal | undefined
    mocks.missing.mockImplementation((_payload: unknown, context?: { signal?: AbortSignal }) => {
      missingSignal = context?.signal
      return abortablePending(context)
    })
    const { result } = renderActions()

    let run!: ReturnType<typeof result.current.calculateAll>
    act(() => {
      run = result.current.calculateAll()
    })
    await waitFor(() => expect(mocks.missing).toHaveBeenCalledOnce())

    act(() => result.current.cancel())
    let summary!: Awaited<typeof run>
    await act(async () => {
      summary = await run
    })

    expect(missingSignal?.aborted).toBe(true)
    expect(mocks.calculationList).toHaveBeenCalledWith(expect.any(Object), { signal: missingSignal })
    expect(mocks.experimentRecordList).toHaveBeenCalledWith(expect.any(Object), { signal: missingSignal })
    expect(summary).toMatchObject({ cancelled: true, completed: 0, failed: 0, succeeded: 0 })
    expect(result.current.progress).toMatchObject({ cancelled: true, running: false, stage: '일괄 계산 취소됨' })
  })

  it('aborts an in-flight CalculationData save', async () => {
    let saveSignal: AbortSignal | undefined
    mocks.missing.mockResolvedValue({
      items: [{ calculation_id: 7, measurement_id: 9 }],
      total: 1,
    })
    mocks.calculationList.mockResolvedValue({
      items: [
        {
          contract_status: 'ready',
          experiment_id: 12,
          experiment_record_ids: [],
          id: 7,
          name: 'Calculation',
          source_code: 'export default () => 1',
        },
      ],
      total: 1,
    })
    mocks.save.mockImplementation((_payload: unknown, context?: { signal?: AbortSignal }) => {
      saveSignal = context?.signal
      return abortablePending(context)
    })
    const { result } = renderActions()

    let run!: ReturnType<typeof result.current.calculateAll>
    act(() => {
      run = result.current.calculateAll()
    })
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())

    act(() => result.current.cancel())
    let summary!: Awaited<typeof run>
    await act(async () => {
      summary = await run
    })

    expect(saveSignal?.aborted).toBe(true)
    expect(summary).toMatchObject({ cancelled: true, completed: 0, failed: 0, succeeded: 0 })
  })

  it.each([
    { status: null, message: '저장된 Calculation이 없습니다.', warning: false },
    { status: 'needs_preflight', message: '사전 검증이 필요해 제외했습니다.', warning: true },
    { status: 'unknown', message: '사전 검증이 필요해 제외했습니다.', warning: true },
    {
      status: 'ready',
      message: '아직 결과가 없고 필수 입력을 갖춘 기록 완료 Measurement가 필요합니다.',
      warning: false,
    },
  ])('explains empty targets for $status instead of reporting zero successes', async ({ status, message, warning }) => {
    mocks.missing.mockResolvedValue({ items: [], total: 0 })
    mocks.calculationList.mockResolvedValue({
      items: status ? [{ id: 7, contract_status: status }] : [],
      total: status ? 1 : 0,
    })
    const { result } = renderActions()
    await act(async () => {
      expect(await result.current.calculateMeasurement(9, { announce: true })).toMatchObject({
        total: 0,
        failed: 0,
        succeeded: 0,
      })
    })
    expect(warning ? toast.warning : toast.info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message))
    expect(toast.success).not.toHaveBeenCalled()
    expect(mocks.runCalculation).not.toHaveBeenCalled()
    expect(result.current.progress).toMatchObject({ running: false, stage: expect.stringContaining(message) })
    expect(mocks.invalidate).toHaveBeenCalledOnce()
  })

  it('preflights, saves the contract and calculates eleven Measurements with one click', async () => {
    let calculation = { ...pendingCalculation }
    mocks.calculationList.mockImplementation(async () => ({ items: [calculation], total: 1 }))
    mocks.experimentRecordList.mockResolvedValue({ items: [{ id: 21, name: 'power' }], total: 1 })
    mocks.readRecordedData.mockResolvedValue(recordedTree)
    mocks.upsert.mockImplementation(async ([saved]) => {
      expect(mocks.save).not.toHaveBeenCalled()
      calculation = { ...calculation, ...saved, revision: 4, source_revision: 3 }
      return [{ id: 7, revision: 4, source_revision: 3 }]
    })
    const { result } = renderActions()
    const targets = Array.from({ length: 11 }, (_, index) => ({ calculation_id: 7, measurement_id: index + 1 }))
    mocks.missing.mockImplementation(async () => {
      expect(calculation.contract_status).toBe('ready')
      return { items: targets, total: targets.length }
    })
    await act(async () => {
      expect(await result.current.calculateAll()).toEqual({
        total: 11,
        completed: 11,
        succeeded: 11,
        failed: 0,
        cancelled: false,
        preflight: { total: 1, completed: 1, succeeded: 1, failed: 0, saveFailed: 0 },
      })
    })
    expect(mocks.missing).toHaveBeenLastCalledWith({ experiment_id: 12 }, { signal: expect.any(AbortSignal) })
    expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith(
      [
        expect.objectContaining({
          id: 7,
          name: pendingCalculation.name,
          description: pendingCalculation.description,
          source_code: pendingCalculation.source_code,
          source_hash: 'source-hash',
          base_revision: 3,
          base_source_revision: 2,
          contract_status: 'ready',
          preflight_measurement_id: 11,
          experiment_record_ids: [21],
          output_layout: { dtype: 'float64', shape: [], axes: [] },
        }),
      ],
      { signal: expect.any(AbortSignal) },
    )
    expect(mocks.calculationList).toHaveBeenCalledTimes(2)
    expect(mocks.runCalculation).toHaveBeenCalledTimes(12)
    expect(mocks.runCalculation).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { power: expect.objectContaining({ data: [2, 4, 6, 8], shape: [1, 1, 1, 4, 1, 1, 1] }) },
      }),
    )
    expect(mocks.save).toHaveBeenCalledTimes(11)
    for (const target of targets) {
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ...target,
          source_revision: 3,
          source_hash: 'source-hash',
        }),
        { signal: expect.any(AbortSignal) },
      )
    }
    expect(toast.success).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('일괄 계산: 성공 11개, 실패 0개'))
    expect(toast.warning).not.toHaveBeenCalled()
    expect(mocks.invalidateCalculation).toHaveBeenCalledOnce()
  })

  it('calculates ready targets and reports excluded preflight-required Calculations without counting them as failures', async () => {
    mocks.calculationList.mockResolvedValue({
      items: [
        { id: 7, contract_status: 'ready', experiment_record_ids: [], source_code: 'export default () => 1' },
        { id: 8, contract_status: 'needs_preflight' },
        { id: 9, contract_status: 'unknown' },
      ],
      total: 3,
    })
    mocks.missing.mockResolvedValue({ items: [{ calculation_id: 7, measurement_id: 1 }], total: 1 })
    const { result } = renderActions()
    await act(async () => {
      expect(await result.current.calculateMeasurement(1, { announce: true })).toMatchObject({
        total: 1,
        succeeded: 1,
        failed: 0,
      })
    })
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('성공 1개, 실패 0개 · Calculation 2개는 사전 검증이 필요해 제외했습니다.'),
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('limits preflight notices to the requested Calculation', async () => {
    mocks.calculationList.mockResolvedValue({
      items: [
        { id: 7, contract_status: 'ready' },
        { id: 8, contract_status: 'needs_preflight' },
      ],
      total: 2,
    })
    mocks.missing.mockResolvedValue({ items: [], total: 0 })
    const { result } = renderActions()
    await act(async () => {
      await result.current.calculateSelected(7)
    })
    expect(mocks.missing).toHaveBeenCalledWith(
      { experiment_id: 12, calculation_id: 7 },
      { signal: expect.any(AbortSignal) },
    )
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('계산 대상이 없습니다.'))
  })

  it('selects the newest Measurement with all required records, skipping only missing inputs', async () => {
    mockPendingCalculations()
    mocks.measurementList.mockResolvedValue({
      items: [
        { id: 13, recorded_at: '2026-09-28' },
        { id: 12, recorded_at: '2026-09-27' },
        { id: 11, recorded_at: '2026-09-26' },
      ],
      total: 3,
    })
    mocks.readRecordedData.mockResolvedValueOnce({}).mockResolvedValue(recordedTree)
    const { result } = renderActions()
    await act(async () => {
      await result.current.calculateAll()
    })
    expect(mocks.measurementList).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        filter: { experiment_id: [12, 12] },
        null_filter: { recorded_at: 'is_not_null' },
        sort: [
          ['recorded_at', 'desc'],
          ['id', 'desc'],
        ],
        limit: null,
      }),
      { signal: expect.any(AbortSignal), resolveObjects: false },
    )
    expect(mocks.readRecordedData.mock.calls.map(([id]) => id)).toEqual([13, 12])
    expect(mocks.upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ preflight_measurement_id: 12 })],
      expect.any(Object),
    )
    expect(mocks.runCalculation).toHaveBeenCalledOnce()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('does not retry a failed preflight on an older Measurement and continues other Calculations', async () => {
    mockPendingCalculations([
      { ...pendingCalculation },
      { ...pendingCalculation, id: 8 },
      { ...pendingCalculation, id: 9, contract_status: 'ready' },
    ])
    mocks.measurementList.mockResolvedValue({
      items: [
        { id: 11, recorded_at: '2026-09-28' },
        { id: 10, recorded_at: '2026-09-27' },
      ],
      total: 2,
    })
    mocks.runCalculation.mockRejectedValueOnce(new Error('invalid projection'))
    mocks.missing.mockResolvedValue({
      items: [
        { calculation_id: 8, measurement_id: 11 },
        { calculation_id: 9, measurement_id: 11 },
      ],
      total: 2,
    })
    const { result } = renderActions()
    await act(async () => {
      expect(await result.current.calculateAll()).toMatchObject({
        succeeded: 2,
        failed: 0,
        preflight: { total: 2, completed: 2, succeeded: 1, failed: 1, saveFailed: 0 },
      })
    })
    expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: 8 })], expect.any(Object))
    expect(mocks.readRecordedData.mock.calls.every(([id]) => id === 11)).toBe(true)
    expect(mocks.runCalculation).toHaveBeenCalledTimes(4)
    expect(mocks.save).toHaveBeenCalledTimes(2)
    expect(mocks.activity).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'preflight',
        message: expect.stringContaining('Calculation #7 사전 검증 실패: invalid projection'),
      }),
    )
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('사전 검증 실패 1개'))
  })

  it.each(['no measurement', 'missing inputs', 'invalid source'])(
    'counts %s as a preflight failure without saving or executing CalculationData',
    async (reason) => {
      mockPendingCalculations([
        { ...pendingCalculation, ...(reason === 'invalid source' ? { source_code: 'invalid syntax {' } : {}) },
      ])
      if (reason === 'no measurement') mocks.measurementList.mockResolvedValue({ items: [], total: 0 })
      if (reason === 'missing inputs') mocks.readRecordedData.mockResolvedValue({})
      const { result } = renderActions()
      await act(async () => {
        expect(await result.current.calculateAll()).toMatchObject({
          total: 0,
          succeeded: 0,
          failed: 0,
          preflight: { failed: 1, saveFailed: 0 },
        })
      })
      expect(mocks.upsert).not.toHaveBeenCalled()
      expect(mocks.runCalculation).not.toHaveBeenCalled()
      expect(mocks.save).not.toHaveBeenCalled()
      expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('사전 검증 실패 1개'))
      expect(mocks.activity).toHaveBeenCalledWith(expect.objectContaining({ phase: 'preflight', level: 'error' }))
    },
  )

  it.each(['revision conflict', 'network error', 'permission denied'])(
    'reports contract save %s separately and never runs that Calculation, even after concurrent updates',
    async (reason) => {
      mockPendingCalculations([{ ...pendingCalculation }, { ...pendingCalculation, id: 8 }])
      mocks.upsert.mockRejectedValueOnce(new Error(reason))
      // A concurrent editor can make #7 ready before rediscovery; it must still be excluded from this run.
      mocks.missing.mockResolvedValue({
        items: [
          { calculation_id: 7, measurement_id: 11 },
          { calculation_id: 8, measurement_id: 11 },
        ],
        total: 2,
      })
      const { result } = renderActions()
      await act(async () => {
        expect(await result.current.calculateAll()).toMatchObject({
          total: 1,
          completed: 1,
          succeeded: 1,
          failed: 0,
          preflight: { total: 2, completed: 2, succeeded: 1, failed: 0, saveFailed: 1 },
        })
      })
      expect(mocks.upsert).toHaveBeenCalledTimes(2)
      expect(mocks.save).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ calculation_id: 8 }),
        expect.any(Object),
      )
      expect(mocks.activity).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'preflight-save',
          message: expect.stringContaining(reason),
        }),
      )
      expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('검증 계약 저장 실패 1개'))
    },
  )

  it.each(['measurement list', 'recorded data', 'preflight', 'contract save', 'rediscovery'])(
    'cancels during %s and starts no later writes',
    async (stage) => {
      mockPendingCalculations([{ ...pendingCalculation }, { ...pendingCalculation, id: 8 }])
      const pending =
        stage === 'measurement list'
          ? mocks.measurementList
          : stage === 'recorded data'
            ? mocks.readRecordedData
            : stage === 'preflight'
              ? mocks.runCalculation
              : stage === 'contract save'
                ? mocks.upsert
                : mocks.missing
      pending.mockImplementation((payload, context) => abortablePending(stage === 'preflight' ? payload : context))
      const { result } = renderActions()
      let run!: ReturnType<typeof result.current.calculateAll>
      act(() => {
        run = result.current.calculateAll()
      })
      await waitFor(() => expect(pending).toHaveBeenCalled())
      const writes = mocks.upsert.mock.calls.length
      act(() => result.current.cancel())
      await act(async () => {
        expect(await run).toMatchObject({ cancelled: true, failed: 0, preflight: { failed: 0, saveFailed: 0 } })
      })
      expect(mocks.upsert).toHaveBeenCalledTimes(writes)
      expect(mocks.save).not.toHaveBeenCalled()
      expect(mocks.activity).not.toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }))
      expect(mocks.invalidateCalculation).toHaveBeenCalledOnce()
    },
  )

  it('aborts automatic preparation on Experiment change and preserves already saved contracts', async () => {
    mockPendingCalculations([{ ...pendingCalculation }, { ...pendingCalculation, id: 8 }])
    mocks.runCalculation
      .mockResolvedValueOnce({ dtype: 'float64', shape: [], axes: [], data: 1 })
      .mockImplementationOnce((payload) => abortablePending(payload))
    const { result, rerender } = renderActions()
    let run!: ReturnType<typeof result.current.calculateAll>
    act(() => {
      run = result.current.calculateAll()
    })
    await waitFor(() => expect(mocks.runCalculation).toHaveBeenCalledTimes(2))
    act(() => rerender({ experimentId: 99 }))
    await act(async () => {
      expect(await run).toMatchObject({
        cancelled: true,
        preflight: { succeeded: 1, failed: 0, saveFailed: 0 },
      })
    })
    expect(mocks.upsert).toHaveBeenCalledOnce()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.invalidateCalculation).toHaveBeenCalledWith(expect.any(Object), 'user:first', 12)
  })

  it('does not auto-prepare for selected Calculation or per-Measurement actions', async () => {
    mockPendingCalculations()
    const { result } = renderActions()
    await act(async () => {
      await result.current.calculateSelected(7)
      await result.current.calculateMeasurement(11)
    })
    expect(mocks.measurementList).not.toHaveBeenCalled()
    expect(mocks.runCalculation).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('fails invalid required tensors without retrying an older Measurement', async () => {
    mockPendingCalculations()
    mocks.measurementList.mockResolvedValue({
      items: [
        { id: 11, recorded_at: '2026-09-28' },
        { id: 10, recorded_at: '2026-09-27' },
      ],
      total: 2,
    })
    mocks.readRecordedData
      .mockResolvedValueOnce({
        power: { ...recordedTree.power, data: { ...recordedTree.power.data, boxGrid: undefined } },
      })
      .mockResolvedValue(recordedTree)
    const { result } = renderActions()
    await act(async () => {
      expect(await result.current.calculateAll()).toMatchObject({ preflight: { failed: 1, saveFailed: 0 } })
    })
    expect(mocks.readRecordedData).toHaveBeenCalledOnce()
    expect(mocks.runCalculation).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('validates only required inputs in both preflight and result calculation', async () => {
    mockPendingCalculations()
    mocks.readRecordedData.mockResolvedValue({
      ...recordedTree,
      unused: {
        ...recordedTree.power,
        experiment_record_id: 22,
        data: { ...recordedTree.power.data, boxGrid: undefined },
      },
    })
    mocks.missing.mockResolvedValue({ items: [{ calculation_id: 7, measurement_id: 11 }], total: 1 })
    const { result } = renderActions()
    await act(async () => {
      expect(await result.current.calculateAll()).toMatchObject({
        succeeded: 1,
        failed: 0,
        preflight: { succeeded: 1, failed: 0, saveFailed: 0 },
      })
    })
    expect(mocks.runCalculation).toHaveBeenCalledTimes(2)
    for (const [request] of mocks.runCalculation.mock.calls) expect(Object.keys(request.input)).toEqual(['power'])
  })
})
