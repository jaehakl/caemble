import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogQueryKeys } from '@/api/catalog'
import {
  catalogSearchQueryOptions,
  catalogMaterialModelsInfiniteQueryOptions,
  catalogMaterialModelsQueryOptions,
  catalogQuantityKindsInfiniteQueryOptions,
  catalogQuantityKindsQueryOptions,
  recordedDataRuntimeQueryOptions,
} from './queryOptions'

afterEach(() => vi.unstubAllGlobals())

describe('Catalog Query policy', () => {
  it('keeps finite and infinite response shapes in distinct cache entries', () => {
    const query = { q: 'steel', limit: 100 } as const

    expect(catalogQuantityKindsQueryOptions(query).queryKey).not.toEqual(
      catalogQuantityKindsInfiniteQueryOptions(query).queryKey,
    )
    expect(catalogMaterialModelsQueryOptions(query).queryKey).not.toEqual(
      catalogMaterialModelsInfiniteQueryOptions(query).queryKey,
    )
  })

  it('includes the result limit in catalog search cache identity', () => {
    expect(catalogSearchQueryOptions('beam', 50).queryKey).not.toEqual(catalogSearchQueryOptions('beam', 100).queryKey)
  })

  it('forwards the Query AbortSignal through a catalog list request', async () => {
    let fetchSignal: AbortSignal | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchSignal = init?.signal ?? null
        return new Response(JSON.stringify({ items: [], nextCursor: null, total: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const controller = new AbortController()
    const options = catalogMaterialModelsQueryOptions({ q: 'steel', limit: 100 })
    if (typeof options.queryFn !== 'function') throw new Error('Catalog list queryFn is unavailable.')

    await options.queryFn({
      client: new QueryClient(),
      queryKey: options.queryKey,
      signal: controller.signal,
      meta: undefined,
    })

    expect(fetchSignal).toBe(controller.signal)
  })

  it('keeps the recorded-data runtime key and forwards its Query AbortSignal', async () => {
    let fetchSignal: AbortSignal | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchSignal = init?.signal ?? null
        return new Response(
          JSON.stringify({
            catalogRevision: 'test',
            solvers: [],
            quantityKinds: [],
            materialModels: [],
            warnings: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    const quantityKinds = ['length', 'time'] as const
    const controller = new AbortController()
    const options = recordedDataRuntimeQueryOptions(quantityKinds)
    if (typeof options.queryFn !== 'function') throw new Error('Catalog runtime queryFn is unavailable.')

    await options.queryFn({
      client: new QueryClient(),
      queryKey: options.queryKey,
      signal: controller.signal,
      meta: undefined,
    })

    expect(options.queryKey).toEqual(catalogQueryKeys.recordedDataRuntime(quantityKinds))
    expect(fetchSignal).toBe(controller.signal)
  })
})
