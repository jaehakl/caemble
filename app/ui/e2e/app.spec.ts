import { expect, test, type Page, type Route } from '@playwright/test'

const user = {
  id: 'd7929429-84f8-4d92-865d-dc638d8e64e0',
  email: 'designer@example.com',
  display_name: '김설계',
  picture_url: null,
  is_active: true,
  created_at: '2026-07-21T00:00:00Z',
  updated_at: '2026-07-21T00:00:00Z',
  geometry_namespace: 'designer',
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

test('uses the root Workbench and opens integrated documentation in a new window', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  await expect(page.getByRole('menubar', { name: 'CAE 워크벤치 메뉴' })).toBeVisible()
  const toolbar = page.getByRole('toolbar', { name: 'CAE 빠른 작업' })
  await expect(toolbar.getByRole('button')).toHaveCount(8)
  await expect(toolbar.getByRole('button', { name: 'Jobs' })).toBeVisible()

  await page.getByRole('menuitem', { name: 'Help' }).click()
  await page.getByRole('menuitem', { name: 'AI Helper' }).click()
  await expect(page.getByRole('dialog', { name: 'AI Helper' })).toBeVisible()
  await page.getByRole('button', { name: '닫기' }).click()

  await page.getByRole('menuitem', { name: 'Help' }).click()
  const manualPagePromise = page.waitForEvent('popup')
  await page.getByRole('menuitem', { name: 'Manual' }).click()
  const manualPage = await manualPagePromise
  await expect(manualPage).toHaveURL(/\/docs\?section=program$/)
  await manualPage.close()

  await page.getByRole('menuitem', { name: 'Help' }).click()
  const docsPagePromise = page.waitForEvent('popup')
  await page.getByRole('menuitem', { name: 'Geometry Catalog' }).click()
  const docsPage = await docsPagePromise
  await expect(docsPage).toHaveURL(/\/docs\?section=geometry$/)
  await expect(docsPage.getByRole('heading', { name: 'Primitives & Operations' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Geometry Catalog' })).toHaveCount(0)
  await docsPage.close()

  for (const path of [
    '/cae',
    '/analysis',
    '/ai/chat',
    '/launchers',
    '/jobs',
    '/materials',
    '/account',
    '/login',
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

test('opens authenticated Launchers from Settings and Jobs from the shared Toolbar actions', async ({ page }) => {
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
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Launchers' }).click()
  await expect(page.getByRole('dialog', { name: 'Launchers' })).toContainText('gpu-workstation')
  await page.getByRole('button', { name: '닫기' }).click()

  await toolbar.getByRole('button', { name: 'Jobs' }).click()
  await expect(page.getByRole('dialog', { name: 'Jobs' })).toContainText('cae.simulation.start')
})

test('manages paged Geometry packages, exact versions, references, and the default namespace', async ({ page }) => {
  const timestamp = '2026-08-13T00:00:00Z'
  const coordinate = 'caemble:geometry/designer/common/plate@1.2.3'
  const hash = 'a'.repeat(64)
  const repository = {
    id: 1,
    user_id: user.id,
    namespace: 'designer',
    slug: 'common',
    description: 'Reusable parts',
    archived_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  }
  const geometryPackage = {
    id: 2,
    repository_id: repository.id,
    name: 'plate',
    user_id: user.id,
    namespace: repository.namespace,
    repository: repository.slug,
    repository_archived_at: null,
    version_count: 1,
    latest_version: '1.2.3',
    created_at: timestamp,
    updated_at: timestamp,
  }
  const version = {
    id: 3,
    package_id: geometryPackage.id,
    version_major: 1,
    version_minor: 2,
    version_patch: 3,
    description: 'Stable plate',
    source:
      "import { type Geometry } from '@caemble/core'; const Plate: Geometry = () => <box size={[1, 1, 1]} />; export default Plate;",
    source_hash: hash,
    module_hash: hash,
    module_format_version: 2,
    cad_api_version: 5,
    archived_at: null,
    repository_id: repository.id,
    namespace: repository.namespace,
    repository: repository.slug,
    package_name: geometryPackage.name,
    coordinate,
    version: '1.2.3',
    created_at: timestamp,
    updated_at: timestamp,
  }
  let experimentSearch: string | null = null

  await page.route(apiPattern, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/me') return json(route, user)
    if (path === '/auth/refresh') return json(route, { detail: 'Unexpected refresh' }, 401)
    if (path === '/web/auth/csrf') return json(route, { csrf_token: 'csrf-geometry-manager' })
    if (path === '/auth/geometry-namespace') {
      const body = route.request().postDataJSON() as { namespace: string }
      return json(route, { ...user, geometry_namespace: body.namespace })
    }
    if (path === '/geometry/repositories/list') return json(route, { total: 1, items: [repository] })
    if (path === '/geometry/packages/list') return json(route, { total: 1, items: [geometryPackage] })
    if (path === '/geometry/versions/list') return json(route, { total: 1, items: [version] })
    if (path === `/geometry/versions/${version.id}/resolve`) {
      return json(route, {
        schemaVersion: 1,
        root: { geometryVersionId: version.id, coordinate, moduleHash: hash },
        modules: [
          {
            geometryVersionId: version.id,
            coordinate,
            moduleFormatVersion: 2,
            cadApiVersion: 5,
            description: version.description,
            source: version.source,
            sourceHash: hash,
            moduleHash: hash,
            imports: [],
          },
        ],
      })
    }
    if (path === '/geometry/versions/usage') {
      return json(route, {
        items: [
          {
            versionId: version.id,
            dependentVersionIds: [],
            dependentVersionCount: 0,
            experimentCount: 1,
            deletable: false,
          },
        ],
      })
    }
    if (path === `/geometry/versions/${version.id}/dependents/list`) {
      return json(route, { total: 0, items: [] })
    }
    if (path === `/geometry/versions/${version.id}/experiments/list`) {
      experimentSearch = (route.request().postDataJSON() as { search_text: string | null }).search_text
      return json(route, {
        total: 1,
        items: [
          {
            id: 7,
            user_id: user.id,
            parent_id: null,
            name: 'Bracket study',
            description: 'Uses the plate indirectly',
            root_alias: null,
            created_at: timestamp,
            updated_at: timestamp,
          },
        ],
      })
    }
    if (path === '/web/jobs') return json(route, [])
    if (path === '/web/launchers/runtime') return json(route, [])
    if (path.endsWith('/list')) return json(route, { total: 0, items: [] })
    return json(route, { detail: `Unexpected mocked endpoint: ${path}` }, 404)
  })

  await page.goto('/')
  await page.getByRole('menuitem', { name: 'Source' }).click()
  await page.getByRole('menuitem', { name: 'New Experiment' }).click()
  await page
    .getByRole('dialog', { name: 'New Experiment' })
    .getByRole('button', { name: /DC Uniform Bar/ })
    .click()
  await page.getByRole('menuitem', { name: 'Source' }).click()
  await page.getByRole('menuitem', { name: 'Geometry Manager' }).click()
  const manager = page.getByRole('dialog', { name: 'Geometry Manager' })
  await expect(manager).toBeVisible()
  await expect(manager).toContainText('designer/common/plate')
  await expect(manager).toContainText(coordinate)

  page.once('dialog', (prompt) => prompt.accept('PlateRoot'))
  await manager.getByRole('button', { name: 'Experiment에서 사용' }).click()
  const usageDialog = page.getByRole('dialog', { name: 'Experiment에서 Geometry 사용' })
  await expect(usageDialog).toContainText('<PlateRoot')
  await page.keyboard.press('Escape')
  await expect(usageDialog).toBeHidden()
  await expect(manager).toBeVisible()

  await manager.getByRole('tab', { name: 'References' }).click()
  await expect(manager).toContainText('Bracket study')
  await expect(manager).toContainText('Indirect')
  const referenceSearch = manager.getByRole('textbox', { name: /Experiment/ })
  await referenceSearch.fill('plate study')
  await expect.poll(() => experimentSearch).toBe('plate study')

  const namespaceInput = manager.locator('input[name="namespace"]')
  await expect(namespaceInput).toHaveValue('designer')
  await namespaceInput.fill('designer-next')
  await namespaceInput.locator('xpath=..').getByRole('button').click()
  await expect(manager.locator('input[name="namespace"]')).toHaveValue('designer-next')
  await expect(manager).toContainText(coordinate)

  await manager.getByRole('button', { name: '닫기' }).click()
  const experimentEditor = page.getByRole('textbox', { name: 'Editor content' })
  await experimentEditor.click({ force: true })
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(`import { experiment } from '@caemble/core'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {},
  geometry: () => <PlateRoot id="plate" />,
  recordedData: {},
})`)
  await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(0, { timeout: 10_000 })
})
