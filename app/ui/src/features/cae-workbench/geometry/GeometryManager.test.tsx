// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeometryPackageRecord } from '@/api'
import { GeometryManager } from './GeometryManager'
import type { GeometryManagerState } from './useGeometryWorkspaceState'

type PackageListRequest = { text_filter?: Record<string, string[]> }

const mocks = vi.hoisted(() => ({
  authenticated: false,
  getGeometry: vi.fn(),
  listGeometries: vi.fn(),
  listPackages: vi.fn(
    async (request?: PackageListRequest): Promise<{ total: number; items: GeometryPackageRecord[] }> => {
      void request
      return { total: 0, items: [] }
    },
  ),
  listRepositories: vi.fn(async () => ({ total: 0, items: [] })),
}))

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: mocks.authenticated, user: null }),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    dbTables: {
      ...actual.dbTables,
      GeometryPackage: { ...actual.dbTables.GeometryPackage, listRows: mocks.listPackages },
      GeometryRepository: { ...actual.dbTables.GeometryRepository, listRows: mocks.listRepositories },
    },
  }
})
vi.mock('@/api/catalog', async (importActual) => {
  const actual = await importActual<typeof import('@/api/catalog')>()
  return {
    ...actual,
    catalogApi: {
      ...actual.catalogApi,
      getGeometry: mocks.getGeometry,
      listGeometries: mocks.listGeometries,
    },
  }
})
vi.mock('@/features/viewer/editor/CadEditor', () => ({
  default: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string
    onChange: (value: string) => void
    readOnly?: boolean
  }) => (
    <textarea
      aria-label="Geometry source"
      readOnly={readOnly}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

const geometryItem = {
  key: 'basketball-goal',
  title: 'Basketball Goal',
  description: 'Official standalone Geometry',
  cadApiVersion: 8 as const,
  moduleFormatVersion: 4 as const,
  lengthUnit: 'mm',
  exportName: 'BasketballGoal',
  sourceHash: 'b'.repeat(64),
  concepts: ['position'],
  materialRoles: [],
  relatedElements: ['box', 'cylinder'],
}
const geometryDetail = {
  ...geometryItem,
  source: "import { type Geometry } from '@caemble/core'\nexport const BasketballGoal: Geometry = () => <></>\n",
}

function Harness({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  )
}

function renderManager(
  namespace: string | null,
  forkOfficial = vi.fn(),
  repositories: GeometryManagerState['repositories'] = [],
) {
  const previewSource = vi.fn()
  const setManagerView = vi.fn()
  const setSelectedCatalogKey = vi.fn()
  return {
    forkOfficial,
    previewSource,
    setManagerView,
    setSelectedCatalogKey,
    ...render(
      <GeometryManager
        geometry={
          {
            namespace,
            draftVersions: {},
            managerView: 'official',
            publishPlan: null,
            repositories,
            selectedCoordinate: null,
            selectedCatalogKey: 'basketball-goal',
            currentSnapshot: { schemaVersion: 2, entryImports: [], modules: [] },
            managerModules: [],
            experimentModules: [],
            previewDiagnostics: [],
            previewError: null,
            previewSource,
            setSelectedCoordinate: vi.fn(),
            setManagerView,
            setSelectedCatalogKey,
            forkOfficial,
          } as unknown as GeometryManagerState
        }
        onOpenExperiment={vi.fn()}
        onOpenGeometrySource={vi.fn()}
        onUse={vi.fn()}
      />,
      { wrapper: Harness },
    ),
  }
}

describe('unified Geometry Manager', () => {
  beforeEach(() => {
    mocks.authenticated = false
    mocks.getGeometry.mockReset().mockResolvedValue(geometryDetail)
    mocks.listGeometries.mockReset().mockResolvedValue({ items: [geometryItem], nextCursor: null, total: 1 })
    mocks.listPackages.mockReset().mockResolvedValue({ total: 0, items: [] })
    mocks.listRepositories.mockReset().mockResolvedValue({ total: 0, items: [] })
  })
  afterEach(cleanup)

  it('shows both sources in one browser and keeps Official source read-only', async () => {
    const { forkOfficial } = renderManager('local')

    expect(screen.queryByRole('tab', { name: 'Official Catalog' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Workspace Packages' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '전체' })).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByText('Official standalone Geometry')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Official Packages' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Workspace Packages' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Geometry source' })).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: '개인 Repository로 Fork' })).toBeDisabled()

    fireEvent.change(screen.getByRole('textbox', { name: 'Geometry source' }), {
      target: { value: 'export const BasketballGoal = () => <box />' },
    })
    expect(forkOfficial).not.toHaveBeenCalled()
  })

  it('creates an Official fork only after the signed-in user confirms its target', async () => {
    mocks.authenticated = true
    const forkOfficial = vi.fn(() => 'caemble:geometry/designer/forks/basketball-goal@local')
    renderManager('designer', forkOfficial)

    fireEvent.click(await screen.findByRole('button', { name: '개인 Repository로 Fork' }))
    const dialog = screen.getByRole('dialog', { name: '개인 Repository로 Fork' })
    fireEvent.submit(dialog.querySelector('form')!)

    expect(forkOfficial).toHaveBeenCalledWith({
      key: 'basketball-goal',
      repository: 'forks',
      packageName: 'basketball-goal',
      source: geometryDetail.source,
      description: geometryDetail.description,
      repositoryId: null,
    })
  })

  it('requires a Geometry namespace before forking', async () => {
    mocks.authenticated = true
    renderManager(null)

    expect(await screen.findByText('Account에서 기본 Geometry namespace를 먼저 설정하세요.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '개인 Repository로 Fork' })).toBeDisabled()
  })

  it('rejects a Fork target that already contains the same Package', async () => {
    mocks.authenticated = true
    mocks.listPackages.mockImplementation(async (request?: PackageListRequest) =>
      request?.text_filter?.name
        ? {
            total: 1,
            items: [
              {
                id: 7,
                repository_id: 3,
                name: 'basketball-goal',
                user_id: 'user-1',
                namespace: 'designer',
                repository: 'forks',
                repository_archived_at: null,
                version_count: 1,
                latest_version: '0.1.0',
                created_at: null,
                updated_at: null,
              },
            ],
          }
        : { total: 0, items: [] },
    )
    const forkOfficial = vi.fn()
    renderManager('designer', forkOfficial, [
      {
        id: 3,
        user_id: 'user-1',
        namespace: 'designer',
        slug: 'forks',
        description: null,
        archived_at: null,
        created_at: null,
        updated_at: null,
      },
    ])

    fireEvent.click(await screen.findByRole('button', { name: '개인 Repository로 Fork' }))
    fireEvent.submit(screen.getByRole('dialog', { name: '개인 Repository로 Fork' }).querySelector('form')!)

    await waitFor(() =>
      expect(mocks.listPackages).toHaveBeenCalledWith(
        expect.objectContaining({ text_filter: { name: ['basketball-goal'] } }),
      ),
    )
    expect(forkOfficial).not.toHaveBeenCalled()
  })
})
