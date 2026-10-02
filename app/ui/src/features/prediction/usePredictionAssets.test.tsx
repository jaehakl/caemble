import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePredictionAssets } from './usePredictionAssets'
import { predictionApi } from '@/api/prediction'
import { disconnectPredictionOwner } from './assetManagement'

const mocks = vi.hoisted(() => ({ operations: vi.fn(), cancel: vi.fn() }))
vi.mock('@/api/prediction', () => ({
  predictionApi: {
    models: vi.fn().mockResolvedValue([]),
    datasets: vi.fn().mockResolvedValue([]),
    storages: vi.fn().mockResolvedValue([]),
    operations: mocks.operations,
    cancelOperation: mocks.cancel,
  },
}))
vi.mock('@gpstation/v1-master-js-sdk', () => ({
  GpStationClient: class {
    listLaunchers = vi.fn().mockResolvedValue([])
    cancelJob = mocks.cancel
  },
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  for (const api of [predictionApi.models, predictionApi.datasets, predictionApi.storages])
    vi.mocked(api).mockResolvedValue([])
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  mocks.operations.mockImplementation(async () => [
    { id: 'training', kind: 'prepare', state: 'queued', experiment_id: 1 },
  ])
})
afterEach(async () => {
  await disconnectPredictionOwner('poll-owner')
  vi.useRealTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})

it('observes training at two seconds visible and five seconds hidden, and never cancels on unmount', async () => {
  const { unmount } = renderHook(() => usePredictionAssets('poll-owner', 1))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(mocks.operations).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_999)
  })
  expect(mocks.operations).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(mocks.operations).toHaveBeenCalledTimes(2)
  await act(async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(mocks.operations).toHaveBeenCalledTimes(3)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_999)
  })
  expect(mocks.operations).toHaveBeenCalledTimes(3)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(mocks.operations).toHaveBeenCalledTimes(4)
  unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(mocks.operations).toHaveBeenCalledTimes(4)
  expect(mocks.cancel).not.toHaveBeenCalled()
})

it('refreshes on reconnect and keeps polling cancelled training until cleanup finishes', async () => {
  mocks.operations.mockImplementation(async () => [
    { id: 'training', kind: 'prepare', state: 'cancelled', experiment_id: 1, training: { cleanupPending: true } },
  ])
  renderHook(() => usePredictionAssets('poll-owner', 1))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  await act(async () => {
    window.dispatchEvent(new Event('online'))
  })
  expect(mocks.operations).toHaveBeenCalledTimes(2)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(mocks.operations).toHaveBeenCalledTimes(3)
  mocks.operations.mockImplementation(async () => [
    { id: 'training', kind: 'prepare', state: 'cancelled', experiment_id: 1, training: { cleanupPending: false } },
  ])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(mocks.operations).toHaveBeenCalledTimes(4)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(mocks.operations).toHaveBeenCalledTimes(4)
})
