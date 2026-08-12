import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-types'

const apiMocks = vi.hoisted(() => ({
  measurementList: vi.fn(),
  recordedDataList: vi.fn(),
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

describe('Analysis Worker data loading', () => {
  beforeAll(async () => {
    vi.stubGlobal('self', workerScope)
    await import('./analysis.worker')
  })

  beforeEach(() => {
    responses.splice(0)
    vi.clearAllMocks()
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
})
