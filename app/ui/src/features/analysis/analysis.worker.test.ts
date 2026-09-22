import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-types'

const analysis = {
  fingerprint: 'analysis-v1',
  total: 1,
  measurement_count: 1,
  items: [
    {
      calculation_data_id: 11,
      calculation_id: 3,
      calculation_name: 'Stress',
      measurement_id: 41,
      dtype: 'float64',
      summary: { kind: 'scalar', value: 10 },
    },
  ],
}
const measurements = {
  total: 1,
  items: [
    {
      id: 41,
      experiment_id: 7,
      vars: { x: 2 },
      material_snapshot: {},
      recorded_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      calculation_data_count: 1,
    },
  ],
}
const worker = {
  onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  postMessage: vi.fn<(response: AnalysisWorkerResponse) => void>(),
}
const fetchMock = vi.fn<typeof fetch>()

async function sendRequest(request: AnalysisWorkerRequest) {
  worker.onmessage!({ data: request } as MessageEvent<unknown>)
  let response: AnalysisWorkerResponse | undefined
  await vi.waitFor(() => {
    response = worker.postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.requestId === request.requestId && message.type !== 'progress')
    expect(response).toBeDefined()
  })
  return response!
}

beforeEach(async () => {
  vi.resetModules()
  fetchMock.mockImplementation(async (url) => {
    switch (String(url)) {
      case '/api/calculation_data/analysis':
        return Response.json(analysis)
      case '/api/measurement/list':
        return Response.json(measurements)
      case '/api/calculation_data/analysis/status':
        return Response.json({ fingerprint: analysis.fingerprint, total: 1, measurement_count: 1 })
      default:
        throw new Error(`Unexpected request: ${String(url)}`)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('self', worker)
  await import('./analysis.worker')
})

afterEach(() => vi.unstubAllGlobals())

describe('Analysis Worker data freshness', () => {
  it('does not request data before a dataset has loaded', async () => {
    expect(await sendRequest({ type: 'check-stale', requestId: 'initial-check' })).toMatchObject({
      type: 'stale',
      stale: false,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('waits for the Analysis fingerprint before requesting Measurement inputs', async () => {
    let resolveAnalysis!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveAnalysis = resolve)))

    const loading = sendRequest({ type: 'load-context', requestId: 'load', experimentId: 7 })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/calculation_data/analysis'])
    resolveAnalysis(Response.json(analysis))

    expect(await loading).toMatchObject({ type: 'profile', profile: { fingerprint: 'analysis-v1', rowCount: 1 } })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/calculation_data/analysis',
      '/api/measurement/list',
    ])
    expect(
      worker.postMessage.mock.calls.map(([message]) => message).filter((message) => message.type === 'progress'),
    ).toEqual([
      { type: 'progress', requestId: 'load', stage: 'Calculation Data 조회' },
      { type: 'progress', requestId: 'load', stage: 'Measurement 조회' },
      { type: 'progress', requestId: 'load', stage: '데이터셋 구성' },
    ])
  })

  it.each([
    ['analysis-v1', false],
    ['analysis-v2', true],
  ])('checks %s using only the status endpoint without Measurement or object downloads', async (fingerprint, stale) => {
    expect(await sendRequest({ type: 'load-context', requestId: 'load', experimentId: 7 })).toMatchObject({
      type: 'profile',
    })
    fetchMock.mockClear()
    fetchMock.mockImplementationOnce(async () => Response.json({ fingerprint, total: 1, measurement_count: 1 }))

    expect(await sendRequest({ type: 'check-stale', requestId: 'check' })).toMatchObject({ type: 'stale', stale })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      '/api/calculation_data/analysis/status',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ experiment_id: 7 }) }),
    )
  })

  it('detects a change made while Measurement inputs are loading', async () => {
    let resolveMeasurements!: (response: Response) => void
    fetchMock
      .mockImplementationOnce(async () => Response.json(analysis))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveMeasurements = resolve)))

    const loading = sendRequest({ type: 'load-context', requestId: 'load', experimentId: 7 })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    // Inputs can be newer than the Analysis response, but must not replace its older baseline.
    resolveMeasurements(
      Response.json({
        ...measurements,
        items: [{ ...measurements.items[0], vars: { x: 3 }, updated_at: '2026-01-02T00:00:00Z' }],
      }),
    )
    expect(await loading).toMatchObject({ type: 'profile', profile: { fingerprint: 'analysis-v1' } })
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ fingerprint: 'analysis-v2', total: 1, measurement_count: 1 }),
    )

    expect(await sendRequest({ type: 'check-stale', requestId: 'after-load' })).toMatchObject({
      type: 'stale',
      stale: true,
    })
  })
})
