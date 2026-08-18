import { expect, test, type Page, type Route } from '@playwright/test'
import { createHash } from 'node:crypto'

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
    if (path === '/web/auth/csrf') return json(route, { csrf_token: 'csrf-browser-test' })
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
  await expect(page.getByRole('tab', { name: 'AI Helper' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('AI Helper을 사용하려면 Account에서 로그인하세요.')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'AI Helper' })).toHaveCount(0)
  await page.getByRole('button', { name: 'AI Helper 탭 닫기' }).click()

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

test('keeps an anonymous Starter editable offline and restores the session draft', async ({ page }) => {
  await page.route(apiPattern, (route) => route.abort('failed'))
  await page.goto('/')

  await expect(page.getByRole('tab', { name: 'Experiment', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Local editing · 서버 기능은 로그인 필요')).toBeVisible()
  await expect(page.getByText('현재 브라우저 세션에 Draft 자동 저장')).toBeVisible()
  await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('StarterStructure')
  await expect(page.getByRole('button', { name: 'Toggle Experiment' })).toBeVisible({ timeout: 15_000 })

  await page.getByRole('tab', { name: 'geometry.tsx' }).click()
  const editor = page.locator('.monaco-editor:visible .view-lines')
  await editor.click({ position: { x: 120, y: 45 } })
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(`import { type Geometry, type Vec3 } from '@caemble/core'

export const StarterStructure: Geometry<{ size: Vec3 }> = () => (
  <box size={[18, 12, 6]} />
)
// offline-edit
`)
  await expect(page.locator('.monaco-editor:visible .squiggly-error')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 15_000 })

  await page.getByRole('menuitem', { name: 'Source' }).click()
  await page.getByRole('menuitem', { name: 'New Experiment' }).click()
  await page
    .getByRole('dialog', { name: 'New Experiment' })
    .getByRole('button', { name: /Blank Experiment/ })
    .click()
  const confirmation = page.getByRole('dialog', { name: '저장하지 않은 편집을 바꿀까요?' })
  await confirmation.getByRole('button', { name: '편집 내용 바꾸기' }).click()
  await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('EmptyStructure')
  await expect(page.getByText('Waiting for model...', { exact: true })).toBeVisible({ timeout: 15_000 })

  const blankEditor = page.locator('.monaco-editor:visible .view-lines')
  await blankEditor.click({ position: { x: 120, y: 45 } })
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(`import { type Geometry } from '@caemble/core'

export const EmptyStructure: Geometry = () => <></>
// session-restored
`)
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('caemble:cae-workbench-draft')))
    .toContain('session-restored')

  await page.reload()
  await expect(page.getByRole('tab', { name: 'geometry.tsx' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('session-restored')
})

test('opens Geometry export publishing from the Source menu and Geometry ribbon', async ({ page }) => {
  await mockApi(page, true)
  const coordinate = 'caemble:geometry/designer/common/starter-structure@0.1.0'
  const localCoordinate = 'caemble:geometry/designer/common/starter-structure@local'
  const sourceHash = 'a'.repeat(64)
  const moduleHash = 'b'.repeat(64)
  const planHash = 'c'.repeat(64)
  await page.route(/\/api\/geometry\/publish\/plan$/, async (route) => {
    const request = route.request().postDataJSON() as {
      targetDraftId: string
      drafts: Array<{
        description: string | null
        draftId: string
        repository: string
        repositoryId: number | null
        package: string
        source: string
      }>
    }
    const draft = request.drafts[0]
    await json(route, {
      planHash,
      steps: [
        {
          ...draft,
          baseGeometryVersionId: null,
          version: '0.1.0',
          coordinate,
          localCoordinate,
          sourceHash,
          moduleHash,
          exports: ['StarterStructure'],
          imports: [],
        },
      ],
      replacements: [{ draftId: request.targetDraftId, localCoordinate, coordinate }],
    })
  })
  await page.route(/\/api\/geometry\/publish$/, async (route) => {
    const request = route.request().postDataJSON() as { targetDraftId: string; planHash: string }
    expect(request.planHash).toBe(planHash)
    await json(route, {
      planHash,
      published: [
        {
          id: 42,
          packageId: 7,
          coordinate,
          version: '0.1.0',
          description: null,
          sourceHash,
          moduleHash,
          moduleFormatVersion: 4,
          cadApiVersion: 7,
          archivedAt: null,
          createdAt: '2026-08-14T00:00:00Z',
        },
      ],
      replacements: [{ draftId: request.targetDraftId, localCoordinate, coordinate }],
    })
  })
  await page.route(/\/api\/geometry\/versions\/42\/resolve$/, (route) =>
    json(route, {
      schemaVersion: 2,
      root: { geometryVersionId: 42, coordinate, moduleHash, exports: ['StarterStructure'] },
      modules: [],
    }),
  )
  await page.goto('/')

  await page.getByRole('menuitem', { name: 'Source' }).click()
  await page.getByRole('menuitem', { name: 'Publish geometry.tsx Export' }).click()
  const dialog = page.getByRole('dialog', { name: 'Publish geometry.tsx Export' })
  await expect(dialog.getByRole('combobox', { name: 'Export', exact: true })).toHaveValue('StarterStructure')
  await expect(dialog.getByLabel('Package name')).toHaveValue('starter-structure')
  await expect(dialog.getByLabel('Reconstructed TSX source')).toHaveValue(/export const StarterStructure/)
  await dialog.getByRole('button', { name: '취소' }).click()

  await page.getByRole('menuitem', { name: 'View' }).click()
  await page.getByRole('menuitem', { name: 'Geometry Workspace' }).click()
  const ribbon = page.getByRole('region', { name: 'Geometry 리본' })
  await ribbon.getByRole('button', { name: 'Publish geometry.tsx Export' }).click()
  const ribbonDialog = page.getByRole('dialog', { name: 'Publish geometry.tsx Export' })
  await ribbonDialog.getByRole('button', { name: 'Geometry 발행' }).click()
  const publishedDialog = page.getByRole('dialog', { name: 'Geometry 발행 완료' })
  await expect(publishedDialog).toBeVisible({ timeout: 15_000 })
  await expect(
    publishedDialog.getByText(`import { StarterStructure } from "${coordinate}"`, { exact: true }),
  ).toBeVisible()
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

test('manages Geometry packages and previews an editable Geometry without Monaco model conflicts', async ({ page }) => {
  const timestamp = '2026-08-13T00:00:00Z'
  const coordinate = 'caemble:geometry/designer/common/plate@1.2.3'
  const geometrySource =
    "import { type Geometry } from '@caemble/core'\nexport const Plate: Geometry = () => <box size={[1, 1, 1]} />\n"
  const sourceHash = createHash('sha256').update(geometrySource).digest('hex')
  const moduleHash = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 2,
        moduleFormatVersion: 4,
        cadApiVersion: 7,
        coordinate,
        sourceHash,
        imports: [],
      }),
    )
    .digest('hex')
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
    source: geometrySource,
    source_hash: sourceHash,
    module_hash: moduleHash,
    module_format_version: 4,
    cad_api_version: 7,
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
        schemaVersion: 2,
        root: { geometryVersionId: version.id, coordinate, moduleHash, exports: ['Plate'] },
        modules: [
          {
            geometryVersionId: version.id,
            coordinate,
            moduleFormatVersion: 4,
            cadApiVersion: 7,
            description: version.description,
            source: version.source,
            sourceHash,
            moduleHash,
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
            entry_alias: null,
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
  await expect(page.getByRole('tab', { name: 'experiment.tsx' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('Conductor')
  await page.waitForTimeout(1_000)
  await expect(page.locator('.monaco-editor:visible .squiggly-error')).toHaveCount(0)
  await page.getByRole('tab', { name: 'tasks/solveCurrent.tsx' }).click()
  await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('Probe')
  await page.waitForTimeout(1_000)
  await expect(page.locator('.monaco-editor:visible .squiggly-error')).toHaveCount(0)
  await page.getByRole('tab', { name: 'experiment.tsx' }).click()
  await page.getByRole('menuitem', { name: 'Source' }).click()
  await page.getByRole('menuitem', { name: 'Geometry Manager' }).click()
  const manager = page.getByRole('dialog', { name: 'Geometry Manager' })
  await expect(manager).toBeVisible()
  await expect(manager).toContainText('designer/common/plate')
  await expect(manager).toContainText(coordinate)

  page.once('dialog', (prompt) => prompt.accept('PlateRoot'))
  await manager.getByRole('button', { name: 'Experiment에서 사용' }).click()
  const usageDialog = page.getByRole('dialog', { name: 'Experiment에서 Geometry 사용' })
  await expect(usageDialog).toContainText(`import { Plate as PlateRoot } from "${coordinate}"`)
  await usageDialog.getByRole('button', { name: 'geometry.tsx 열기' }).click()
  await expect(usageDialog).toBeHidden()
  await expect(manager).toBeHidden()

  const geometryEditor = page.locator('.monaco-editor:visible .view-lines')
  await expect(page.getByRole('tab', { name: 'geometry.tsx' })).toHaveAttribute('aria-selected', 'true')
  await geometryEditor.click({ position: { x: 100, y: 30 } })
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(`import { Plate as PlateRoot } from "${coordinate}"
export { PlateRoot }
`)
  await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(0, { timeout: 10_000 })

  await page.getByRole('menuitem', { name: 'Source' }).click()
  await page.getByRole('menuitem', { name: 'Geometry Manager' }).click()
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
  await page.getByRole('tab', { name: 'experiment.tsx' }).click()
  const experimentEditor = page.locator('.monaco-editor:visible .view-lines')
  await experimentEditor.click({ position: { x: 100, y: 30 } })
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(`import { experiment } from '@caemble/core'
import { PlateRoot } from './geometry'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {},
  geometry: () => <PlateRoot id="plate" />,
  recordedData: {},
})`)
  await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(0, { timeout: 10_000 })

  await page.getByRole('tab', { name: 'Geometry', exact: true }).click()
  const workspace = page.locator('section[aria-label="Geometry workspace"]')
  await expect(workspace).toBeVisible()
  await workspace.getByRole('treeitem').getByRole('button').filter({ hasText: 'PlateRoot' }).click()
  await workspace.getByRole('button', { name: 'Edit as New Version' }).click()

  const saveGeometry = workspace.getByRole('button', { name: 'Geometry 저장' })
  await expect(saveGeometry).toBeEnabled({ timeout: 15_000 })
  await expect(workspace.getByText('Preview current', { exact: true })).toBeVisible()
  await expect(workspace.getByRole('alert')).toHaveCount(0)

  const draftEditor = workspace.locator('.monaco-editor:visible .view-lines')
  await draftEditor.click({ position: { x: 100, y: 30 } })
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('export const Broken = (')
  await expect(workspace.getByRole('alert')).toContainText('마지막 정상 Tree와 Viewer를 유지합니다.')
  await expect(saveGeometry).toBeDisabled()
})
