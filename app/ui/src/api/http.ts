export const API_URL = (import.meta.env.VITE_API_BASE_URL?.trim() || '/api').replace(/\/+$/, '')

export type HttpMethod = 'get' | 'post' | 'put' | 'delete'

export class ApiError extends Error {
  readonly body: unknown
  readonly status: number

  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

let refreshPromise: Promise<void> | null = null
let csrfPromise: Promise<string> | null = null
let csrfToken: string | null = null

async function responseBody(response: Response) {
  if (response.status === 204) return undefined
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return response.json()
  const text = await response.text()
  return text || undefined
}

async function fetchCsrfToken(): Promise<string> {
  const response = await fetch(`${API_URL}/web/auth/csrf`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  const body = await responseBody(response)
  if (!response.ok) throw new ApiError(response.status, 'CSRF 토큰을 가져오지 못했습니다.', body)
  if (typeof body !== 'object' || body === null || !('csrf_token' in body) || typeof body.csrf_token !== 'string') {
    throw new Error('CSRF token response is missing csrf_token')
  }
  const token = body.csrf_token
  csrfToken = token
  return token
}

async function ensureCsrfToken() {
  if (csrfToken) return csrfToken
  csrfPromise ??= fetchCsrfToken().finally(() => {
    csrfPromise = null
  })
  return csrfPromise
}

async function send<T>(method: HttpMethod, url: string, data?: unknown, retryCsrf = true): Promise<T> {
  const csrfProtected =
    method !== 'get' &&
    (url.startsWith('/web/') ||
      url.startsWith('/geometry/') ||
      url === '/auth/geometry-namespace' ||
      url === '/experiment/save')
  const headers = new Headers(data === undefined ? undefined : { 'content-type': 'application/json' })
  if (csrfProtected) headers.set('X-CSRF-Token', await ensureCsrfToken())
  const response = await fetch(`${API_URL}${url}`, {
    method: method.toUpperCase(),
    credentials: 'include',
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const body = await responseBody(response)
  if (csrfProtected && retryCsrf && response.status === 403) {
    csrfToken = null
    return send<T>(method, url, data, false)
  }
  if (!response.ok) {
    const rawDetail = typeof body === 'object' && body !== null && 'detail' in body ? body.detail : undefined
    const detail =
      typeof rawDetail === 'string'
        ? rawDetail
        : typeof rawDetail === 'object' &&
            rawDetail !== null &&
            'message' in rawDetail &&
            typeof rawDetail.message === 'string'
          ? rawDetail.message
          : `API 요청에 실패했습니다. (${response.status})`
    throw new ApiError(response.status, detail, body)
  }
  return body as T
}

async function refreshAuth() {
  refreshPromise ??= send<{ ok: true }>('get', '/auth/refresh')
    .then(() => undefined)
    .finally(() => {
      refreshPromise = null
    })
  await refreshPromise
}

export async function request<T>(method: HttpMethod, url: string, data?: unknown): Promise<T> {
  try {
    return await send<T>(method, url, data)
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || url === '/auth/refresh') throw error
    await refreshAuth()
    return send<T>(method, url, data)
  }
}
