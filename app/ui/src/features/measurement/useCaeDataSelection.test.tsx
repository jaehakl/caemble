import type { PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedMeasurement } from '@/features/cae-workbench/types'
import { authQueryKey } from '@/features/auth/queryKeys'
import { useCaeDataSelection } from './useCaeDataSelection'

const mocks = vi.hoisted(() => ({
  listRows: vi.fn(),
  readResults: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    dbTables: {
      ...actual.dbTables,
      Measurement: {
        ...actual.dbTables.Measurement,
        listRows: mocks.listRows,
        readResults: mocks.readResults,
      },
    },
  }
})

function measurement(id: number): SavedMeasurement {
  return {
    id,
    experiment_id: 10,
    vars: {},
    material_snapshot: {
      experiment: { materials: {} },
      tasks: {},
      sourceHash: 'source',
      varsHash: 'vars',
      modelDefinitions: [],
      selections: {},
    },
    recorded_at: null,
    calculation_data_count: 0,
  }
}

describe('useCaeDataSelection', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(authQueryKey, null)
    mocks.listRows.mockReset().mockImplementation(async (request: { selected_ids: readonly number[] }) => ({
      items: [measurement(request.selected_ids[0]!)],
      total: 1,
    }))
    mocks.readResults.mockReset()
  })

  it('retains the previous result when a batch download finishes after cancellation', async () => {
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    mocks.readResults.mockResolvedValue({ recorded_data: {}, result_contracts: {} })
    const { result } = renderHook(() => useCaeDataSelection(10), { wrapper })
    await act(async () => {
      await result.current.loadMeasurement(1)
    })
    let finish!: (value: unknown) => void
    mocks.readResults.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const controller = new AbortController()
    let pending!: ReturnType<typeof result.current.loadMeasurement>
    act(() => {
      pending = result.current.loadMeasurement(2, 10, { signal: controller.signal })
    })
    await waitFor(() => expect(mocks.readResults).toHaveBeenCalledTimes(2))
    expect(result.current.measurement?.id).toBe(1)
    await act(async () => {
      controller.abort()
      expect(await pending).toBeNull()
    })
    expect(result.current.loading).toBe(false)
    await act(async () => {
      finish({ recorded_data: {}, result_contracts: {} })
    })
    expect(result.current.measurement?.id).toBe(1)
  })

  it('exposes validated Measurement details before downloading recorded results', async () => {
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    let finishDownload!: (value: unknown) => void
    mocks.readResults.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDownload = resolve
        }),
    )
    const onDetail = vi.fn()
    const { result } = renderHook(() => useCaeDataSelection(10), { wrapper })
    let pending!: ReturnType<typeof result.current.loadMeasurement>
    act(() => {
      pending = result.current.loadMeasurement(1, 10, { onDetail })
    })

    await waitFor(() => expect(onDetail).toHaveBeenCalledWith(measurement(1)))
    expect(result.current.measurement).toBeNull()
    expect(result.current.loading).toBe(true)

    await act(async () => {
      finishDownload({ recorded_data: {}, result_contracts: {} })
      await pending
    })
    expect(result.current.measurement?.id).toBe(1)
  })

  it('keeps the public snapshot identity across an unrelated parent rerender', () => {
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const rendered = renderHook(({ marker }) => ({ marker, selection: useCaeDataSelection(10, 'visible') }), {
      initialProps: { marker: 0 },
      wrapper,
    })
    const initialSelection = rendered.result.current.selection

    rendered.rerender({ marker: 1 })

    expect(rendered.result.current.marker).toBe(1)
    expect(rendered.result.current.selection).toBe(initialSelection)
  })

  it('aborts the superseded request and only commits the latest Measurement', async () => {
    let firstSignal: AbortSignal | undefined
    mocks.readResults
      .mockImplementationOnce((_id: number, context?: { signal?: AbortSignal }) => {
        firstSignal = context?.signal
        return new Promise((_resolve, reject) => {
          context?.signal?.addEventListener(
            'abort',
            () => reject(context.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        })
      })
      .mockResolvedValueOnce({ recorded_data: {}, result_contracts: {} })

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useCaeDataSelection(10, 'visible'), { wrapper })

    let firstLoad!: Promise<SavedMeasurement | null>
    act(() => {
      firstLoad = result.current.loadMeasurement(1)
    })
    await waitFor(() => expect(mocks.readResults).toHaveBeenCalledWith(1, expect.any(Object)))

    await act(async () => {
      await result.current.loadMeasurement(2)
    })

    await expect(firstLoad).resolves.toBeNull()
    expect(firstSignal?.aborted).toBe(true)
    expect(result.current.measurement?.id).toBe(2)
    expect(result.current.loading).toBe(false)
  })

  it('retains the committed Measurement and results when the next load fails', async () => {
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    mocks.readResults.mockResolvedValue({ recorded_data: {}, result_contracts: {} })
    const { result } = renderHook(() => useCaeDataSelection(10, 'visible'), { wrapper })
    await act(async () => {
      await result.current.loadMeasurement(1)
    })
    const previous = result.current.flatRecordedData
    const error = new Error('Result download failed')
    mocks.readResults.mockRejectedValueOnce(error)

    await act(async () => {
      await expect(result.current.loadMeasurement(2)).rejects.toThrow(error)
    })

    expect(result.current.measurement?.id).toBe(1)
    expect(result.current.flatRecordedData).toBe(previous)
    expect(result.current.loading).toBe(false)
  })

  it('replaces Recorded results and variables with a Prepared Measurement without retaining old data', async () => {
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    mocks.readResults
      .mockResolvedValueOnce({
        recorded_data: {
          temperature: {
            experiment_record_id: 1,
            quantity_kind: null,
            tensor_order: 0,
            dtype: 'float64',
            data_schema: null,
            data: 300,
          },
        },
        result_contracts: {},
      })
      .mockResolvedValueOnce({ recorded_data: {}, result_contracts: {} })
    const { result } = renderHook(() => useCaeDataSelection(10, 'visible'), { wrapper })
    await act(async () => {
      await result.current.loadMeasurement({ ...measurement(1), recorded_at: '2026-09-26', vars: { width: 1 } })
    })
    expect(result.current.flatRecordedData).toEqual({ temperature: 300 })
    await act(async () => {
      await result.current.loadMeasurement({ ...measurement(2), vars: { width: 2 } })
    })
    expect(result.current.measurement?.id).toBe(2)
    expect(result.current.variables).toEqual({ width: 2 })
    expect(result.current.recordedData).toEqual({})
    expect(result.current.flatRecordedData).toEqual({})
    expect(result.current.recordedRows).toEqual([])
  })

  it('does not let a completion refresh supersede the user selection still being fetched', async () => {
    mocks.readResults.mockResolvedValue({ recorded_data: {}, result_contracts: {} })
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useCaeDataSelection(10, 'visible'), { wrapper })
    await act(async () => {
      await result.current.loadMeasurement(1)
    })
    let finish!: (value: object) => void
    mocks.readResults.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    let pending!: Promise<SavedMeasurement | null>
    act(() => {
      pending = result.current.loadMeasurement(2)
    })
    await waitFor(() => expect(mocks.readResults).toHaveBeenCalledWith(2, expect.any(Object)))
    expect(result.current.measurement?.id).toBe(1)
    await act(async () => {
      expect(await result.current.loadMeasurement(1, 10, { expectedSelectionId: 1 })).toBeNull()
    })
    await act(async () => {
      finish({ recorded_data: {}, result_contracts: {} })
      await pending
    })
    expect(result.current.measurement?.id).toBe(2)
    expect(mocks.readResults.mock.calls.map(([id]) => id)).toEqual([1, 2])
  })
})
