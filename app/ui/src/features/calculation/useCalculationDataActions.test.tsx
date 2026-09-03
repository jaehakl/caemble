import type { PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCalculationDataActions } from './useCalculationDataActions'

const mocks = vi.hoisted(() => ({
  calculationList: vi.fn(),
  experimentRecordList: vi.fn(),
  invalidate: vi.fn(),
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
      Calculation: { ...actual.dbTables.Calculation, listRows: mocks.calculationList },
      CalculationData: {
        ...actual.dbTables.CalculationData,
        missing: mocks.missing,
        save: mocks.save,
      },
      ExperimentRecord: { ...actual.dbTables.ExperimentRecord, listRows: mocks.experimentRecordList },
      Measurement: { ...actual.dbTables.Measurement, readRecordedData: mocks.readRecordedData },
    },
  }
})

vi.mock('@/features/auth/use-auth', () => ({
  usePrivateQueryScope: () => 'user:first',
}))

vi.mock('@/lib/calculation', () => ({
  calculationSourceHash: mocks.sourceHash,
  runCalculation: mocks.runCalculation,
}))

vi.mock('./calculationRecordedData', () => ({
  buildCalculationRecordedData: () => ({ input: {} }),
}))

vi.mock('./queryInvalidation', () => ({
  invalidateCalculationDataMutation: mocks.invalidate,
}))

function abortablePending(context?: { signal?: AbortSignal }) {
  return new Promise<never>((_resolve, reject) => {
    context?.signal?.addEventListener(
      'abort',
      () => reject(context.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
      { once: true },
    )
  })
}

describe('useCalculationDataActions cancellation', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    mocks.calculationList.mockReset().mockResolvedValue({ items: [], total: 0 })
    mocks.experimentRecordList.mockReset().mockResolvedValue({ items: [], total: 0 })
    mocks.invalidate.mockReset().mockResolvedValue([])
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
    return renderHook(() => useCalculationDataActions({ authenticated: true, experimentId: 12 }), { wrapper })
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
    expect(result.current.progress).toMatchObject({ cancelled: true, running: false, stage: 'All Missing 취소됨' })
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
})
