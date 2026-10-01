import { QueryClient } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { dbTables } from '@/api'
import {
  loadPredictionContextData,
  loadPredictionCalculations,
  loadPredictionValidationData,
} from './predictionContextData'

afterEach(() => vi.restoreAllMocks())
it('loads Forward output contracts without querying Calculation, Measurement or training tensors', async () => {
  const queryClient = new QueryClient()
  const records = vi.spyOn(dbTables.ExperimentRecord, 'listRows').mockResolvedValue({ items: [], total: 0 })
  const calculations = vi.spyOn(dbTables.Calculation, 'listRows')
  const measurements = vi.spyOn(dbTables.Measurement, 'listRows')
  const analysis = vi.spyOn(dbTables.CalculationData, 'analysis')
  const loaded = await loadPredictionContextData({ experimentId: 3, queryScope: 'user:test', queryClient })
  expect(loaded).toMatchObject({ experimentId: 3, calculations: [] })
  expect(records).toHaveBeenCalledOnce()
  expect(calculations).not.toHaveBeenCalled()
  expect(measurements).not.toHaveBeenCalled()
  expect(analysis).not.toHaveBeenCalled()
  queryClient.clear()
})
it('loads optional Calculation metadata independently', async () => {
  const queryClient = new QueryClient()
  const calculations = vi.spyOn(dbTables.Calculation, 'listRows').mockRejectedValue(new Error('no calculations'))
  const records = vi.spyOn(dbTables.ExperimentRecord, 'listRows').mockResolvedValue({ items: [], total: 0 })
  const options = { experimentId: 3, queryScope: 'user:test' as const, queryClient }
  await expect(loadPredictionContextData(options)).resolves.toMatchObject({ experimentId: 3 })
  await expect(loadPredictionCalculations(options)).rejects.toThrow('no calculations')
  expect(records).toHaveBeenCalledOnce()
  expect(calculations).toHaveBeenCalledOnce()
  queryClient.clear()
})
it('cancels this caller while preserving a shared contract query', async () => {
  const queryClient = new QueryClient()
  let complete!: (value: { items: []; total: number }) => void
  let querySignal: AbortSignal | undefined
  vi.spyOn(dbTables.ExperimentRecord, 'listRows').mockImplementation((_request, requestContext) => {
    querySignal = requestContext?.signal
    return new Promise((resolve) => {
      complete = resolve
    })
  })
  const abort = new AbortController()
  const options = { experimentId: 3, queryScope: 'user:test' as const, queryClient }
  const cancelled = loadPredictionContextData({ ...options, signal: abort.signal })
  const second = loadPredictionContextData(options)
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  abort.abort()
  await rejected
  expect(querySignal?.aborted).toBe(false)
  complete({ items: [], total: 0 })
  await expect(second).resolves.toMatchObject({ experimentId: 3 })
  queryClient.clear()
})
it('does not require CalculationData after Save & Run when no analysis is selected', async () => {
  const analysis = vi.spyOn(dbTables.CalculationData, 'analysis')
  expect(
    await loadPredictionValidationData({
      calculationIds: [],
      experimentId: 3,
      measurementId: 4,
      queryClient: new QueryClient(),
      queryScope: 'user:test',
    }),
  ).toEqual({ actual: [], currentSourceFingerprints: new Map() })
  expect(analysis).not.toHaveBeenCalled()
})
