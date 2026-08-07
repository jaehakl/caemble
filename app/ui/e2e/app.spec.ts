import { expect, test, type Page, type Route } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const user = {
  id: 'd7929429-84f8-4d92-865d-dc638d8e64e0',
  email: 'designer@example.com',
  display_name: '김설계',
  picture_url: null,
  is_active: true,
  created_at: '2026-07-21T00:00:00Z',
  updated_at: '2026-07-21T00:00:00Z',
  roles: ['user'],
}
const apiPattern = /^http:\/\/127\.0\.0\.1:\d+\/api\//
const selectControlWarning = /Select is changing from (?:uncontrolled to controlled|controlled to uncontrolled)/i

test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => console.error(`[browser page error] ${error.message}`))
})

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status })
}

async function mockApi(page: Page, authenticated = false) {
  await page.route(apiPattern, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/me')
      return json(route, authenticated ? user : { detail: 'Not authenticated' }, authenticated ? 200 : 401)
    if (path === '/auth/refresh') return json(route, { detail: 'No refresh token' }, 401)
    if (path.endsWith('/list')) return json(route, { total: 0, items: [] })
    return json(route, { detail: 'Unexpected mocked endpoint' }, 404)
  })
}

test('supports direct public routes, legacy hashes, filters, and mobile navigation', async ({ page }) => {
  const consoleProblems: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await mockApi(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /CAD from Code/ })).toBeVisible()
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])

  await page.goto('/catalog/cad')
  await expect(page.getByText('11 entries')).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Primitives & Operations' })).toBeVisible()
  const cadSearch = page.getByLabel('Geometry 검색')
  await cadSearch.evaluate((element) => {
    const input = element as HTMLInputElement
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(input, 'subtract')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(page.getByRole('cell', { name: 'subtract' })).toBeVisible()

  await page.getByRole('link', { name: 'Material Catalog', exact: true }).click()
  await expect(page).toHaveURL(/\/catalog\/materials$/)
  await expect(page.getByText('260 entries')).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Material Parameters' })).toBeVisible()
  await expect(page.getByText('11 entries')).toHaveCount(0)

  await page.getByRole('link', { name: 'Quantity', exact: true }).click()
  await expect(page).toHaveURL(/\/catalog\/quantity-kinds$/)
  await expect(page.getByText('1,216 entries')).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Physical Quantity Kinds' })).toBeVisible()
  await expect(page.getByText('260 entries')).toHaveCount(0)

  await page.getByRole('link', { name: 'Physics', exact: true }).click()
  await expect(page).toHaveURL(/\/catalog\/solvers$/)
  await expect(page.getByText('2 entries')).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Simulations & Analysis' })).toBeVisible()
  await expect(page.getByText('1,216 entries')).toHaveCount(0)

  await page.goto('/catalog/cad/subtract')
  await expect(page.getByText('<subtract />')).toBeVisible()
  await page.getByRole('link', { name: 'Geometry', exact: true }).click()
  await expect(page).toHaveURL(/\/catalog\/cad$/)
  await expect(page.getByText('요소를 선택하세요')).toBeVisible()

  await page.goto('/#help')
  await expect(page).toHaveURL(/\/docs$/)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '메뉴 열기' }).click()
  await page.getByRole('link', { name: 'Material Catalog' }).click()
  await expect(page).toHaveURL(/\/catalog\/materials$/)
  await expect(page.getByText('260 entries')).toBeVisible()
  expect(pageErrors).toEqual([])
  expect(
    consoleProblems.filter(
      (message) => message !== 'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
    ),
  ).toEqual([])
})

test('restores an expired authenticated account through one refresh', async ({ page }) => {
  let meCalls = 0
  let refreshCalls = 0
  await page.route(apiPattern, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/me') {
      meCalls += 1
      return json(route, meCalls === 1 ? { detail: 'expired' } : user, meCalls === 1 ? 401 : 200)
    }
    if (path === '/auth/refresh') {
      refreshCalls += 1
      return json(route, { ok: true })
    }
    return json(route, { total: 0, items: [] })
  })

  await page.goto('/account')
  await expect(page.getByRole('heading', { name: '내 계정' })).toBeVisible()
  await expect(page.getByText('designer@example.com')).toBeVisible()
  expect(refreshCalls).toBe(1)
})

test('operates authenticated tokens, launchers, and jobs through the local web API', async ({ page }) => {
  const csrfToken = 'csrf-browser-test'
  const createdSecret = 'csk_secret_shown_once'
  const protectedRequests: { csrf: string | undefined; path: string }[] = []
  const actionPaths: string[] = []
  let csrfCalls = 0
  let createdTokenPayload: unknown = null

  const existingAccessKey = {
    id: 'access-key-1',
    user_id: user.id,
    key_type: 'user_api',
    name: 'existing-client',
    key_prefix: 'csk_existing',
    scopes: ['client'],
    status: 'active',
    last_used_at: null,
    expires_at: null,
    created_at: '2026-08-07T00:00:00Z',
    revoked_at: null,
  }
  const launcher = {
    id: 'launcher-1',
    user_id: user.id,
    launcher_name: 'gpu-workstation',
    ip_address: '127.0.0.1',
    status: 'busy',
    slave_app_ids: ['ai', 'cae'],
    connected_at: '2026-08-07T00:00:00Z',
    last_heartbeat_at: '2026-08-07T00:00:05Z',
    disconnected_at: null,
    created_at: '2026-08-07T00:00:00Z',
    updated_at: '2026-08-07T00:00:05Z',
  }
  const job = {
    id: 'job-1',
    user_id: user.id,
    handler_type: 'cae.simulation.start',
    slave_app_id: 'cae',
    state: 'running',
    latest_progress: {
      time: '2031-04-05T06:07:08Z',
      progress: { stage: 'solving', percent: 42 },
    },
    launcher_id: launcher.id,
    assigned_at: '2026-08-07T00:00:01Z',
    answer_ready_at: null,
    started_at: '2026-08-07T00:00:02Z',
    finished_at: null,
    cancel_requested_at: null,
    last_error: null,
    attempt_count: 1,
    created_at: '2026-08-07T00:00:00Z',
    updated_at: '2026-08-07T00:00:05Z',
  }

  await page.route(apiPattern, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    const method = request.method()
    if (path === '/auth/me') return json(route, user)
    if (path === '/auth/refresh') return json(route, { detail: 'Unexpected refresh' }, 401)
    if (path === '/web/auth/csrf') {
      csrfCalls += 1
      return json(route, { csrf_token: csrfToken })
    }
    if (method === 'POST' && path.startsWith('/web/')) {
      protectedRequests.push({ csrf: request.headers()['x-csrf-token'], path })
    }
    if (path === '/web/crud/access_keys/list' && method === 'POST') {
      return json(route, { total: 1, items: [existingAccessKey] })
    }
    if (path === '/web/users/me/access-tokens' && method === 'POST') {
      createdTokenPayload = request.postDataJSON()
      return json(route, {
        access_key: {
          ...existingAccessKey,
          id: 'access-key-2',
          name: 'browser-e2e',
          key_prefix: 'csk_created',
        },
        secret: createdSecret,
      })
    }
    if (path === '/web/crud/launchers/list' && method === 'POST') {
      return json(route, { total: 1, items: [launcher] })
    }
    if (path === '/web/launchers/runtime' && method === 'GET') {
      return json(route, [
        {
          launcher_id: launcher.id,
          current_job_id: job.id,
          loaded_slave_app_id: 'cae',
          worker_status: 'running',
          resetting: false,
          metadata: {},
        },
      ])
    }
    if (path === `/web/launchers/${launcher.id}/cancel-current-job` && method === 'POST') {
      actionPaths.push(path)
      return json(route, { ok: true })
    }
    if (path === '/web/jobs' && method === 'GET') return json(route, [job])
    if (path === `/web/jobs/${job.id}/kill` && method === 'POST') {
      actionPaths.push(path)
      return json(route, { ok: true })
    }
    return json(route, { detail: `Unexpected mocked endpoint: ${method} ${path}` }, 404)
  })

  await page.goto('/account')
  await expect(page.getByRole('heading', { name: '내 계정' })).toBeVisible()
  await expect(page.getByText('existing-client')).toBeVisible()
  await expect(page.getByText(createdSecret)).toHaveCount(0)
  await page.getByLabel('Token 이름').fill('browser-e2e')
  await page.getByRole('button', { name: '생성', exact: true }).click()
  await expect(page.getByText(createdSecret)).toBeVisible()
  await expect(page.getByText(/다시 표시되지 않습니다/)).toBeVisible()
  expect(createdTokenPayload).toEqual({
    name: 'browser-e2e',
    scopes: ['client'],
    expires_at: null,
  })

  await page.goto('/launchers')
  await expect(page.getByRole('heading', { level: 2, name: 'Launchers' })).toBeVisible()
  await expect(page.getByText('gpu-workstation')).toBeVisible()
  await expect(page.getByText('busy', { exact: true })).toBeVisible()
  await expect(page.getByText('running', { exact: true })).toBeVisible()
  await expect(page.getByText(job.id, { exact: true })).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '취소', exact: true }).click()
  await expect(page.getByText('현재 Job 취소를 요청했습니다.')).toBeVisible()

  await page.goto('/jobs')
  await expect(page.getByRole('heading', { level: 2, name: 'Jobs' })).toBeVisible()
  await expect(page.getByText('cae.simulation.start')).toBeVisible()
  await expect(page.getByText('{"stage":"solving","percent":42}')).toBeVisible()
  await expect(page.getByText(/2031/)).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '중단', exact: true }).click()
  await expect(page.getByText('Job 중단을 요청했습니다.')).toBeVisible()

  await page.goto('/account')
  await expect(page.getByText(createdSecret)).toHaveCount(0)

  expect(actionPaths).toEqual(['/web/launchers/launcher-1/cancel-current-job', '/web/jobs/job-1/kill'])
  expect(csrfCalls).toBeGreaterThan(0)
  expect(protectedRequests.length).toBeGreaterThanOrEqual(5)
  expect(protectedRequests.every((request) => request.csrf === csrfToken)).toBe(true)
})

test('Structure editor and isolated runner survive delayed Monaco loading and remounts', async ({ page }) => {
  test.setTimeout(90_000)
  const isolationProblems: string[] = []
  const pageErrors: string[] = []
  const forbiddenMessage =
    /UNKNOWN service|ICodeLensCache|IInlayHintsCache|ISuggestMemories|treeViewsDndService|actionWidgetService|allow-scripts.+allow-same-origin|connect-src 'none'.+(?:WebSocket|ws:)/i
  page.on('console', (message) => {
    if (forbiddenMessage.test(message.text()) || selectControlWarning.test(message.text())) {
      isolationProblems.push(message.text())
    }
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await mockApi(page)
  await page.route('**/tsMode-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750))
    await route.continue()
  })

  await page.goto('/structures?structure=new&mode=code')
  const editorInput = page.getByRole('textbox', { name: 'Editor content' }).first()
  await expect(editorInput).toBeVisible({ timeout: 20_000 })
  await editorInput.focus()
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
    .toBe('Editor content')
  await page.keyboard.type(' ')
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible({ timeout: 20_000 })

  const runner = page.locator('iframe[title="Caemble isolated runner"], iframe[src*="runner.html"]').first()
  await expect(runner).toHaveCount(1)
  const runnerSource = await runner.getAttribute('src')
  expect(runnerSource).not.toBeNull()
  expect(new URL(runnerSource!).origin).not.toBe(new URL(page.url()).origin)

  await page.getByRole('link', { name: 'Manual', exact: true }).click()
  await expect(page).toHaveURL(/\/docs$/)
  await page.goto('/structures?structure=new&mode=code')
  await expect(page).toHaveURL(/\/structures\?.*structure=new.*mode=code/)
  await expect(page.getByRole('textbox', { name: 'Editor content' }).first()).toBeVisible({ timeout: 20_000 })
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Editor content' }).first()).toBeVisible({ timeout: 20_000 })

  expect(pageErrors).toEqual([])
  expect(isolationProblems).toEqual([])
})

test('creates a Structure definition from the legacy Viewer hash redirect', async ({ page }) => {
  let structurePayload: unknown = null
  const selectWarnings: string[] = []
  page.on('console', (message) => {
    if (selectControlWarning.test(message.text())) selectWarnings.push(message.text())
  })
  await page.route(apiPattern, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/me') return json(route, user)
    if (path.endsWith('/list')) return json(route, { total: 0, items: [] })
    if (path === '/structure/save') {
      structurePayload = route.request().postDataJSON()
      return json(route, { id: 101, action: 'created', parentId: null })
    }
    return json(route, { detail: 'Unexpected mocked endpoint' }, 404)
  })

  await page.goto('/#viewer')
  await page.getByRole('button', { name: 'Structure 생성' }).click()
  const dialog = page.getByRole('dialog', { name: '새 Structure 생성' })
  await dialog.getByLabel('이름').fill('E2E Structure')
  await dialog.getByRole('button', { name: 'Structure 생성' }).click()
  await expect.poll(() => structurePayload).not.toBeNull()
  expect(structurePayload).toEqual(
    expect.objectContaining({
      name: 'E2E Structure',
      description: null,
      code: expect.any(String),
      rawCodeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      semanticHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      semanticHashVersion: 1,
    }),
  )
  await expect(page).toHaveURL(/structure=101/)
  expect(selectWarnings).toEqual([])
})

test('blocks the verified v3 uniform-bar example while signed out', async ({ page }) => {
  test.setTimeout(90_000)
  const pageErrors: string[] = []
  const consoleProblems: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || selectControlWarning.test(message.text())) {
      consoleProblems.push(message.text())
    }
  })
  await mockApi(page)

  await page.goto('/examples/dc-uniform-bar')
  await expect(page.getByRole('heading', { name: 'DC Uniform Bar' })).toBeVisible()

  const run = page.getByRole('button', { name: 'Run simulation' })
  await expect(run).toBeDisabled({ timeout: 60_000 })

  expect(pageErrors).toEqual([])
  expect(
    consoleProblems.filter(
      (message) => message !== 'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
    ),
  ).toEqual([])
})
