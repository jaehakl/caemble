import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedCalculationOutput } from '@/lib/calculation'
import { runCalculation } from '@/lib/calculation'
import type { CalculationDraft } from './calculationEditingState'
import { useCalculationPreview } from './useCalculationPreview'

vi.mock('@/lib/calculation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/calculation')>()
  return { ...actual, runCalculation: vi.fn() }
})

const output = (value: number): NormalizedCalculationOutput => ({
  axes: [],
  data: value,
  dtype: 'float64',
  shape: [],
})

const baseDraft: CalculationDraft = {
  description: '',
  id: 3,
  name: 'Preview',
  sourceCode: 'export default () => 1',
}

const recordedSnapshot = {
  error: null,
  errorCode: null,
  input: {
    input: {
      axes: [],
      data: 1,
      dtype: 'float64' as const,
      shape: [],
      tensorOrder: 0,
    },
  },
  summaries: [],
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(runCalculation).mockReset()
})

afterEach(() => vi.useRealTimers())

describe('useCalculationPreview', () => {
  it('aborts and ignores an older preview when source changes quickly', async () => {
    const pending: Array<{
      resolve: (value: NormalizedCalculationOutput) => void
      signal: AbortSignal
    }> = []
    vi.mocked(runCalculation).mockImplementation(({ signal }) => {
      if (!signal) throw new Error('Preview execution did not receive an AbortSignal.')
      return new Promise((resolve) => {
        pending.push({ resolve, signal })
      })
    })
    const onActivity = vi.fn()
    const { result, rerender } = renderHook(
      ({ draft }) =>
        useCalculationPreview({
          calculationDataBusy: false,
          contextPending: false,
          dependencyError: null,
          draft,
          experimentId: 2,
          experimentRecordsPending: false,
          measurementId: 5,
          measurementLoading: false,
          onActivity,
          recordedSnapshot,
          selectedCalculationId: 3,
        }),
      { initialProps: { draft: baseDraft } },
    )

    await act(async () => vi.advanceTimersByTime(500))
    expect(pending).toHaveLength(1)

    rerender({ draft: { ...baseDraft, sourceCode: 'export default () => 2' } })
    expect(pending[0].signal.aborted).toBe(true)
    await act(async () => pending[0].resolve(output(1)))
    expect(result.current.preview.status).toBe('loading')

    await act(async () => vi.advanceTimersByTime(500))
    expect(pending).toHaveLength(2)
    await act(async () => pending[1].resolve(output(2)))
    expect(result.current.preview).toEqual({ status: 'success', output: output(2) })
    expect(onActivity).not.toHaveBeenCalled()
  })

  it('propagates explicit invalidation to the active Worker signal', async () => {
    let activeSignal: AbortSignal | undefined
    const onActivity = vi.fn()
    vi.mocked(runCalculation).mockImplementation(
      ({ signal }) =>
        new Promise(() => {
          activeSignal = signal
        }),
    )
    const { result } = renderHook(() =>
      useCalculationPreview({
        calculationDataBusy: false,
        contextPending: false,
        dependencyError: null,
        draft: baseDraft,
        experimentId: 2,
        experimentRecordsPending: false,
        measurementId: 5,
        measurementLoading: false,
        onActivity,
        recordedSnapshot,
        selectedCalculationId: 3,
      }),
    )
    await act(async () => vi.advanceTimersByTime(500))

    act(() => result.current.invalidatePreview('다른 Measurement로 전환하는 중…'))

    expect(activeSignal?.aborted).toBe(true)
    expect(result.current.preview).toEqual({ status: 'loading', message: '다른 Measurement로 전환하는 중…' })
  })
})
