import { expect, test, type Page, type Route } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  geometry_namespace: 'designer',
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
const officialExperimentTemplates = [
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

function canonicalCatalogQuery(kind: 'experiment' | 'geometry', key?: string) {
  const pythonPath = [catalogPackageRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter)
  const args = ['-m', 'caemble_catalog', '--database', catalogDatabasePath, 'query', kind]
  if (key) args.push(key)
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
    if (url.pathname === '/api/catalog/geometry-repositories') {
      return json(route, [
        { slug: 'getting-started', title: 'Getting Started', description: '', ordinal: 0 },
        { slug: 'arrays', title: 'Arrays', description: '', ordinal: 1 },
        { slug: 'advanced-shapes', title: 'Advanced Shapes', description: '', ordinal: 2 },
        { slug: 'assemblies', title: 'Assemblies', description: '', ordinal: 3 },
      ])
    }
    const match = url.pathname.match(/^\/api\/catalog\/(experiments|geometries)(?:\/([^/]+))?$/u)
    if (!match) return route.fallback()
    const kind = match[1] === 'experiments' ? 'experiment' : 'geometry'
    if (match[2]) {
      const detail = canonicalCatalogQuery(kind, decodeURIComponent(match[2])) as Record<string, unknown>
      if (kind === 'experiment') {
        const verification = detail.verification as Record<string, unknown>
        return json(route, { ...detail, verification: { ...verification, fixture: verification.fixture ?? null } })
      }
      return json(route, detail)
    }
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const element = url.searchParams.get('element')
    const repository = url.searchParams.get('repository')
    const solverName = url.searchParams.get('solverName')
    const solverVersion = url.searchParams.get('solverVersion')
    const items = (canonicalCatalogQuery(kind) as Record<string, unknown>[]).filter((item) => {
      if (query && !`${item.key} ${item.title} ${item.description}`.toLowerCase().includes(query)) return false
      if (element && !(item.relatedElements as string[] | undefined)?.includes(element)) return false
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

  await page.getByRole('menuitem', { name: 'Source' }).click()
  await page.getByRole('menuitem', { name: 'New Experiment' }).click()
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

test('inserts primitives and wraps selected Geometry from both authoring ribbons', async ({ page }) => {
  await page.route(apiPattern, (route) => route.abort('failed'))
  await page.goto('/')
  await page.getByRole('tab', { name: 'geometry.tsx' }).click()

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

  await page.getByRole('tab', { name: 'Geometry', exact: true }).click()
  const geometryRibbon = page.getByRole('region', { name: 'Geometry 리본' })
  await expect(geometryRibbon.getByRole('button', { name: 'Primitive' })).toBeVisible()
  await expect(geometryRibbon.getByRole('button', { name: /Operation/ })).toBeVisible()
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
    .getByRole('toolbar', { name: 'CAE 빠른 작업' })
    .getByRole('button', { name: 'Generate Candidate' })
  await expect(generateCandidate).toBeEnabled()
  await generateCandidate.click()
  await expect(page.getByRole('button', { name: 'Toggle Experiment' })).toBeEnabled()
  await expect(page.locator('footer [role="alert"]')).toHaveCount(0)
  await expect(page.getByText('Draft preview · Solver 미선택')).toBeVisible({ timeout: 15_000 })
})

for (const [title, sourceMarker] of officialExperimentTemplates) {
  test(`loads the ${title} official Experiment through the Workbench Picker`, async ({ page }) => {
    test.setTimeout(90_000)
    await mockApi(page)
    await mockCanonicalCatalog(page)
    await page.goto('/')
    await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText('StarterStructure', {
      timeout: 30_000,
    })

    await page.getByRole('menuitem', { name: 'Source' }).click()
    await page.getByRole('menuitem', { name: 'Load Experiment' }).click()
    await page
      .getByRole('dialog', { name: 'Experiment 불러오기' })
      .getByRole('button', { name: new RegExp(`^${title}`) })
      .click()

    await expect(page.locator('.monaco-editor:visible .view-lines')).toContainText(sourceMarker)
    await expect(page.getByText('Waiting for model...', { exact: true })).toBeHidden({ timeout: 30_000 })
    await expect(page.getByText('Draft preview · Solver 미선택')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Toggle Task' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Toggle Experiment' })).toBeEnabled()
    await expect(page.locator('footer [role="alert"]')).toHaveCount(0)
  })
}

test('keeps Example Geometry read-only for anonymous users in the unified manager', async ({ page }) => {
  await mockApi(page)
  await mockCanonicalCatalog(page)
  await page.goto('/')

  await page.getByRole('menuitem', { name: 'Source' }).click()
  await page.getByRole('menuitem', { name: 'Geometry Manager' }).click()
  const manager = page.getByLabel('Geometry Manager')
  await expect(page.getByRole('tab', { name: 'Geometry', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(manager.getByRole('tab', { name: 'Official Catalog' })).toHaveCount(0)
  await expect(manager.getByRole('tab', { name: 'Workspace Packages' })).toHaveCount(0)
  await expect(manager.getByRole('button', { name: '전체', exact: true })).toHaveCount(0)
  await expect(manager.getByRole('combobox', { name: 'Namespace' })).toHaveValue('examples')
  await expect(manager.getByRole('option', { name: 'Examples' })).toHaveCount(1)
  await expect(manager.getByRole('option', { name: 'local' })).toHaveCount(1)
  await manager.getByRole('button', { name: /Basketball Goal/ }).click()
  await expect(manager.locator('.monaco-editor:visible')).toBeVisible()
  await expect(manager.locator('.monaco-editor:visible .view-lines')).toContainText('BasketballGoal')
  await expect(manager.getByRole('combobox', { name: 'Namespace' })).toHaveValue('examples')
  await expect(manager.getByRole('combobox', { name: 'Repository' })).toHaveValue('all')
  await expect(manager.getByRole('button', { name: '개인 Repository로 Fork' })).toBeDisabled()
  await expect(page.locator('footer').last()).toContainText('Draft Versions · 0')

  await manager.getByRole('combobox', { name: 'Namespace' }).selectOption('local')
  await expect(manager.getByLabel('Geometry Packages list')).toContainText('표시할 Geometry가 없습니다.')
  await expect(manager.getByLabel('Geometry Packages list')).not.toContainText('Basketball Goal')
})

test('forks Example Geometry into a personal Draft and publishes its first exact Version', async ({ page }) => {
  test.setTimeout(90_000)
  const timestamp = '2026-08-21T00:00:00Z'
  const localCoordinate = 'caemble:geometry/designer/forks/basketball-goal@local'
  const exactCoordinate = 'caemble:geometry/designer/forks/basketball-goal@0.1.0'
  const planHash = 'd'.repeat(64)
  let published = false
  let publishedSource = ''
  let publishedSourceHash = ''
  let publishedModuleHash = ''
  let publishedDescription: string | null = null
  let repositoryCreated = false

  await page.route(apiPattern, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/me') return json(route, user)
    if (path === '/auth/refresh') return json(route, { detail: 'Unexpected refresh' }, 401)
    if (path === '/web/auth/csrf') return json(route, { csrf_token: 'csrf-official-fork' })
    if (path === '/geometry/publish/plan') {
      const request = route.request().postDataJSON() as {
        targetDraftId: string
        drafts: Array<{
          draftId: string
          baseGeometryVersionId: null
          repositoryId: number
          repository: string
          package: string
          version: string
          description: string | null
          source: string
        }>
      }
      const draft = request.drafts[0]!
      expect(draft).toMatchObject({
        baseGeometryVersionId: null,
        repositoryId: 11,
        repository: 'forks',
        package: 'basketball-goal',
        version: '0.1.0',
      })
      publishedSource = draft.source
      publishedDescription = draft.description
      publishedSourceHash = createHash('sha256').update(publishedSource).digest('hex')
      publishedModuleHash = createHash('sha256')
        .update(
          JSON.stringify({
            schemaVersion: 2,
            moduleFormatVersion: 4,
            cadApiVersion: 8,
            coordinate: exactCoordinate,
            sourceHash: publishedSourceHash,
            imports: [],
          }),
        )
        .digest('hex')
      return json(route, {
        planHash,
        steps: [
          {
            ...draft,
            coordinate: exactCoordinate,
            localCoordinate,
            sourceHash: publishedSourceHash,
            moduleHash: publishedModuleHash,
            exports: ['BasketballGoal'],
            imports: [],
          },
        ],
        replacements: [{ draftId: draft.draftId, localCoordinate, coordinate: exactCoordinate }],
      })
    }
    if (path === '/geometry/publish') {
      const request = route.request().postDataJSON() as { targetDraftId: string; planHash: string }
      expect(request.planHash).toBe(planHash)
      published = true
      return json(route, {
        planHash,
        published: [
          {
            id: 13,
            packageId: 12,
            coordinate: exactCoordinate,
            version: '0.1.0',
            description: publishedDescription,
            sourceHash: publishedSourceHash,
            moduleHash: publishedModuleHash,
            moduleFormatVersion: 4,
            cadApiVersion: 8,
            archivedAt: null,
            createdAt: timestamp,
          },
        ],
        replacements: [{ draftId: request.targetDraftId, localCoordinate, coordinate: exactCoordinate }],
      })
    }
    const repository = {
      id: 11,
      user_id: user.id,
      namespace: 'designer',
      slug: 'forks',
      description: null,
      archived_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    }
    if (path === '/geometry/repositories' && route.request().method() === 'POST') {
      repositoryCreated = true
      return json(route, {
        id: repository.id,
        userId: repository.user_id,
        namespace: repository.namespace,
        slug: repository.slug,
        description: repository.description,
        archivedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    }
    const geometryPackage = {
      id: 12,
      repository_id: repository.id,
      name: 'basketball-goal',
      user_id: user.id,
      namespace: repository.namespace,
      repository: repository.slug,
      repository_archived_at: null,
      version_count: 1,
      latest_version: '0.1.0',
      created_at: timestamp,
      updated_at: timestamp,
    }
    if (path === '/geometry/repositories/list') {
      return json(route, {
        total: repositoryCreated ? 1 : 0,
        items: repositoryCreated
          ? [{ ...repository, package_count: published ? 1 : 0, version_count: published ? 1 : 0 }]
          : [],
      })
    }
    if (path === '/geometry/packages/list') {
      return json(route, { total: published ? 1 : 0, items: published ? [geometryPackage] : [] })
    }
    if (path === '/geometry/versions/list') {
      return json(route, {
        total: published ? 1 : 0,
        items: published
          ? [
              {
                id: 13,
                package_id: geometryPackage.id,
                version_major: 0,
                version_minor: 1,
                version_patch: 0,
                description: publishedDescription,
                source: publishedSource,
                source_hash: publishedSourceHash,
                module_hash: publishedModuleHash,
                module_format_version: 4,
                cad_api_version: 8,
                archived_at: null,
                repository_id: repository.id,
                namespace: repository.namespace,
                repository: repository.slug,
                package_name: geometryPackage.name,
                coordinate: exactCoordinate,
                version: '0.1.0',
                created_at: timestamp,
                updated_at: timestamp,
              },
            ]
          : [],
      })
    }
    if (path === '/geometry/versions/13/resolve') {
      return json(route, {
        schemaVersion: 2,
        root: {
          geometryVersionId: 13,
          coordinate: exactCoordinate,
          moduleHash: publishedModuleHash,
          exports: ['BasketballGoal'],
        },
        modules: [
          {
            geometryVersionId: 13,
            coordinate: exactCoordinate,
            moduleFormatVersion: 4,
            cadApiVersion: 8,
            description: publishedDescription,
            source: publishedSource,
            sourceHash: publishedSourceHash,
            moduleHash: publishedModuleHash,
            imports: [],
          },
        ],
      })
    }
    if (path === '/geometry/versions/usage') return json(route, { items: [] })
    if (path.endsWith('/dependents/list') || path.endsWith('/experiments/list')) {
      return json(route, { total: 0, items: [] })
    }
    if (path === '/web/jobs') return json(route, [])
    if (path === '/web/launchers/runtime') return json(route, [])
    if (path.endsWith('/list')) return json(route, { total: 0, items: [] })
    return json(route, { detail: `Unexpected mocked endpoint: ${path}` }, 404)
  })
  await mockCanonicalCatalog(page)

  await page.goto('/')
  await page.getByRole('menuitem', { name: 'Source' }).click()
  await page.getByRole('menuitem', { name: 'Geometry Manager' }).click()
  const manager = page.getByLabel('Geometry Manager')
  await manager.getByRole('button', { name: /Basketball Goal/ }).click()
  await manager.getByRole('button', { name: '개인 Repository로 Fork' }).click()
  const forkDialog = page.getByRole('dialog', { name: '개인 Repository로 Fork' })
  await forkDialog.getByRole('button', { name: '새 Repository' }).click()
  const repositoryDialog = page.getByRole('dialog', { name: '새 Repository' })
  await repositoryDialog.getByLabel('Repository 이름').fill('forks')
  await repositoryDialog.getByRole('button', { name: '만들기' }).click()
  await expect(repositoryDialog).toBeHidden()
  await forkDialog.getByRole('button', { name: /Draft Version 만들기/ }).click()

  await expect(manager.getByRole('combobox', { name: 'Namespace' })).toHaveValue('designer')
  const draftEditor = manager.getByRole('region', { name: 'Draft Version editor' })
  await expect(draftEditor).toBeVisible()
  await expect(page.locator('footer').last()).toContainText('Draft Versions · 1')
  await expect(draftEditor.getByRole('button', { name: '새 Version 발행' })).toBeEnabled({ timeout: 30_000 })
  await draftEditor.getByRole('button', { name: '새 Version 발행' }).click()
  const publishDialog = page.getByRole('dialog', { name: 'Geometry 발행 계획' })
  await expect(publishDialog).toContainText(exactCoordinate)
  await publishDialog.getByRole('button', { name: '계획대로 발행' }).click()

  await expect(manager.getByRole('button', { name: 'v0.1.0' })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('footer').last()).toContainText('Draft Versions · 0')
})

test('opens Geometry export publishing from the Source menu and Experiment ribbon', async ({ page }) => {
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
          cadApiVersion: 8,
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

  const ribbon = page.getByRole('region', { name: 'Experiment 리본' })
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
  test.setTimeout(90_000)
  const timestamp = '2026-08-13T00:00:00Z'
  const coordinate = 'caemble:geometry/designer/common/plate@1.2.3'
  const nextCoordinate = 'caemble:geometry/designer/common/plate@1.2.4'
  const localCoordinate = 'caemble:geometry/designer/common/plate@local'
  const planHash = 'f'.repeat(64)
  const geometrySource = `import { type Geometry } from '@caemble/core'
export const Plate: Geometry = () => <box size={[1, 1, 1]} />
export const Sphere: Geometry = () => <sphere radius={1} />
`
  const sourceHash = createHash('sha256').update(geometrySource).digest('hex')
  const moduleHash = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 2,
        moduleFormatVersion: 4,
        cadApiVersion: 8,
        coordinate,
        sourceHash,
        imports: [],
      }),
    )
    .digest('hex')
  let publishedSource = geometrySource
  let publishedSourceHash = sourceHash
  let publishedModuleHash = moduleHash
  let published = false
  let repositoryArchived = false
  let repositoryDescription = 'Reusable parts'
  let repositoryDeleteRequests = 0
  const repository = {
    id: 1,
    user_id: user.id,
    namespace: 'designer',
    slug: 'common',
    description: repositoryDescription,
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
    cad_api_version: 8,
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
    if (path === `/geometry/repositories/${repository.id}/archive`) {
      repositoryArchived = true
      return json(route, {
        id: repository.id,
        userId: repository.user_id,
        namespace: repository.namespace,
        slug: repository.slug,
        description: repositoryDescription,
        archivedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    }
    if (path === `/geometry/repositories/${repository.id}/restore`) {
      repositoryArchived = false
      return json(route, {
        id: repository.id,
        userId: repository.user_id,
        namespace: repository.namespace,
        slug: repository.slug,
        description: repositoryDescription,
        archivedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    }
    if (path === `/geometry/repositories/${repository.id}` && route.request().method() === 'PUT') {
      repositoryDescription = (route.request().postDataJSON() as { description: string }).description
      return json(route, {
        id: repository.id,
        userId: repository.user_id,
        namespace: repository.namespace,
        slug: repository.slug,
        description: repositoryDescription,
        archivedAt: repositoryArchived ? timestamp : null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    }
    if (path === `/geometry/repositories/${repository.id}` && route.request().method() === 'DELETE') {
      repositoryDeleteRequests += 1
      return json(route, null)
    }
    if (path === '/geometry/publish/plan') {
      const request = route.request().postDataJSON() as {
        targetDraftId: string
        drafts: Array<Record<string, unknown> & { draftId: string; source: string }>
      }
      const draft = request.drafts[0]!
      publishedSource = draft.source
      publishedSourceHash = createHash('sha256').update(publishedSource).digest('hex')
      publishedModuleHash = createHash('sha256')
        .update(
          JSON.stringify({
            schemaVersion: 2,
            moduleFormatVersion: 4,
            cadApiVersion: 8,
            coordinate: nextCoordinate,
            sourceHash: publishedSourceHash,
            imports: [],
          }),
        )
        .digest('hex')
      return json(route, {
        planHash,
        steps: [
          {
            ...draft,
            baseGeometryVersionId: version.id,
            repositoryId: repository.id,
            repository: repository.slug,
            package: geometryPackage.name,
            version: '1.2.4',
            coordinate: nextCoordinate,
            localCoordinate,
            description: version.description,
            sourceHash: publishedSourceHash,
            moduleHash: publishedModuleHash,
            exports: ['Plate', 'Sphere'],
            imports: [],
          },
        ],
        replacements: [{ draftId: request.targetDraftId, localCoordinate, coordinate: nextCoordinate }],
      })
    }
    if (path === '/geometry/publish') {
      const request = route.request().postDataJSON() as { targetDraftId: string; planHash: string }
      expect(request.planHash).toBe(planHash)
      published = true
      return json(route, {
        planHash,
        published: [
          {
            id: 4,
            packageId: geometryPackage.id,
            coordinate: nextCoordinate,
            version: '1.2.4',
            description: version.description,
            sourceHash: publishedSourceHash,
            moduleHash: publishedModuleHash,
            moduleFormatVersion: 4,
            cadApiVersion: 8,
            archivedAt: null,
            createdAt: timestamp,
          },
        ],
        replacements: [{ draftId: request.targetDraftId, localCoordinate, coordinate: nextCoordinate }],
      })
    }
    if (path === '/geometry/repositories/list') {
      return json(route, {
        total: 1,
        items: [
          {
            ...repository,
            description: repositoryDescription,
            archived_at: repositoryArchived ? timestamp : null,
            package_count: 1,
            version_count: published ? 2 : 1,
          },
        ],
      })
    }
    if (path === '/geometry/packages/list') return json(route, { total: 1, items: [geometryPackage] })
    if (path === '/geometry/versions/list') {
      const nextVersion = {
        ...version,
        id: 4,
        version_patch: 4,
        description: version.description,
        source: publishedSource,
        source_hash: publishedSourceHash,
        module_hash: publishedModuleHash,
        coordinate: nextCoordinate,
        version: '1.2.4',
      }
      return json(route, { total: published ? 2 : 1, items: published ? [nextVersion, version] : [version] })
    }
    if (path === `/geometry/versions/${version.id}/resolve`) {
      return json(route, {
        schemaVersion: 2,
        root: { geometryVersionId: version.id, coordinate, moduleHash, exports: ['Plate'] },
        modules: [
          {
            geometryVersionId: version.id,
            coordinate,
            moduleFormatVersion: 4,
            cadApiVersion: 8,
            description: version.description,
            source: version.source,
            sourceHash,
            moduleHash,
            imports: [],
          },
        ],
      })
    }
    if (path === '/geometry/versions/4/resolve') {
      return json(route, {
        schemaVersion: 2,
        root: {
          geometryVersionId: 4,
          coordinate: nextCoordinate,
          moduleHash: publishedModuleHash,
          exports: ['Plate', 'Sphere'],
        },
        modules: [
          {
            geometryVersionId: 4,
            coordinate: nextCoordinate,
            moduleFormatVersion: 4,
            cadApiVersion: 8,
            description: version.description,
            source: publishedSource,
            sourceHash: publishedSourceHash,
            moduleHash: publishedModuleHash,
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
  await mockCanonicalCatalog(page)

  await page.goto('/')
  await page.getByRole('menuitem', { name: 'Source' }).click()
  await page.getByRole('menuitem', { name: 'Load Experiment' }).click()
  await page
    .getByRole('dialog', { name: 'Experiment 불러오기' })
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
  const manager = page.getByLabel('Geometry Manager')
  await expect(manager).toBeVisible()
  await manager.getByRole('combobox', { name: 'Namespace' }).selectOption('designer')
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

  await page.getByRole('tab', { name: 'Geometry', exact: true }).click()
  await expect(manager).toBeVisible()
  await expect(manager.getByRole('combobox', { name: 'Namespace' })).toHaveValue('designer')

  await manager.getByRole('button', { name: 'Repository 관리' }).click()
  const repositoryManager = page.getByRole('dialog', { name: 'Repository 관리' })
  await expect(repositoryManager).toContainText('1 packages · 1 versions')
  await repositoryManager.getByLabel('common 설명').fill('Updated repository')
  await repositoryManager.getByRole('button', { name: '저장' }).click()
  await expect(repositoryManager.getByLabel('common 설명')).toHaveValue('Updated repository')
  await repositoryManager.getByRole('button', { name: 'Archive' }).click()
  await expect(repositoryManager.getByRole('button', { name: 'Restore' })).toBeVisible()
  await repositoryManager.getByRole('button', { name: 'Restore' }).click()
  await expect(repositoryManager.getByRole('button', { name: 'Archive' })).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await repositoryManager.getByRole('button', { name: '삭제' }).click()
  await expect(page.getByText(/현재 .* 참조하는 Repository는 삭제할 수 없습니다/)).toBeVisible()
  expect(repositoryDeleteRequests).toBe(0)
  await repositoryManager.getByRole('button', { name: '닫기' }).click()

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

  await page.getByRole('tab', { name: 'Experiment', exact: true }).click()
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
  await expect(manager.getByRole('combobox', { name: 'Namespace' })).toHaveValue('designer')
  await manager.getByRole('tab', { name: 'Source' }).click()
  await manager.getByRole('button', { name: '새 Version 편집' }).click()

  const workspace = page.getByRole('region', { name: 'Draft Version editor' })
  await expect(workspace).toBeVisible()
  await expect(manager.getByRole('button', { name: /Draft Draft Version/ })).toBeVisible()

  const saveGeometry = workspace.getByRole('button', { name: '새 Version 발행' })
  await expect(saveGeometry).toBeEnabled({ timeout: 30_000 })
  await expect(workspace.getByText('Preview current', { exact: true })).toBeVisible()
  await expect(workspace.getByRole('alert')).toHaveCount(0)

  const previewExport = workspace.getByRole('combobox', { name: 'Preview export' })
  await expect(previewExport).toHaveValue('Plate')
  await previewExport.selectOption('Sphere')
  await expect(previewExport).toHaveValue('Sphere')
  await expect(workspace.getByText('Preview current', { exact: true })).toBeVisible()
  await previewExport.selectOption('Plate')
  await expect(previewExport).toHaveValue('Plate')

  const draftEditor = workspace.locator('.monaco-editor:visible')
  await draftEditor.getByRole('textbox', { name: 'Editor content' }).focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('export const Broken = (')
  await expect(workspace.getByRole('alert')).toContainText('마지막 정상 Viewer scene을 유지합니다.')
  await expect(saveGeometry).toBeDisabled()

  await draftEditor.getByRole('textbox', { name: 'Editor content' }).focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(`${geometrySource}// manager-version-edit\n`)
  await expect(workspace.getByText('Preview current', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(saveGeometry).toBeEnabled({ timeout: 30_000 })
  await saveGeometry.click()
  const publishDialog = page.getByRole('dialog', { name: 'Geometry 발행 계획' })
  await expect(publishDialog).toContainText(nextCoordinate)
  await publishDialog.getByRole('button', { name: '계획대로 발행' }).click()
  await expect(manager.getByRole('button', { name: 'v1.2.4' })).toBeVisible({ timeout: 15_000 })
  await expect(manager.getByRole('button', { name: /Draft Draft Version/ })).toHaveCount(0)
  await expect(page.locator('footer').last()).toContainText('Draft Versions · 0')
})
