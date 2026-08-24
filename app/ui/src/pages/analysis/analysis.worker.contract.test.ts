import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-types'

const apiMocks = vi.hoisted(() => ({
  catalogRuntimeSlice: vi.fn(),
  measurementList: vi.fn(),
  recordedDataList: vi.fn(),
}))

vi.mock('@/api/catalog', () => ({
  catalogApi: { runtimeSlice: apiMocks.catalogRuntimeSlice },
}))

vi.mock('@/api', () => ({
  getListRequest: (scope = 'visible') => ({
    scope,
    offset: 0,
    limit: 24,
    selected_ids: [],
    search_text: null,
    text_filter: {},
    filter: {},
    sort: ['updated_at', 'desc'],
  }),
  dbTables: {
    Measurement: { listRows: apiMocks.measurementList },
    RecordedData: { listRows: apiMocks.recordedDataList },
  },
}))

const responses: AnalysisWorkerResponse[] = []
const workerScope = {
  onmessage: null as ((event: MessageEvent<AnalysisWorkerRequest>) => void) | null,
  postMessage: (response: AnalysisWorkerResponse) => responses.push(response),
}

function dispatch(request: AnalysisWorkerRequest) {
  workerScope.onmessage?.({ data: request } as MessageEvent<AnalysisWorkerRequest>)
}

async function waitForResponse(type: AnalysisWorkerResponse['type'], requestId: string) {
  await vi.waitFor(() => {
    expect(responses.some((response) => response.type === type && response.requestId === requestId)).toBe(true)
  })
  return responses.find((response) => response.type === type && response.requestId === requestId)!
}

function measurement(id: number, updatedAt: string) {
  return {
    id,
    updated_at: updatedAt,
    experiment_id: 2,
    vars: { width: id },
    material_parameters: {
      schemaVersion: 2,
      experiment: { schemaVersion: 1, materials: {} },
      tasks: { main: { schemaVersion: 1, materials: {} } },
    },
    recorded_at: '2026-08-12T00:00:00Z',
  }
}

function recordedResult(id: number) {
  return {
    id: 100 + id,
    updated_at: 'a',
    measurement_id: id,
    name: 'result',
    quantity_kind: 'Dimensionless',
    tensor_order: 0,
    dtype: 'float64',
    data_schema: { dtype: 'float64', quantityKind: 'Dimensionless', unit: '1' },
    data: { value: id * 3 },
  }
}

async function loadNumericDataset(requestId: string) {
  const items = Array.from({ length: 20 }, (_, index) => measurement(index + 1, 'a'))
  apiMocks.measurementList.mockResolvedValue({ total: items.length, items })
  apiMocks.recordedDataList.mockResolvedValue({
    total: items.length,
    items: items.map((item) => recordedResult(item.id)),
  })
  dispatch({ type: 'load-context', requestId, experimentId: 2 })
  await waitForResponse('profile', requestId)
}

describe('Analysis Worker data loading', () => {
  beforeAll(async () => {
    vi.stubGlobal('self', workerScope)
    await import('./analysis.worker')
  })

  beforeEach(() => {
    responses.splice(0)
    vi.clearAllMocks()
    apiMocks.catalogRuntimeSlice.mockImplementation(
      async ({ quantityKinds }: { quantityKinds: readonly string[] }) => ({
        schemaVersion: 1,
        catalogRevision: 'test',
        solvers: [],
        quantityKinds: quantityKinds.map((name) => ({
          name,
          domain: 'general',
          tensorOrder: 0,
          description: null,
          opaque: false,
          applicableUnits: ['1'],
        })),
        materialParameters: [],
        materialModels: [],
        warnings: [],
      }),
    )
  })

  afterAll(() => vi.unstubAllGlobals())

  it('range 응답을 정확한 Measurement ID 집합으로 다시 필터링한다', async () => {
    apiMocks.measurementList.mockResolvedValue({
      total: 2,
      items: [measurement(1, 'a'), measurement(3, 'a')],
    })
    apiMocks.recordedDataList.mockResolvedValue({
      total: 2,
      items: [
        {
          id: 101,
          updated_at: 'a',
          measurement_id: 1,
          name: 'result',
          quantity_kind: 'Dimensionless',
          tensor_order: 0,
          dtype: 'float64',
          data: { value: 4 },
        },
        {
          id: 102,
          updated_at: 'a',
          measurement_id: 2,
          name: 'result',
          quantity_kind: 'Dimensionless',
          tensor_order: 0,
          dtype: 'float64',
          data: { value: 999 },
        },
      ],
    })

    dispatch({ type: 'load-context', requestId: 'exact', experimentId: 2 })
    const response = await waitForResponse('profile', 'exact')

    expect(response.type === 'profile' && response.profile.recordedDataCount).toBe(1)
    expect(apiMocks.recordedDataList).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { measurement_id: [1, 3] },
        limit: null,
      }),
    )
    expect(apiMocks.catalogRuntimeSlice).toHaveBeenCalledWith({
      solvers: [],
      quantityKinds: ['Dimensionless'],
      materialParameters: [],
      materialModels: [],
    })
  })

  it('Catalog 조회 실패를 profile 대신 오류로 전달한다', async () => {
    apiMocks.measurementList.mockResolvedValue({ total: 1, items: [measurement(1, 'a')] })
    apiMocks.recordedDataList.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 101,
          measurement_id: 1,
          name: 'result',
          quantity_kind: 'Dimensionless',
          tensor_order: 0,
          dtype: 'float64',
          data: { value: 4 },
        },
      ],
    })
    apiMocks.catalogRuntimeSlice.mockRejectedValue(new Error('Catalog API를 사용할 수 없습니다.'))

    dispatch({ type: 'load-context', requestId: 'catalog-error', experimentId: 2 })
    const response = await waitForResponse('error', 'catalog-error')

    expect(response.type === 'error' && response.message).toContain('Catalog API를 사용할 수 없습니다.')
    expect(responses.some((item) => item.type === 'profile' && item.requestId === 'catalog-error')).toBe(false)
  })

  it('전후 signature가 바뀌면 한 번 다시 읽고 안정된 snapshot만 반환한다', async () => {
    const oldRows = { total: 1, items: [measurement(1, 'old')] }
    const newRows = { total: 1, items: [measurement(1, 'new')] }
    apiMocks.measurementList
      .mockResolvedValueOnce(oldRows)
      .mockResolvedValueOnce(newRows)
      .mockResolvedValueOnce(newRows)
      .mockResolvedValueOnce(newRows)
    apiMocks.recordedDataList.mockResolvedValue({ total: 0, items: [] })

    dispatch({ type: 'load-context', requestId: 'retry', experimentId: 2 })
    await waitForResponse('profile', 'retry')

    expect(apiMocks.measurementList).toHaveBeenCalledTimes(4)
    expect(apiMocks.recordedDataList).toHaveBeenCalledTimes(2)
  })

  it('재시도 중에도 데이터가 바뀌면 새로고침을 요구한다', async () => {
    const rows = (updatedAt: string) => ({
      total: 1,
      items: [measurement(1, updatedAt)],
    })
    apiMocks.measurementList
      .mockResolvedValueOnce(rows('a'))
      .mockResolvedValueOnce(rows('b'))
      .mockResolvedValueOnce(rows('b'))
      .mockResolvedValueOnce(rows('c'))
    apiMocks.recordedDataList.mockResolvedValue({ total: 0, items: [] })

    dispatch({ type: 'load-context', requestId: 'unstable', experimentId: 2 })
    const response = await waitForResponse('error', 'unstable')

    expect(response.type === 'error' && response.message).toContain('계속 변경되었습니다')
    expect(responses.some((item) => item.type === 'profile' && item.requestId === 'unstable')).toBe(false)
  })

  it('Recorded Data 범위 요청을 최대 네 개만 동시에 실행한다', async () => {
    const ids = [1, 3_002, 6_003, 9_004, 12_005]
    const context = {
      total: ids.length,
      items: ids.map((id) => measurement(id, 'a')),
    }
    apiMocks.measurementList.mockResolvedValue(context)
    let active = 0
    let maximumActive = 0
    apiMocks.recordedDataList.mockImplementation(async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return { total: 0, items: [] }
    })

    dispatch({ type: 'load-context', requestId: 'concurrency', experimentId: 2 })
    await waitForResponse('profile', 'concurrency')

    expect(apiMocks.recordedDataList).toHaveBeenCalledTimes(5)
    expect(maximumActive).toBe(4)
  })

  it('최초 관계 순위와 선택 산점도를 데이터 재조회 없이 갱신한다', async () => {
    await loadNumericDataset('relationship-load')
    const measurementCalls = apiMocks.measurementList.mock.calls.length
    const recordedCalls = apiMocks.recordedDataList.mock.calls.length

    dispatch({ type: 'relationships', requestId: 'relationship-rank' })
    const ranked = await waitForResponse('relationships', 'relationship-rank')
    expect(ranked.type === 'relationships' && ranked.result.pairs[0]).toMatchObject({
      inputKey: 'measurement.vars.width',
      targetKey: 'target:result',
      pearson: 1,
      spearman: 1,
      count: 20,
    })

    dispatch({
      type: 'relationship-plot',
      requestId: 'relationship-plot',
      inputKey: 'measurement.vars.width',
      targetKey: 'target:result',
    })
    const plot = await waitForResponse('relationship-plot', 'relationship-plot')
    expect(plot.type === 'relationship-plot' && plot.result.points).toHaveLength(20)
    expect(apiMocks.measurementList).toHaveBeenCalledTimes(measurementCalls)
    expect(apiMocks.recordedDataList).toHaveBeenCalledTimes(recordedCalls)
  })

  it('What-if는 학습 전에는 거절하고 학습 후에는 캐시된 최종 모델만 사용한다', async () => {
    await loadNumericDataset('prediction-load')
    dispatch({ type: 'predict-what-if', requestId: 'what-if-too-soon', whatIf: { 'measurement.vars.width': 4 } })
    const early = await waitForResponse('error', 'what-if-too-soon')
    expect(early.type === 'error' && early.message).toContain('먼저 Prediction 모델을 학습')

    dispatch({
      type: 'predict',
      requestId: 'prediction-train',
      featureKeys: ['measurement.vars.width'],
      targetKey: 'target:result',
      whatIf: { 'measurement.vars.width': 4 },
    })
    await waitForResponse('prediction', 'prediction-train')
    const measurementCalls = apiMocks.measurementList.mock.calls.length
    const recordedCalls = apiMocks.recordedDataList.mock.calls.length

    dispatch({ type: 'predict-what-if', requestId: 'what-if-cached', whatIf: { 'measurement.vars.width': 8 } })
    const cached = await waitForResponse('prediction-what-if', 'what-if-cached')
    expect(cached.type === 'prediction-what-if' && cached.result.prediction).toBeCloseTo(24, 3)
    expect(apiMocks.measurementList).toHaveBeenCalledTimes(measurementCalls)
    expect(apiMocks.recordedDataList).toHaveBeenCalledTimes(recordedCalls)
  })
})
