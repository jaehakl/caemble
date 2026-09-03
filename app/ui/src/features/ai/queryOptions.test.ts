import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiQueryKeys } from './queryKeys'
import { aiProvidersQueryOptions } from './queryOptions'

afterEach(() => vi.unstubAllGlobals())

describe('AI provider Query policy', () => {
  it('isolates provider status by account', () => {
    expect(aiQueryKeys.providers('user:first')).not.toEqual(aiQueryKeys.providers('user:second'))
  })

  it('forwards the Query AbortSignal to the providers request', async () => {
    let fetchSignal: AbortSignal | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchSignal = init?.signal ?? null
        return new Response(JSON.stringify({ providers: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const controller = new AbortController()
    const options = aiProvidersQueryOptions('user:first', true)
    if (typeof options.queryFn !== 'function') throw new Error('AI providers queryFn is unavailable.')

    await options.queryFn({
      client: new QueryClient(),
      queryKey: options.queryKey,
      signal: controller.signal,
      meta: undefined,
    })

    expect(fetchSignal).toBe(controller.signal)
  })
})
