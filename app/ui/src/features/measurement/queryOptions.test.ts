import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getListRequest } from '@/api'
import { measurementsQueryOptions } from './queryOptions'

afterEach(() => vi.unstubAllGlobals())

describe('measurement query options', () => {
  it('forwards the TanStack Query AbortSignal to fetch', async () => {
    let fetchSignal: AbortSignal | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchSignal = init?.signal ?? null
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const controller = new AbortController()
    const options = measurementsQueryOptions('public', null, getListRequest())
    const queryFn = options.queryFn
    if (typeof queryFn !== 'function') throw new Error('Measurement queryFn is unavailable.')

    await queryFn({
      client: new QueryClient(),
      queryKey: options.queryKey,
      signal: controller.signal,
      meta: undefined,
    })

    expect(fetchSignal).toBe(controller.signal)
  })
})
