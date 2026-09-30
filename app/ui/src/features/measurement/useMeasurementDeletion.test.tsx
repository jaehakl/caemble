import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dbTables, type PersistedMeasurementRecord } from '@/api'
import { measurementQueryKeys } from './queryKeys'
import { useMeasurementDeletion } from './useMeasurementDeletion'

const row = { id: 21, experiment_id: 7, user_id: 'owner', recorded_at: null } as PersistedMeasurementRecord
const context: Parameters<typeof useMeasurementDeletion>[0] = {
  user: { id: 'owner', roles: ['user'] },
  queryScope: 'user:owner' as const,
  experimentId: 7,
  workspaceSession: 1,
  publicDataWarning: false,
  selection: { forgetMeasurement: vi.fn(() => true) },
  onActivity: vi.fn(),
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(dbTables.Measurement, 'deleteRows').mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const key = measurementQueryKeys.lists(context.queryScope, 7)
  client.setQueryData(key, { items: [row], total: 1 })
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return {
    ...renderHook((value: Parameters<typeof useMeasurementDeletion>[0]) => useMeasurementDeletion(value), {
      wrapper,
      initialProps: context,
    }),
    client,
    key,
  }
}

it('checks owner and admin permissions, including read-only Demo browsing', () => {
  const { result, rerender } = setup()
  expect(result.current.canDelete(row)).toBe(true)
  expect(result.current.canDelete({ ...row, user_id: 'other' })).toBe(false)
  rerender({ ...context, publicDataWarning: true })
  expect(result.current.canDelete(row)).toBe(true)
  expect(result.current.canDelete({ ...row, user_id: 'other' })).toBe(false)
  rerender({ ...context, user: { id: 'admin', roles: ['admin'] }, publicDataWarning: true })
  expect(result.current.canDelete(row)).toBe(true)
  rerender({ ...context, user: null })
  expect(result.current.canDelete(row)).toBe(false)
})

it('confirms the ID and linked data, then forgets only that ID and invalidates its original caches', async () => {
  const { result, client, key } = setup()
  await act(() => result.current.deleteMeasurement(row))
  expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/#21.*\n.*RecordedData.*CalculationData/))
  expect(dbTables.Measurement.deleteRows).toHaveBeenCalledWith([21])
  expect(context.selection.forgetMeasurement).toHaveBeenCalledWith(21)
  expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  expect(result.current.deletingIds.size).toBe(0)
})

it('does not delete or alter selection when confirmation is cancelled', async () => {
  vi.mocked(window.confirm).mockReturnValue(false)
  const { result } = setup()
  await act(() => result.current.deleteMeasurement(row))
  expect(dbTables.Measurement.deleteRows).not.toHaveBeenCalled()
  expect(context.selection.forgetMeasurement).not.toHaveBeenCalled()
})

it('keeps selection and cached rows on API failure and reports the error to Runtime Console', async () => {
  vi.mocked(dbTables.Measurement.deleteRows).mockRejectedValue(
    new Error('Cancel active CAE jobs before deleting their Measurements.'),
  )
  const { result, client, key } = setup()
  await act(() => result.current.deleteMeasurement(row))
  expect(context.selection.forgetMeasurement).not.toHaveBeenCalled()
  expect(client.getQueryState(key)?.isInvalidated).toBe(false)
  expect(context.onActivity).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'cae',
      level: 'error',
      message: expect.stringContaining('Cancel active CAE jobs'),
    }),
  )
  expect(result.current.deletingIds.size).toBe(0)
})

it.each(['experiment', 'session', 'account'] as const)(
  'does not change a newer %s context after a delayed deletion',
  async (change) => {
    let finish!: () => void
    vi.mocked(dbTables.Measurement.deleteRows).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    const { result, rerender, client, key } = setup()
    let deletion!: Promise<void>
    act(() => {
      deletion = result.current.deleteMeasurement(row)
    })
    expect(result.current.deletingIds.has(21)).toBe(true)
    await act(() => result.current.deleteMeasurement(row))
    expect(dbTables.Measurement.deleteRows).toHaveBeenCalledTimes(1)
    rerender({
      ...context,
      ...(change === 'experiment'
        ? { experimentId: 8 }
        : change === 'session'
          ? { workspaceSession: 2 }
          : { queryScope: 'user:other' }),
    })
    await act(async () => {
      finish()
      await deletion
    })
    expect(context.selection.forgetMeasurement).not.toHaveBeenCalled()
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  },
)
