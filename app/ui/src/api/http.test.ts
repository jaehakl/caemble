import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { delay, http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
  vi.resetModules()
})
afterAll(() => server.close())

async function loadClient() {
  vi.stubEnv('VITE_API_BASE_URL', 'http://api.test')
  return import('./http')
}

describe('native fetch API client', () => {
  it('protects every state-changing cookie request with a CSRF token', async () => {
    let csrfCalls = 0
    server.use(
      http.get('http://api.test/web/auth/csrf', () => {
        csrfCalls += 1
        return HttpResponse.json({ csrf_token: 'csrf-value' })
      }),
      http.post('http://api.test/geometry/publish/plan', ({ request }) =>
        request.headers.get('x-csrf-token') === 'csrf-value'
          ? HttpResponse.json({ ok: true })
          : HttpResponse.json({ detail: 'CSRF token required' }, { status: 403 }),
      ),
      http.put('http://api.test/ai/providers/openai/credential', ({ request }) =>
        request.headers.get('x-csrf-token') === 'csrf-value'
          ? HttpResponse.json({ configured: true })
          : HttpResponse.json({ detail: 'CSRF token required' }, { status: 403 }),
      ),
    )

    const { request } = await loadClient()
    await expect(request<{ ok: boolean }>('post', '/geometry/publish/plan', {})).resolves.toEqual({ ok: true })
    await expect(
      request<{ configured: boolean }>('put', '/ai/providers/openai/credential', { apiKey: 'sk-secret' }),
    ).resolves.toEqual({ configured: true })
    expect(csrfCalls).toBe(1)
  })

  it('refreshes once and retries the original request once after a 401', async () => {
    let resourceCalls = 0
    let refreshCalls = 0
    server.use(
      http.get('http://api.test/private', () => {
        resourceCalls += 1
        return resourceCalls === 1
          ? HttpResponse.json({ detail: 'expired' }, { status: 401 })
          : HttpResponse.json({ ok: true })
      }),
      http.get('http://api.test/auth/refresh', () => {
        refreshCalls += 1
        return HttpResponse.json({ ok: true })
      }),
    )

    const { request } = await loadClient()
    await expect(request<{ ok: boolean }>('get', '/private')).resolves.toEqual({ ok: true })
    expect(resourceCalls).toBe(2)
    expect(refreshCalls).toBe(1)
  })

  it('shares one refresh promise across concurrent expired requests', async () => {
    const calls = new Map<string, number>()
    let refreshCalls = 0
    server.use(
      http.get('http://api.test/:resource', ({ params }) => {
        const resource = String(params.resource)
        const count = (calls.get(resource) ?? 0) + 1
        calls.set(resource, count)
        return count === 1 ? HttpResponse.json({ detail: 'expired' }, { status: 401 }) : HttpResponse.json({ resource })
      }),
      http.get('http://api.test/auth/refresh', async () => {
        refreshCalls += 1
        await delay(20)
        return HttpResponse.json({ ok: true })
      }),
    )

    const { request } = await loadClient()
    await expect(
      Promise.all([request<{ resource: string }>('get', '/first'), request<{ resource: string }>('get', '/second')]),
    ).resolves.toEqual([{ resource: 'first' }, { resource: 'second' }])
    expect(refreshCalls).toBe(1)
  })

  it('surfaces a refresh failure without retrying forever', async () => {
    let resourceCalls = 0
    server.use(
      http.get('http://api.test/private', () => {
        resourceCalls += 1
        return HttpResponse.json({ detail: 'expired' }, { status: 401 })
      }),
      http.get('http://api.test/auth/refresh', () => HttpResponse.json({ detail: 'expired refresh' }, { status: 401 })),
    )

    const { request } = await loadClient()
    await expect(request('get', '/private')).rejects.toEqual(expect.objectContaining({ status: 401 }))
    expect(resourceCalls).toBe(1)
  })

  it('uses a structured API detail message instead of stringifying the object', async () => {
    server.use(
      http.post('http://api.test/catalog/runtime-slice', () =>
        HttpResponse.json(
          { detail: { code: 'catalog_not_found', message: 'Unknown Solver: missing@1.0.0' } },
          { status: 404 },
        ),
      ),
    )

    const { request } = await loadClient()
    await expect(request('post', '/catalog/runtime-slice', {})).rejects.toMatchObject({
      message: 'Unknown Solver: missing@1.0.0',
      status: 404,
    })
  })
})
