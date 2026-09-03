import { dbTables } from '@/api/api'
import { ApiContractError, request } from '@/api/http'
import { parseGetListResponse, parseUpsertResponseList } from '@/contracts/api/validators'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const tableSurface = {
  User: ['recordType', 'fetchMe', 'getAllUsersAdmin', 'deleteUserAdmin', 'getUserSummaryAdmin', 'getUserSummaryUser'],
  AccessKey: ['list', 'create', 'revoke'],
  Launcher: ['list', 'runtime', 'reconcile', 'cancelCurrentJob', 'resetWorker'],
  Job: ['list', 'kill'],
  Material: ['recordType', 'listRows', 'upsertRow', 'deleteRows'],
  MaterialName: ['recordType', 'listRows', 'upsertRow', 'deleteRows'],
  MaterialParameter: ['recordType', 'listRows', 'upsertRow', 'deleteRows'],
  MaterialParameterQualifier: ['recordType', 'listRows', 'upsertRow', 'deleteRows'],
  Experiment: ['recordType', 'listRows', 'save', 'deleteRows', 'usage', 'available', 'demoCandidates', 'replaceDemos'],
  ExperimentRecord: ['recordType', 'listRows'],
  Measurement: ['recordType', 'listRows', 'create', 'record', 'readRecordedData', 'deleteRows'],
  RecordedData: ['recordType', 'listRows'],
  Calculation: ['recordType', 'listRows', 'upsertRow', 'deleteRows'],
  CalculationData: ['recordType', 'listRows', 'analysis', 'analysisStatus', 'missing', 'save', 'scalars'],
} as const

assert(
  JSON.stringify(Object.keys(dbTables)) === JSON.stringify(Object.keys(tableSurface)),
  'dbTables keys must remain stable',
)
for (const tableName of Object.keys(tableSurface) as (keyof typeof tableSurface)[]) {
  assert(
    JSON.stringify(Object.keys(dbTables[tableName])) === JSON.stringify(tableSurface[tableName]),
    `dbTables.${tableName} methods must remain stable`,
  )
}

type FetchCall = Readonly<{
  path: string
  csrf: string | null
  signal: AbortSignal | null
}>

const calls: FetchCall[] = []

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://caemble.test')
  calls.push({
    path: url.pathname,
    csrf: new Headers(init?.headers).get('x-csrf-token'),
    signal: init?.signal ?? null,
  })

  if (url.pathname === '/api/web/auth/csrf') return jsonResponse({ csrf_token: 'contract-test-token' })
  if (url.pathname === '/api/boundary/required') return jsonResponse({ ok: true })
  if (url.pathname === '/api/web/explicit-omit') return jsonResponse({ ok: true })
  if (url.pathname === '/api/boundary/list') return jsonResponse({ items: [{ id: 1 }], total: 1 })
  if (url.pathname === '/api/boundary/invalid-list') return jsonResponse({ items: {}, total: -1 })
  if (url.pathname === '/api/measurement/create') return jsonResponse({ id: 7 })
  if (url.pathname === '/api/experiment/list') return jsonResponse({ items: [], total: 0 })
  throw new Error(`Unexpected request: ${url.pathname}`)
}

const requestController = new AbortController()
await request<{ ok: true }>('post', '/boundary/required', undefined, {
  csrf: 'required',
  signal: requestController.signal,
})
const requiredCall = calls.find((call) => call.path === '/api/boundary/required')
assert(requiredCall?.csrf === 'contract-test-token', 'Explicit required policy must attach a CSRF token')
assert(requiredCall.signal === requestController.signal, 'Request signal must be forwarded to fetch')

const csrfCallCount = calls.filter((call) => call.path === '/api/web/auth/csrf').length
await request<{ ok: true }>('post', '/web/explicit-omit', undefined, { csrf: 'omit' })
const omittedCall = calls.find((call) => call.path === '/api/web/explicit-omit')
assert(omittedCall?.csrf === null, 'Explicit omit policy must override path-based CSRF behavior')
assert(
  calls.filter((call) => call.path === '/api/web/auth/csrf').length === csrfCallCount,
  'Explicit omit policy must not fetch another CSRF token',
)

const list = await request<{ items: { id: number }[]; total: number }>('post', '/boundary/list', undefined, {
  csrf: 'omit',
  validate: parseGetListResponse<{ id: number }>,
})
assert(list.total === 1 && list.items[0]?.id === 1, 'Valid list envelopes must pass boundary validation')

let contractError: unknown
try {
  await request('post', '/boundary/invalid-list', undefined, {
    csrf: 'omit',
    validate: parseGetListResponse,
  })
} catch (error: unknown) {
  contractError = error
}
assert(contractError instanceof ApiContractError, 'Invalid responses must be reported as ApiContractError')
assert(contractError.path === '/boundary/invalid-list', 'Contract errors must identify the endpoint')

const abortedController = new AbortController()
const abortReason = new Error('cancelled before request')
abortedController.abort(abortReason)
const callCountBeforeAbort = calls.length
let abortedError: unknown
try {
  await request('get', '/boundary/never-fetched', undefined, { signal: abortedController.signal })
} catch (error: unknown) {
  abortedError = error
}
assert(abortedError === abortReason, 'A pre-aborted signal must preserve its abort reason')
assert(calls.length === callCountBeforeAbort, 'A pre-aborted request must not call fetch')

const measurement = await dbTables.Measurement.create({
  experiment_id: 1,
  experiment_source_hash: 'source-hash',
  vars: {},
  material_parameters: { experiment: { materials: {} }, tasks: {} },
})
assert(measurement.id === 7, 'Measurement create must validate and return its id response')
const measurementCall = calls.find((call) => call.path === '/api/measurement/create')
assert(measurementCall?.csrf === null, 'Measurement create must retain its anonymous-compatible CSRF policy')

const experiments = await dbTables.Experiment.listRows()
assert(experiments.total === 0, 'Experiment list must validate its list envelope')
const experimentCall = calls.find((call) => call.path === '/api/experiment/list')
assert(experimentCall?.csrf === 'contract-test-token', 'Experiment list must retain its CSRF policy')

const upserts = parseUpsertResponseList([{ id: 1 }, { id: 2, created: true }])
assert(upserts.length === 2 && upserts[1]?.id === 2, 'Upsert envelopes must validate every id')

console.log('API contract boundary tests passed.')
