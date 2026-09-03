import { request } from '@/api/http'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const calls: Array<{ method: string; path: string; csrf: string | null }> = []
let csrfIssueCount = 0
let demoSaveAttemptCount = 0

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, 'http://caemble.test')
  const method = init?.method ?? 'GET'
  const csrf = new Headers(init?.headers).get('x-csrf-token')
  calls.push({ method, path: url.pathname, csrf })

  if (url.pathname === '/api/web/auth/csrf') {
    csrfIssueCount += 1
    return jsonResponse({ csrf_token: `csrf-${csrfIssueCount}` })
  }
  if (url.pathname === '/api/admin/demo-experiments') {
    demoSaveAttemptCount += 1
    if (demoSaveAttemptCount === 2) return jsonResponse({ detail: 'Invalid CSRF token' }, 403)
    return jsonResponse({ mine: [], demos: [] })
  }
  if (url.pathname === '/api/user_admin/user-2') return jsonResponse(true)
  if (url.pathname === '/api/calculation_data/analysis') return jsonResponse({ total: 0, items: [] })
  throw new Error(`Unexpected request: ${method} ${url.pathname}`)
}

await request('put', '/admin/demo-experiments', {
  experiment_ids: [1],
  default_experiment_id: 1,
})
await request('delete', '/user_admin/user-2')
await request('put', '/admin/demo-experiments', {
  experiment_ids: [1],
  default_experiment_id: 1,
})
await request('post', '/calculation_data/analysis', { experiment_id: 1 })

const csrfCalls = calls.filter((call) => call.path === '/api/web/auth/csrf')
const demoSaveCalls = calls.filter((call) => call.path === '/api/admin/demo-experiments')
const deleteUserCall = calls.find((call) => call.path === '/api/user_admin/user-2')
const anonymousAnalysisCall = calls.find((call) => call.path === '/api/calculation_data/analysis')

assert(csrfCalls.length === 2, 'CSRF token must be issued initially and refreshed once after a 403')
assert(demoSaveCalls.length === 3, 'Demo save must retry exactly once after a CSRF 403')
assert(demoSaveCalls[0]?.csrf === 'csrf-1', 'Demo save must include the issued CSRF token')
assert(demoSaveCalls[1]?.csrf === 'csrf-1', 'Demo save must reuse the current CSRF token')
assert(demoSaveCalls[2]?.csrf === 'csrf-2', 'Demo save retry must include the refreshed CSRF token')
assert(deleteUserCall?.csrf === 'csrf-1', 'Admin user deletion must include the issued CSRF token')
assert(anonymousAnalysisCall?.csrf === null, 'Anonymous Analysis POST must not request or include a CSRF token')

console.log('HTTP CSRF routing tests passed.')
