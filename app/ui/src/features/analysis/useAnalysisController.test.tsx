import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisWorkerRequest } from './analysis-types'
import { useAnalysisController } from './useAnalysisController'

class FakeAnalysisWorker {
  static current: FakeAnalysisWorker | null = null

  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  postMessage = vi.fn<(message: AnalysisWorkerRequest) => void>()
  terminate = vi.fn()

  constructor() {
    FakeAnalysisWorker.current = this
  }

  respond(response: unknown) {
    this.onmessage?.({ data: response } as MessageEvent<unknown>)
  }
}

beforeEach(() => {
  FakeAnalysisWorker.current = null
  vi.stubGlobal('Worker', FakeAnalysisWorker)
})

afterEach(() => vi.unstubAllGlobals())

describe('useAnalysisController', () => {
  it('routes a stale-check Worker error to a terminal stale-check state', async () => {
    const { result } = renderHook(() =>
      useAnalysisController({ dataReadable: true, experimentId: 7, outlierPercent: 5, tab: 'explore' }),
    )
    await waitFor(() => expect(FakeAnalysisWorker.current).not.toBeNull())
    const worker = FakeAnalysisWorker.current!
    const loadRequest = worker.postMessage.mock.calls[0]?.[0]
    if (loadRequest?.type !== 'load-context') throw new Error('Analysis load request was not created.')

    act(() => {
      worker.respond({
        type: 'profile',
        requestId: loadRequest.requestId,
        profile: {
          fingerprint: 'profile-v1',
          experimentId: 7,
          rowCount: 0,
          measurementCount: 0,
          calculationDataCount: 0,
          calculationCount: 0,
          columns: [],
          warnings: [],
        },
      })
    })
    await waitFor(() => expect(result.current.profile?.fingerprint).toBe('profile-v1'))

    act(() => window.dispatchEvent(new Event('focus')))
    const staleRequest = worker.postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === 'check-stale')
    if (!staleRequest) throw new Error('Analysis stale request was not created.')

    act(() => worker.respond({ type: 'error', requestId: staleRequest.requestId, message: 'stale check failed' }))

    await waitFor(() => expect(result.current.error).toBe('stale check failed'))
    expect(result.current.busy).toBeNull()
  })

  it('turns a malformed Worker response into a terminal contract error', async () => {
    const { result } = renderHook(() =>
      useAnalysisController({ dataReadable: true, experimentId: 7, outlierPercent: 5, tab: 'explore' }),
    )
    await waitFor(() => expect(FakeAnalysisWorker.current).not.toBeNull())

    act(() => FakeAnalysisWorker.current!.respond({ type: 'profile', requestId: '', profile: null }))

    await waitFor(() => expect(result.current.error).toBe('Analysis Worker 응답 계약이 일치하지 않습니다.'))
    expect(result.current.busy).toBeNull()
  })
})
