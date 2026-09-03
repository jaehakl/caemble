import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authQueryOptions } from './queryOptions'

afterEach(() => vi.unstubAllGlobals())

describe('auth query options', () => {
  it('normalizes an expired access and refresh session to an anonymous user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'Not authenticated' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    const queryFn = authQueryOptions.queryFn
    if (typeof queryFn !== 'function') throw new Error('Auth queryFn is unavailable.')

    await expect(
      queryFn({
        client: new QueryClient(),
        queryKey: authQueryOptions.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
      }),
    ).resolves.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
