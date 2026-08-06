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

async function responseBody(response: Response) {
  if (response.status === 204) return undefined
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return response.json()
  const text = await response.text()
  return text || undefined
}

async function send<T>(method: HttpMethod, url: string, data?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${url}`, {
    method: method.toUpperCase(),
    credentials: 'include',
    headers: data === undefined ? undefined : { 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const body = await responseBody(response)
  if (!response.ok) {
    const detail =
      typeof body === 'object' && body !== null && 'detail' in body
        ? String(body.detail)
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
