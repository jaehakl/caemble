export const API_URL = (import.meta.env.VITE_API_BASE_URL?.trim() || '/api').replace(/\/+$/, '')

export type HttpMethod = 'get' | 'post' | 'put' | 'delete'
export type CsrfPolicy = 'auto' | 'required' | 'omit'
export type ResponseValidator<T> = (body: unknown) => T
export type RequestContext = Readonly<{ signal?: AbortSignal }>

export type RequestOptions<T> = RequestContext &
  Readonly<{
    csrf?: CsrfPolicy
    validate?: ResponseValidator<T>
  }>

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

export class ApiContractError extends Error {
  readonly method: HttpMethod
  readonly path: string
  readonly validationError: unknown

  constructor(method: HttpMethod, path: string, validationError: unknown) {
    const detail = validationError instanceof Error ? validationError.message : String(validationError)
    super(`API 응답 계약이 일치하지 않습니다. (${method.toUpperCase()} ${path}): ${detail}`)
    this.name = 'ApiContractError'
    this.method = method
    this.path = path
    this.validationError = validationError
  }
}

let refreshPromise: Promise<void> | null = null
let csrfPromise: Promise<string> | null = null
let csrfToken: string | null = null

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

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

async function send<T>(
  method: HttpMethod,
  url: string,
  data?: unknown,
  retryCsrf = true,
  options: RequestOptions<T> = {},
): Promise<T> {
  options.signal?.throwIfAborted()
  const csrfPolicy = options.csrf ?? 'auto'
  const csrfProtected =
    method !== 'get' &&
    (csrfPolicy === 'required' ||
      (csrfPolicy === 'auto' &&
        (url.startsWith('/web/') ||
          url.startsWith('/ai/') ||
          url.startsWith('/experiment/') ||
          url.startsWith('/admin/') ||
          url.startsWith('/user_admin/'))))
  const headers = new Headers(data === undefined ? undefined : { 'content-type': 'application/json' })
  if (csrfProtected) headers.set('X-CSRF-Token', await waitForSignal(ensureCsrfToken(), options.signal))
  const response = await fetch(`${API_URL}${url}`, {
    method: method.toUpperCase(),
    credentials: 'include',
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: options.signal,
  })
  const body = await responseBody(response)
  if (csrfProtected && retryCsrf && response.status === 403) {
    csrfToken = null
    return send<T>(method, url, data, false, options)
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
  if (!options.validate) return body as T
  try {
    return options.validate(body)
  } catch (error: unknown) {
    throw new ApiContractError(method, url, error)
  }
}

async function refreshAuth() {
  refreshPromise ??= send<unknown>('get', '/auth/refresh')
    .then(() => undefined)
    .finally(() => {
      refreshPromise = null
    })
  await refreshPromise
}

export async function request<T>(
  method: HttpMethod,
  url: string,
  data?: unknown,
  options: RequestOptions<T> = {},
): Promise<T> {
  try {
    return await send<T>(method, url, data, true, options)
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || url === '/auth/refresh') throw error
    await waitForSignal(refreshAuth(), options.signal)
    return send<T>(method, url, data, true, options)
  }
}
