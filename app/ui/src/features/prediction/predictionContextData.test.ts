import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dbTables,
  getListRequest,
  type CalculationDataAnalysisResponse,
  type CalculationDataRecord,
  type PersistedCalculationRecord,
} from '@/api'
import { calculationsQueryOptions } from '@/features/calculation/queryOptions'
import { experimentRecordsQueryOptions } from '@/features/experiment/queryOptions'
import { measurementsQueryOptions } from '@/features/measurement/queryOptions'
import { calculationSourceHash } from '@/lib/calculation'
import {
  loadPredictionContextData,
  loadPredictionContextFingerprint,
  loadPredictionValidationData,
} from './predictionContextData'

afterEach(() => vi.restoreAllMocks())

describe('Prediction context data', () => {
  it('reuses fresh metadata query keys while keeping analysis responses out of the Query cache', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const calculationList = vi.spyOn(dbTables.Calculation, 'listRows').mockResolvedValue({ items: [], total: 0 })
    const measurementList = vi.spyOn(dbTables.Measurement, 'listRows').mockResolvedValue({ items: [], total: 0 })
    const experimentRecordList = vi
      .spyOn(dbTables.ExperimentRecord, 'listRows')
      .mockResolvedValue({ items: [], total: 0 })
    const analysis = vi.spyOn(dbTables.CalculationData, 'analysis').mockResolvedValue({
      fingerprint: 'same',
      total: 0,
      measurement_count: 0,
      items: [],
    })
    const analysisStatus = vi.spyOn(dbTables.CalculationData, 'analysisStatus').mockResolvedValue({
      fingerprint: 'same',
      total: 0,
      measurement_count: 0,
    })
    const fetchQuery = vi.spyOn(queryClient, 'fetchQuery')
    const controller = new AbortController()

    const context = await loadPredictionContextData({
      experimentId: 3,
      queryClient,
      queryScope: 'user:test',
      signal: controller.signal,
    })
    const fingerprint = await loadPredictionContextFingerprint({
      experimentId: 3,
      queryClient,
      queryScope: 'user:test',
      signal: controller.signal,
    })

    const listRequest = {
      ...getListRequest('visible'),
      limit: null,
      filter: { experiment_id: [3, 3] as const },
    }
    const expectedKeys = [
      calculationsQueryOptions('user:test', 3, listRequest).queryKey,
      measurementsQueryOptions('user:test', 3, listRequest).queryKey,
      experimentRecordsQueryOptions('user:test', 3).queryKey,
    ]
    expect(fingerprint).toBe(context.fingerprint)
    expect(fetchQuery).toHaveBeenCalledTimes(6)
    expect(fetchQuery.mock.calls.map(([options]) => options.queryKey)).toEqual([...expectedKeys, ...expectedKeys])
    expect(fetchQuery.mock.calls.every(([options]) => options.staleTime === 0 && options.retry === false)).toBe(true)
    expect(calculationList).toHaveBeenCalledTimes(2)
    expect(measurementList).toHaveBeenCalledTimes(2)
    expect(experimentRecordList).toHaveBeenCalledTimes(2)
    expect(analysis).toHaveBeenCalledWith(3, { signal: controller.signal })
    expect(analysisStatus).toHaveBeenCalledWith(3, { signal: controller.signal })
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual(expectedKeys)
    queryClient.clear()
  })

  it('cancels direct analysis without disrupting metadata Query work shared by a newer load', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let metadataSignal: AbortSignal | undefined
    let finishMetadata: (() => void) | undefined
    const calculationList = vi.spyOn(dbTables.Calculation, 'listRows').mockImplementation(
      (_request, context) =>
        new Promise((resolve) => {
          metadataSignal = context?.signal
          finishMetadata = () => resolve({ items: [], total: 0 })
        }),
    )
    vi.spyOn(dbTables.Measurement, 'listRows').mockResolvedValue({ items: [], total: 0 })
    vi.spyOn(dbTables.ExperimentRecord, 'listRows').mockResolvedValue({ items: [], total: 0 })
    const analysisResult = {
      fingerprint: 'pending',
      total: 0,
      measurement_count: 0,
      items: [],
    } satisfies CalculationDataAnalysisResponse
    let analysisCall = 0
    let firstAnalysisSignal: AbortSignal | undefined
    vi.spyOn(dbTables.CalculationData, 'analysis').mockImplementation((_experimentId, context) => {
      analysisCall += 1
      if (analysisCall > 1) return Promise.resolve(analysisResult)
      firstAnalysisSignal = context?.signal
      return new Promise((_resolve, reject) => {
        context?.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true })
      })
    })
    const firstController = new AbortController()
    const secondController = new AbortController()

    const firstLoad = loadPredictionContextData({
      experimentId: 3,
      queryClient,
      queryScope: 'user:test',
      signal: firstController.signal,
    })
    await vi.waitFor(() => expect(metadataSignal).toBeDefined())
    const secondLoad = loadPredictionContextData({
      experimentId: 3,
      queryClient,
      queryScope: 'user:test',
      signal: secondController.signal,
    })
    const firstRejected = expect(firstLoad).rejects.toMatchObject({ name: 'AbortError' })
    firstController.abort()

    await firstRejected
    expect(firstAnalysisSignal).toBe(firstController.signal)
    expect(firstAnalysisSignal?.aborted).toBe(true)
    expect(metadataSignal).not.toBe(firstController.signal)
    expect(metadataSignal?.aborted).toBe(false)
    finishMetadata?.()
    await expect(secondLoad).resolves.toMatchObject({ experimentId: 3 })
    expect(calculationList).toHaveBeenCalledOnce()
    queryClient.clear()
  })

  it('loads validation records in bounded direct batches and leaves them out of the Query cache', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const calculation = {
      id: 7,
      experiment_id: 3,
      name: 'Stress',
      source_code: 'return 1',
      source_hash: null,
      output_layout: null,
      contract_status: 'needs_preflight',
      experiment_record_ids: [],
    } satisfies PersistedCalculationRecord
    let calculationMetadataSignal: AbortSignal | undefined
    vi.spyOn(dbTables.Calculation, 'listRows').mockImplementation(async (_request, context) => {
      calculationMetadataSignal = context?.signal
      return { items: [calculation], total: 1 }
    })
    const matchingItems = Array.from({ length: 51 }, (_, index) => ({
      calculation_data_id: index + 1,
      calculation_id: 7,
      calculation_name: 'Stress',
      measurement_id: 11,
      dtype: 'float64' as const,
      summary: { kind: 'scalar' as const, value: index },
    }))
    const analysisResponse = {
      fingerprint: 'validation',
      total: 53,
      measurement_count: 2,
      items: [
        ...matchingItems,
        { ...matchingItems[0], calculation_data_id: 100, measurement_id: 12 },
        { ...matchingItems[0], calculation_data_id: 101, calculation_id: 8 },
      ],
    } satisfies CalculationDataAnalysisResponse
    const controller = new AbortController()
    const analysis = vi.spyOn(dbTables.CalculationData, 'analysis').mockResolvedValue(analysisResponse)
    const calculationDataList = vi.spyOn(dbTables.CalculationData, 'listRows').mockImplementation(async (request) => ({
      total: request.selected_ids.length,
      items: request.selected_ids.map((id): CalculationDataRecord => ({
        id,
        calculation_id: 7,
        measurement_id: 11,
        data: { dtype: 'float64', shape: [], data: id, axes: [] },
      })),
    }))

    const result = await loadPredictionValidationData({
      calculationIds: [7],
      experimentId: 3,
      measurementId: 11,
      queryClient,
      queryScope: 'user:test',
      signal: controller.signal,
    })

    expect(result.actual).toHaveLength(51)
    expect(result.currentSourceFingerprints.get(7)).toBe(await calculationSourceHash(calculation.source_code))
    expect(calculationDataList).toHaveBeenCalledTimes(2)
    expect(calculationDataList.mock.calls.map(([request]) => request.selected_ids.length)).toEqual([50, 1])
    expect(calculationDataList.mock.calls.flatMap(([request]) => request.selected_ids)).toEqual(
      Array.from({ length: 51 }, (_, index) => index + 1),
    )
    expect(calculationDataList.mock.calls.every(([, context]) => context?.signal === controller.signal)).toBe(true)
    expect(analysis).toHaveBeenCalledWith(3, { signal: controller.signal })
    expect(calculationMetadataSignal).not.toBe(controller.signal)
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1)
    expect(queryClient.getQueryCache().getAll()[0]?.queryKey).toEqual(
      calculationsQueryOptions('user:test', 3, {
        ...getListRequest('visible', [7]),
        filter: { experiment_id: [3, 3] },
        limit: 1,
      }).queryKey,
    )

    calculationDataList.mockClear()
    analysis.mockResolvedValue({ ...analysisResponse, items: analysisResponse.items.slice(51) })
    const empty = await loadPredictionValidationData({
      calculationIds: [7],
      experimentId: 3,
      measurementId: 11,
      queryClient,
      queryScope: 'user:test',
      signal: controller.signal,
    })
    expect(empty.actual).toEqual([])
    expect(calculationDataList).not.toHaveBeenCalled()
    queryClient.clear()
  })
})
