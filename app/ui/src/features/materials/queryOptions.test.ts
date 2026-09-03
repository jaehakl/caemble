import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invalidateMaterialQueries } from './queryInvalidation'
import { materialQueryKeys } from './queryKeys'
import { materialsQueryOptions } from './queryOptions'

afterEach(() => vi.unstubAllGlobals())

describe('Material Query policy', () => {
  it('isolates account data and invalidates only the selected account scope', async () => {
    const client = new QueryClient()
    const first = materialQueryKeys.list('user:first', 'visible')
    const second = materialQueryKeys.list('user:second', 'visible')
    client.setQueryData(first, { items: [], total: 0 })
    client.setQueryData(second, { items: [], total: 0 })

    await invalidateMaterialQueries(client, 'user:first')

    expect(client.getQueryState(first)?.isInvalidated).toBe(true)
    expect(client.getQueryState(second)?.isInvalidated).toBe(false)
  })

  it('forwards the Query AbortSignal to the Material request', async () => {
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
    const options = materialsQueryOptions('public', 'visible')
    if (typeof options.queryFn !== 'function') throw new Error('Material queryFn is unavailable.')

    await options.queryFn({
      client: new QueryClient(),
      queryKey: options.queryKey,
      signal: controller.signal,
      meta: undefined,
    })

    expect(fetchSignal).toBe(controller.signal)
  })
})
