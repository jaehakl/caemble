import { expect, test, type Page, type Route } from '@playwright/test'

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

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status })
}

async function mockApi(page: Page, authenticated = false) {
  await page.route(apiPattern, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/me')
      return json(route, authenticated ? user : { detail: 'Not authenticated' }, authenticated ? 200 : 401)
    if (path === '/auth/refresh') return json(route, { detail: 'No refresh token' }, 401)
    if (path === '/web/jobs') return json(route, [])
    if (path === '/web/launchers/runtime') return json(route, [])
    if (path.endsWith('/list')) return json(route, { total: 0, items: [] })
    return json(route, { detail: `Unexpected mocked endpoint: ${path}` }, 404)
  })
}

test('uses the root Workbench as the only product route', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await expect(page.getByRole('menubar', { name: 'CAE 워크벤치 메뉴' })).toBeVisible()
  const toolbar = page.getByRole('toolbar', { name: 'CAE 빠른 작업' })
  await expect(toolbar.getByRole('button')).toHaveCount(10)
  await expect(toolbar.getByRole('button', { name: 'Launchers' })).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'Jobs' })).toBeVisible()

  await page.getByRole('menuitem', { name: 'Help' }).click()
  await page.getByRole('menuitem', { name: 'Geometry Catalog' }).click()
  await expect(page.getByRole('dialog', { name: 'Geometry Catalog' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Primitives & Operations' })).toBeVisible()
  await page.getByRole('button', { name: '닫기' }).click()

  for (const path of [
    '/cae',
    '/analysis',
    '/ai/chat',
    '/launchers',
    '/jobs',
    '/materials',
    '/account',
    '/login',
    '/docs',
    '/catalog/cad',
    '/viewer',
    '/structures',
    '/experiments',
    '/measurements',
    '/examples/example',
  ]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: '페이지를 찾을 수 없습니다' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  }

  for (const hash of ['#viewer', '#help']) {
    await page.goto(`/${hash}`)
    await expect(page.getByRole('heading', { name: '페이지를 찾을 수 없습니다' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/${hash}$`))
  }
})

test('opens authenticated Launchers and Jobs from the shared Toolbar actions', async ({ page }) => {
  const launcher = {
    id: 'launcher-1',
    user_id: user.id,
    launcher_name: 'gpu-workstation',
    ip_address: '127.0.0.1',
    status: 'busy',
    slave_app_ids: ['cae'],
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
    latest_progress: null,
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
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/me') return json(route, user)
    if (path === '/auth/refresh') return json(route, { detail: 'Unexpected refresh' }, 401)
    if (path === '/web/auth/csrf') return json(route, { csrf_token: 'csrf-browser-test' })
    if (path === '/web/crud/launchers/list') return json(route, { total: 1, items: [launcher] })
    if (path === '/web/launchers/runtime') {
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
    if (path === '/web/jobs') return json(route, [job])
    if (path.endsWith('/list')) return json(route, { total: 0, items: [] })
    return json(route, { detail: `Unexpected mocked endpoint: ${path}` }, 404)
  })

  await page.goto('/')
  const toolbar = page.getByRole('toolbar', { name: 'CAE 빠른 작업' })
  await toolbar.getByRole('button', { name: 'Launchers' }).click()
  await expect(page.getByRole('dialog', { name: 'Launchers' })).toContainText('gpu-workstation')
  await page.getByRole('button', { name: '닫기' }).click()

  await toolbar.getByRole('button', { name: 'Jobs' }).click()
  await expect(page.getByRole('dialog', { name: 'Jobs' })).toContainText('cae.simulation.start')
})
