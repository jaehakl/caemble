import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { caeBatches, subscribeCaeEvents } from './cae'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('./http', () => ({ API_URL: '/api', browserClient: { request: mocks.request } }))

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('CAE batch API boundary', () => {
  it('submits one idempotent batch request with CSRF protection', () => {
    const body = {
      request_id: 'request-1',
      experiment_id: 7,
      experiment_source_hash: 'hash',
      mode: 'generate' as const,
      catalog_revision: 'catalog',
      builder_version: '1' as const,
      items: [{ index: 1, input_hash: 'a'.repeat(64), byte_length: 123 }],
    }
    caeBatches.create(body)
    expect(mocks.request).toHaveBeenCalledWith(
      'post',
      '/cae/batches',
      body,
      expect.objectContaining({ csrf: 'required', validate: expect.any(Function) }),
    )
    const validate = mocks.request.mock.calls[0][3].validate as (value: unknown) => unknown
    expect(() => validate({ id: 'batch', total: '10' })).toThrow()
  })

  it('reads bounded job pages and retries only the requested failed job IDs', () => {
    caeBatches.read('batch/one', { offset: 50, limit: 50 })
    expect(mocks.request).toHaveBeenLastCalledWith(
      'get',
      '/cae/batches/batch%2Fone?limit=50&offset=50',
      undefined,
      expect.any(Object),
    )
    caeBatches.retry('batch/one', ['job-a'])
    expect(mocks.request).toHaveBeenLastCalledWith(
      'post',
      '/cae/batches/batch%2Fone/retry',
      { job_ids: ['job-a'] },
      expect.objectContaining({ csrf: 'required' }),
    )
  })

  it('observes authenticated SSE and closes only the subscription', () => {
    const sources: FakeEventSource[] = []
    class FakeEventSource {
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      onmessage: ((message: { data: string }) => void) | null = null
      close = vi.fn()
      constructor(
        readonly url: string,
        readonly options: unknown,
      ) {
        sources.push(this)
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    const onEvent = vi.fn()
    const connection = vi.fn()
    const close = subscribeCaeEvents(42, onEvent, connection)
    expect(sources[0].url).toBe('/api/cae/events?after=42')
    expect(sources[0].options).toEqual({ withCredentials: true })
    sources[0].onopen?.()
    sources[0].onmessage?.({
      data: JSON.stringify({
        id: 43,
        type: 'job.succeeded',
        batch_id: 'b',
        measurement_id: 7,
        payload: {},
        created_at: '2026-09-07T00:00:00Z',
      }),
    })
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 43, measurement_id: 7 }))
    sources[0].onerror?.()
    expect(connection.mock.calls).toEqual([[true], [false]])
    close()
    expect(sources[0].close).toHaveBeenCalledOnce()
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
