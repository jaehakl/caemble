import { expect, test, type Page, type Route } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const user = {
  id: 'd7929429-84f8-4d92-865d-dc638d8e64e0',
  email: 'designer@example.com',
  display_name: '김설계',
  picture_url: null,
  is_active: true,
  created_at: '2026-07-21T00:00:00Z',
  updated_at: '2026-07-21T00:00:00Z',
  experiment_namespaces: ['designer'],
  roles: ['user'],
}
const apiPattern = /^http:\/\/127\.0\.0\.1:\d+\/api\//
const catalogPackageRoot = fileURLToPath(new URL('../../catalog', import.meta.url))
const catalogDatabasePath = fileURLToPath(new URL('../../catalog/caemble_catalog/catalog.sqlite3', import.meta.url))
const catalogSliceScript = `import json, sys
from caemble_catalog import Catalog
request = json.load(sys.stdin)
with Catalog.open_readonly() as catalog:
    result = catalog.runtime_slice(
        solvers=[(item["name"], item["version"]) for item in request["solvers"]],
        quantity_kinds=request["quantityKinds"],
        material_parameters=request["materialParameters"],
        material_models=request["materialModels"],
    )
json.dump(result, sys.stdout)
`
const exampleExperimentTemplates = [
  ['Fiber Bundle', 'fiberBundle'],
  ['DC Uniform Bar', 'referenceVoltage'],
  ['DC Notched Current Density', 'NotchedConductor'],
  ['DC Resolution Study', 'sourceVoltage'],
  ['Electro-Thermal Uniform Bar', 'fixedTemperature'],
] as const

function canonicalCatalogSlice(request: unknown) {
  const pythonPath = [catalogPackageRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter)
  const output = execFileSync(process.env.PYTHON ?? 'python', ['-c', catalogSliceScript], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: pythonPath },
    input: JSON.stringify(request),
  })
  return JSON.parse(output) as unknown
}

function canonicalCatalogQuery(
  key?: string,
  identity: { namespace?: string | null; repository?: string | null; version?: string | null } = {},
) {
  const pythonPath = [catalogPackageRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter)
  const args = ['-m', 'caemble_catalog', '--database', catalogDatabasePath, 'query', 'experiment']
  if (key) {
    args.push(key)
    if (identity.version) args.push(identity.version)
    if (identity.namespace) args.push('--namespace', identity.namespace)
    if (identity.repository) args.push('--repository', identity.repository)
  }
  const output = execFileSync(process.env.PYTHON ?? 'python', args, {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: pythonPath, PYTHONUTF8: '1' },
  })
  return JSON.parse(output) as Record<string, unknown> | Record<string, unknown>[]
}

async function mockCanonicalCatalog(page: Page) {
  const slices = new Map<string, unknown>()
  await page.route('**/api/catalog/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/catalog/runtime-slice') {
      const request = route.request().postDataJSON()
      const key = JSON.stringify(request)
      let slice = slices.get(key)
      if (!slice) {
        slice = canonicalCatalogSlice(request)
        slices.set(key, slice)
      }
      return json(route, slice)
    }
    const match = url.pathname.match(/^\/api\/catalog\/experiments(?:\/([^/]+))?$/u)
    if (!match) return route.fallback()
    if (match[1]) {
      const detail = canonicalCatalogQuery(decodeURIComponent(match[1]), {
        namespace: url.searchParams.get('namespace'),
        repository: url.searchParams.get('repository'),
        version: url.searchParams.get('version'),
      }) as Record<string, unknown>
      const verification = detail.verification as Record<string, unknown>
      return json(route, { ...detail, verification: { ...verification, fixture: verification.fixture ?? null } })
    }
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const namespace = url.searchParams.get('namespace')
    const repository = url.searchParams.get('repository')
    const solverName = url.searchParams.get('solverName')
    const solverVersion = url.searchParams.get('solverVersion')
    const items = (canonicalCatalogQuery() as Record<string, unknown>[]).filter((item) => {
      if (query && !`${item.coordinate} ${item.title} ${item.description}`.toLowerCase().includes(query)) return false
      if (namespace && item.namespace !== namespace) return false
      if (repository && item.repository !== repository) return false
      if (
        solverName &&
        !(item.relatedSolvers as Array<{ name: string; version: string }> | undefined)?.some(
          (solver) => solver.name === solverName && (!solverVersion || solver.version === solverVersion),
        )
      )
        return false
      return true
    })
    return json(route, { items, nextCursor: null, total: items.length })
  })
}

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

test('uses the seven-category Workbench with contextual panes and an integrated Help area', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  const menubar = page.getByRole('menubar', { name: 'CAE 워크벤치 메뉴' })
  await expect(menubar).toBeVisible()
  await expect(menubar.getByRole('menuitemradio')).toHaveCount(7)
  for (const name of ['Experiment', 'Measurement', 'Material', 'Analysis', 'Lab', 'Help', 'Setting']) {
    await expect(menubar.getByRole('menuitemradio', { name, exact: true })).toBeVisible()
  }
  await expect(menubar.getByRole('menuitemradio', { name: 'Experiment', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.getByRole('toolbar', { name: 'CAE 빠른 작업' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Experiment 리본' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'experiment 목록 및 설정' })).toContainText('Experiment Manager')
  await expect(page.getByRole('region', { name: '3D CAD View', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'experiment Detail' })).toBeVisible()

  await page.getByRole('tab', { name: 'AI Agent' }).click()
  await expect(page.getByRole('tab', { name: 'AI Agent' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('AI Helper Agent를 사용하려면 Account에서 로그인하세요.')).toBeVisible()
  await page.getByRole('button', { name: '하단 도크 숨기기' }).click()
  await expect(page.getByRole('tab', { name: 'AI Agent' })).toHaveAttribute('aria-selected', 'false')

  await menubar.getByRole('menuitemradio', { name: 'Help', exact: true }).click()
  const helpRibbon = page.getByRole('region', { name: 'Help 리본' })
  await expect(helpRibbon.getByRole('button', { name: 'Manual' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'help 목록 및 설정' })).toContainText('Manual')
  await expect(page.getByRole('region', { name: 'help Detail' })).toBeVisible()
  await helpRibbon.getByRole('button', { name: 'Geometry' }).click()
  await expect(page.getByRole('heading', { name: 'Geometry Catalog' })).toBeVisible()
  await expect(page.getByText('Geometry Catalog 항목을 선택하세요')).toBeVisible()

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

  await expect(page.getByRole('menuitemradio', { name: 'Experiment', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.getByText('Local editing · 서버 기능은 로그인 필요')).toBeVisible()
  await expect(page.getByText('현재 브라우저 세션에 Draft 자동 저장')).toBeVisible()
  await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('StarterStructure')
  await expect(page.getByRole('button', { name: 'Toggle Experiment' })).toBeVisible({ timeout: 15_000 })

  await page.getByRole('tab', { name: 'geometry.tsx' }).click()
  const editor = page.locator('.monaco-editor:visible .view-lines')
  await editor.click({ position: { x: 120, y: 45 } })
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(`import { Box, Cylinder, radians, type Geometry, type Vec3 } from '@caemble/core'

export const StarterStructure: Geometry<{ size: Vec3 }> = ({ size = [36, 24, 12] }) => (
  <translate offset={[8, 0, 0]}>
    <rotate axis={[0, 0, 1]} angle={radians(15)}>
      <scale x={1.5} y={1} z={1}>
        <Box id="body" size={size} />
      </scale>
    </rotate>
    {Array.from({ length: 2 }, (_, index) => (
      <Cylinder id={\`post-\${index}\`} radius={1} height={8} position={[index * 4, 0, 7]} />
    ))}
  </translate>
)
// offline-edit
`)
  await expect(page.locator('.monaco-editor:visible .squiggly-error')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Toggle Experiment' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Draft preview · Solver 미선택')).toBeVisible()
  await expect(page.locator('footer [role="alert"]')).toHaveCount(0)

  await page.getByRole('region', { name: 'Experiment 리본' }).getByRole('button', { name: 'New', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '저장하지 않은 편집을 바꿀까요?' })
  await confirmation.getByRole('button', { name: '편집 내용 바꾸기' }).click()
  await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('StarterStructure')

  const starterEditor = page.locator('.monaco-editor:visible .view-lines')
  await starterEditor.click({ position: { x: 120, y: 45 } })
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(`import { Box, type Geometry, type Vec3 } from '@caemble/core'

export const StarterStructure: Geometry<{ size: Vec3 }> = ({ size = [12, 8, 4] }) => <Box size={size} />
// session-restored
`)
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('caemble:cae-workbench-draft')))
    .toContain('session-restored')

  await page.reload()
  await expect(page.getByRole('tab', { name: 'geometry.tsx' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('session-restored')
})

test('inserts primitives and wraps selected Geometry from the Experiment authoring ribbon', async ({ page }) => {
  await page.route(apiPattern, (route) => route.abort('failed'))
  await page.goto('/')
  await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('StarterStructure', {
    timeout: 15_000,
  })
  await page.getByRole('tab', { name: 'geometry.tsx' }).click()
  await expect(page.getByRole('tab', { name: 'geometry.tsx' })).toHaveAttribute('aria-selected', 'true')

  const editor = page.locator('.monaco-editor:visible .view-lines')
  await editor.click({ position: { x: 120, y: 45 } })
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(`import { Sphere, type Geometry } from '@caemble/core'

export const RibbonPart: Geometry = () => (
  <>
    <Sphere id="seed" radius={1} />
    {/* ribbon cursor */}
  </>
)
`)
  await expect(page.locator('.monaco-editor:visible .squiggly-error')).toHaveCount(0, { timeout: 10_000 })

  await page.keyboard.press('Control+f')
  await page.keyboard.insertText('<Sphere id="seed" radius={1} />')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  const experimentRibbon = page.getByRole('region', { name: 'Experiment 리본' })
  await expect(experimentRibbon.getByRole('button', { name: 'Operation' })).toBeEnabled()
  await experimentRibbon.getByRole('button', { name: 'Operation' }).click()
  await page.getByRole('menuitem', { name: /^union\b/u }).click()
  await expect(editor).toContainText('id="union"')
  await expect(editor).toContainText('</union>')

  await editor.click({ position: { x: 120, y: 45 } })
  await page.keyboard.press('Control+f')
  await page.keyboard.insertText('ribbon cursor')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await experimentRibbon.getByRole('button', { name: 'Primitive' }).click()
  await page.getByRole('menuitem', { name: /^Box\b/u }).click()
  await expect(editor).toContainText('type Geometry, Box')
  await expect(editor).toContainText('id="box"')
  await expect(editor).toContainText('size={[1, 1, 1]}')
  await expect(editor).toContainText('rotation={[0, 0, 0]}')
})

test('regenerates an editable Candidate when varsSchema adds openness', async ({ page }) => {
  await mockApi(page)
  await mockCanonicalCatalog(page)
  await page.goto('/')
  await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('StarterStructure', {
    timeout: 30_000,
  })

  await page.getByRole('tab', { name: 'geometry.tsx' }).click()
  const geometryEditor = page.locator('.monaco-editor:visible .view-lines')
  await geometryEditor.click({ position: { x: 120, y: 45 } })
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(`import { Box, type Geometry } from '@caemble/core'

export const StarterStructure: Geometry = () => <></>

export const PaperBox: Geometry<{ openness: number }> = ({ openness = 0.5 }) => (
  <Box size={[100, 60, 2 + openness * 38]} />
)
`)
  await expect(page.locator('.monaco-editor:visible .squiggly-error')).toHaveCount(0, { timeout: 10_000 })

  await page.getByRole('tab', { name: 'experiment.tsx' }).click()
  const experimentEditor = page.locator('.monaco-editor:visible .view-lines')
  await experimentEditor.click({ position: { x: 120, y: 45 } })
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(`import { experiment } from '@caemble/core'
import { PaperBox } from './geometry'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {
    openness: { min: 0, max: 1 },
  },
  geometry: ({ vars }) => <PaperBox id="paperBox" openness={vars.openness} />,
  recordedData: {},
})
`)

  await expect(page.getByText('Waiting for model...', { exact: true })).toBeHidden({ timeout: 15_000 })
  const generateCandidate = page
    .getByRole('region', { name: 'Experiment 리본' })
    .getByRole('button', { name: 'Candidate' })
  await expect(generateCandidate).toBeEnabled()
  await generateCandidate.click()
  await expect(page.getByRole('button', { name: 'Toggle Experiment' })).toBeEnabled()
  await expect(page.locator('footer [role="alert"]')).toHaveCount(0)
  await expect(page.getByText('Draft preview · Solver 미선택')).toBeVisible({ timeout: 15_000 })
})

for (const [title, sourceMarker] of exampleExperimentTemplates) {
  test(`loads the ${title} Example through Experiment Manager`, async ({ page }) => {
    test.setTimeout(90_000)
    await mockApi(page)
    await mockCanonicalCatalog(page)
    await page.goto('/')
    await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('StarterStructure', {
      timeout: 30_000,
    })

    const manager = page.getByLabel('Experiment Manager')
    await manager.getByRole('button', { name: new RegExp(title) }).click()

    await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText(sourceMarker)
    await expect(page.getByText('Waiting for model...', { exact: true })).toBeHidden({ timeout: 30_000 })
    await expect(page.getByText('Draft preview · Solver 미선택')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Toggle Task' })).toBeEnabled({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Toggle Experiment' })).toBeEnabled({ timeout: 30_000 })
    await expect(page.locator('footer [role="alert"]')).toHaveCount(0)
  })
}

test('manages Experiment namespace, SemVer saves, locks, and version deletion', async ({ page }) => {
  test.setTimeout(90_000)
  let namespaces = ['designer']
  let nextId = 1
  let rows: Array<Record<string, unknown>> = []

  await mockApi(page, true)
  await mockCanonicalCatalog(page)
  await page.route(apiPattern, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/me') return json(route, { ...user, experiment_namespaces: namespaces })
    if (path === '/experiment/list') {
      const body = route.request().postDataJSON() as { selected_ids?: number[] }
      const selected = body.selected_ids ?? []
      const items = selected.length ? rows.filter((row) => selected.includes(row.id as number)) : rows
      return json(route, { total: items.length, items })
    }
    if (path === '/experiment/save') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      const action = body.mode as 'create' | 'overwrite' | 'new_version'
      const sourceBundle = body.sourceBundle as Record<string, unknown>
      const previous = action === 'new_version' ? rows.find((row) => row.id === body.experimentId) : null
      const namespace = String(body.namespace)
      const repository = String(body.repository)
      const key = String(body.key)
      namespaces = [...new Set([...namespaces, namespace])].sort()
      const version = action === 'new_version' ? '0.2.0' : '0.1.0'
      if (action === 'new_version' && previous) {
        previous.sourceLocked = true
        previous.derivedCounts = { measurements: 1, recordedData: 2, designerModels: 0, predictorModels: 0 }
      }
      const id = nextId++
      const [versionMajor, versionMinor, versionPatch] = version.split('.').map(Number)
      const coordinate = `caemble:experiment/${namespace}/${repository}/${key}@${version}`
      const row = {
        id,
        user_id: user.id,
        namespace,
        repository_slug: repository,
        experiment_key: key,
        version_major: versionMajor,
        version_minor: versionMinor,
        version_patch: versionPatch,
        name: body.name,
        description: body.description,
        source_bundle: sourceBundle,
        source_hash: body.bundleHash,
        repository,
        key,
        version,
        coordinate,
        bundleHash: body.bundleHash,
        sourceLocked: false,
        derivedCounts: { measurements: 0, recordedData: 0, designerModels: 0, predictorModels: 0 },
      }
      rows = [row, ...rows]
      return json(route, {
        id,
        action,
        namespace,
        repository,
        key,
        version,
        coordinate,
        bundleHash: body.bundleHash,
        sourceLocked: false,
        derivedCounts: row.derivedCounts,
      })
    }
    if (path === '/experiment/usage') {
      const { experimentIds } = route.request().postDataJSON() as { experimentIds: number[] }
      return json(route, {
        items: experimentIds.map((experimentId) => {
          const row = rows.find((item) => item.id === experimentId)
          return {
            experimentId,
            sourceLocked: Boolean(row?.sourceLocked),
            derivedCounts: row?.derivedCounts,
          }
        }),
      })
    }
    if (path === '/experiment/' && route.request().method() === 'DELETE') {
      const ids = route.request().postDataJSON() as number[]
      rows = rows.filter((row) => !ids.includes(row.id as number))
      namespaces = namespaces.filter((item) => rows.some((row) => row.namespace === item))
      return json(route, null)
    }
    return route.fallback()
  })

  await page.goto('/')
  const workbenchFooter = page.locator('footer.h-7')
  const manager = page.getByLabel('Experiment Manager')
  await expect(manager).not.toContainText('caemble:experiment/caemble/getting-started/basketball-goal@1.0.0')
  await expect(manager.getByRole('textbox', { name: 'Experiment namespace' })).toHaveCount(0)

  await manager.getByRole('button', { name: /Basketball Goal v1\.0\.0/ }).click()
  await expect(workbenchFooter).toContainText('Preview only · Task 없음')

  const experimentRibbon = page.getByRole('region', { name: 'Experiment 리본' })
  await experimentRibbon.getByRole('button', { name: 'Save', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: 'Save Experiment' })
  await createDialog.getByRole('combobox', { name: 'Namespace' }).fill('design-lab')
  await createDialog.getByRole('textbox', { name: 'Repository' }).fill('prototypes')
  await createDialog.getByRole('textbox', { name: 'Experiment key' }).fill('basketball-goal')
  await createDialog.getByRole('button', { name: 'Experiment 저장' }).click()
  await expect(workbenchFooter).toContainText('caemble:experiment/design-lab/prototypes/basketball-goal@0.1.0')

  await experimentRibbon.getByRole('button', { name: 'New Version', exact: true }).click()
  const versionDialog = page.getByRole('dialog', { name: 'Save New Version' })
  await versionDialog.getByRole('combobox', { name: 'Version 증가' }).selectOption('minor')
  await versionDialog.getByRole('button', { name: '새 Version 저장' }).click()
  await expect(workbenchFooter).toContainText('@0.2.0')

  await expect(manager).not.toContainText('design-lab/prototypes/basketball-goal')
  await expect(manager).toContainText('Locked')
  await expect(manager).toContainText('연결 데이터 3')

  page.once('dialog', (dialog) => dialog.accept())
  await manager.getByRole('button', { name: 'Basketball Goal v0.1.0 삭제' }).click()
  await expect(manager.getByRole('button', { name: 'Basketball Goal v0.1.0 삭제' })).toHaveCount(0)
  await expect(manager).toContainText('v0.2.0')
})

test('shows authenticated Launchers and Jobs together in the Setting workspace', async ({ page }) => {
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
  await page.getByRole('menuitemradio', { name: 'Setting', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Setting 리본' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'setting 목록 및 설정' })).toContainText('gpu-workstation')
  await expect(page.getByRole('region', { name: 'setting Detail' })).toContainText('cae.simulation.start')

  await page.getByRole('region', { name: 'Setting 리본' }).getByRole('button', { name: 'Account' }).click()
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible()
})
