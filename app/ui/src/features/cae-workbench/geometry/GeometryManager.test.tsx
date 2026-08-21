// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeometryPackageRecord, GeometryRepositoryRecord, GeometryVersionRecord } from '@/api'
import { GeometryManager } from './GeometryManager'
import { GeometryManagerRibbon } from './GeometryManagerRibbon'
import type { GeometryManagerRibbonState } from './geometryManagerTypes'
import type { GeometryManagerState } from './useGeometryWorkspaceState'

type PackageListRequest = {
  selected_ids?: number[]
  text_filter?: Record<string, string[]>
  filter?: Record<string, unknown[]>
}

const mocks = vi.hoisted(() => ({
  authenticated: false,
  user: null as { roles: string[] } | null,
  getGeometry: vi.fn(),
  listGeometries: vi.fn(),
  listGeometryRepositories: vi.fn(),
  listPackages: vi.fn(
    async (request?: PackageListRequest): Promise<{ total: number; items: GeometryPackageRecord[] }> => {
      void request
      return { total: 0, items: [] }
    },
  ),
  listVersions: vi.fn(async (): Promise<{ total: number; items: GeometryVersionRecord[] }> => ({
    total: 0,
    items: [],
  })),
  listRepositories: vi.fn(async (): Promise<{ total: number; items: GeometryRepositoryRecord[] }> => ({
    total: 0,
    items: [],
  })),
}))

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: mocks.authenticated, user: mocks.user }),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    dbTables: {
      ...actual.dbTables,
      GeometryPackage: { ...actual.dbTables.GeometryPackage, listRows: mocks.listPackages },
      GeometryRepository: { ...actual.dbTables.GeometryRepository, listRows: mocks.listRepositories },
      GeometryVersion: { ...actual.dbTables.GeometryVersion, listRows: mocks.listVersions },
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
      listGeometryRepositories: mocks.listGeometryRepositories,
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
  description: 'Example standalone Geometry',
  repository: 'getting-started',
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

const workspacePackages: GeometryPackageRecord[] = [
  {
    id: 7,
    repository_id: 3,
    name: 'bracket',
    user_id: 'user-1',
    namespace: 'designer',
    repository: 'forks',
    repository_archived_at: null,
    version_count: 0,
    latest_version: null,
    created_at: null,
    updated_at: null,
  },
  {
    id: 8,
    repository_id: 4,
    name: 'plate',
    user_id: 'user-2',
    namespace: 'shared',
    repository: 'catalog',
    repository_archived_at: null,
    version_count: 0,
    latest_version: null,
    created_at: null,
    updated_at: null,
  },
]

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
  managerSelection: Partial<Pick<GeometryManagerState, 'managerModules' | 'selectedCoordinate'>> = {},
) {
  const previewSource = vi.fn()
  const previewPublishedVersion = vi.fn(async () => undefined)
  const setManagerView = vi.fn()
  const setManagerNamespace = vi.fn()
  const setManagerRepository = vi.fn()
  const setSelectedCatalogKey = vi.fn()
  const setSelectedCoordinate = vi.fn()
  function StatefulManager() {
    const [managerView, applyManagerView] = useState<'examples' | 'workspace'>('examples')
    const [managerNamespace, applyManagerNamespace] = useState('examples')
    const [managerRepository, applyManagerRepository] = useState('all')
    const [selectedCatalogKey, applySelectedCatalogKey] = useState<string | null>('basketball-goal')
    const [ribbonState, setRibbonState] = useState<GeometryManagerRibbonState | null>(null)
    return (
      <>
        <GeometryManagerRibbon state={ribbonState} />
        <GeometryManager
          geometry={
            {
              namespace,
              draftVersions: {},
              managerView,
              managerNamespace,
              managerRepository,
              publishPlan: null,
              repositories,
              selectedCoordinate: managerSelection.selectedCoordinate ?? null,
              selectedCatalogKey,
              currentSnapshot: { schemaVersion: 2, entryImports: [], modules: [] },
              managerModules: managerSelection.managerModules ?? [],
              experimentModules: [],
              previewDiagnostics: [],
              previewError: null,
              previewPublishedVersion,
              previewSource,
              setSelectedCoordinate,
              setManagerView: (value: 'examples' | 'workspace') => {
                setManagerView(value)
                applyManagerView(value)
              },
              setManagerNamespace: (value: string) => {
                setManagerNamespace(value)
                applyManagerNamespace(value)
              },
              setManagerRepository: (value: string) => {
                setManagerRepository(value)
                applyManagerRepository(value)
              },
              setSelectedCatalogKey: (value: string | null) => {
                setSelectedCatalogKey(value)
                applySelectedCatalogKey(value)
              },
              forkOfficial,
            } as unknown as GeometryManagerState
          }
          onOpenExperiment={vi.fn()}
          onOpenGeometrySource={vi.fn()}
          onRibbonStateChange={setRibbonState}
          onUse={vi.fn()}
        />
      </>
    )
  }
  return {
    forkOfficial,
    previewPublishedVersion,
    previewSource,
    setManagerNamespace,
    setManagerRepository,
    setManagerView,
    setSelectedCatalogKey,
    ...render(<StatefulManager />, { wrapper: Harness }),
  }
}

describe('unified Geometry Manager', () => {
  beforeEach(() => {
    mocks.authenticated = false
    mocks.user = null
    mocks.getGeometry.mockReset().mockResolvedValue(geometryDetail)
    mocks.listGeometries.mockReset().mockResolvedValue({ items: [geometryItem], nextCursor: null, total: 1 })
    mocks.listGeometryRepositories
      .mockReset()
      .mockResolvedValue([{ slug: 'getting-started', title: 'Getting Started', description: '', ordinal: 0 }])
    mocks.listPackages.mockReset().mockResolvedValue({ total: 0, items: [] })
    mocks.listVersions.mockReset().mockResolvedValue({ total: 0, items: [] })
    mocks.listRepositories.mockReset().mockResolvedValue({ total: 0, items: [] })
  })
  afterEach(cleanup)

  it('uses Examples as a highlighted namespace and keeps its source read-only', async () => {
    const { forkOfficial, setManagerNamespace, setManagerRepository } = renderManager('local')

    expect(screen.queryByRole('tab', { name: 'Official Catalog' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Workspace Packages' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '전체' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Workspace' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Namespace' })).toHaveValue('examples')
    expect(screen.getByRole('option', { name: 'Examples' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'local' })).toBeInTheDocument()
    expect(await screen.findByText('Example standalone Geometry')).toBeInTheDocument()
    expect(screen.queryByLabelText('Official Packages')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Workspace Packages')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Geometry Packages list')).toHaveTextContent('Basketball Goal')
    expect(screen.getByRole('textbox', { name: 'Geometry source' })).toHaveAttribute('readonly')
    expect(screen.getByRole('textbox', { name: 'Geometry source' })).toHaveValue(geometryDetail.source)
    expect(screen.getByRole('button', { name: '개인 Repository로 Fork' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /Basketball Goal/ }))
    expect(screen.getByRole('combobox', { name: 'Namespace' })).toHaveValue('examples')
    expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue('all')
    expect(setManagerNamespace).not.toHaveBeenCalled()
    expect(setManagerRepository).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox', { name: 'Geometry source' }), {
      target: { value: 'export const BasketballGoal = () => <box />' },
    })
    expect(forkOfficial).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('combobox', { name: 'Namespace' }), { target: { value: 'local' } })
    expect(await screen.findByText('표시할 Geometry가 없습니다.')).toBeInTheDocument()
    expect(screen.getByLabelText('Geometry Packages list')).not.toHaveTextContent('Basketball Goal')
    expect(await screen.findByRole('status')).toHaveTextContent('현재 목록 필터 밖의 선택 항목')
    expect(screen.getByRole('textbox', { name: 'Geometry source' })).toHaveValue(geometryDetail.source)
  })

  it('requests and displays exactly one Workspace namespace', async () => {
    mocks.authenticated = true
    mocks.user = { roles: ['admin'] }
    mocks.listRepositories.mockResolvedValue({
      total: 2,
      items: [
        {
          id: 3,
          namespace: 'designer',
          slug: 'forks',
          user_id: 'user-1',
          description: null,
          archived_at: null,
          created_at: null,
          updated_at: null,
        },
        {
          id: 4,
          namespace: 'shared',
          slug: 'catalog',
          user_id: 'user-2',
          description: null,
          archived_at: null,
          created_at: null,
          updated_at: null,
        },
      ],
    })
    renderManager('designer')

    const selector = screen.getByRole('combobox', { name: 'Namespace' })
    expect(await screen.findByRole('option', { name: 'shared' })).toBeInTheDocument()
    fireEvent.change(selector, { target: { value: 'shared' } })

    await waitFor(() =>
      expect(mocks.listPackages).toHaveBeenCalledWith(
        expect.objectContaining({ text_filter: expect.objectContaining({ namespace: ['shared'] }) }),
      ),
    )
    expect(screen.getByRole('option', { name: '모든 namespace' })).toBeInTheDocument()
  })

  it('keeps Package selection independent from namespace and Repository filters', async () => {
    mocks.authenticated = true
    mocks.user = { roles: ['admin'] }
    const repositories: GeometryRepositoryRecord[] = [
      {
        id: 3,
        namespace: 'designer',
        slug: 'forks',
        user_id: 'user-1',
        description: null,
        archived_at: null,
        created_at: null,
        updated_at: null,
      },
      {
        id: 4,
        namespace: 'shared',
        slug: 'catalog',
        user_id: 'user-2',
        description: null,
        archived_at: null,
        created_at: null,
        updated_at: null,
      },
    ]
    mocks.listRepositories.mockResolvedValue({ total: repositories.length, items: repositories })
    mocks.listPackages.mockImplementation(async (request?: PackageListRequest) => {
      let items = workspacePackages
      if (request?.selected_ids?.length) {
        items = items.filter((item) => request.selected_ids!.includes(item.id))
      }
      const namespace = request?.text_filter?.namespace?.[0]
      if (namespace) items = items.filter((item) => item.namespace === namespace)
      const repositoryId = request?.filter?.repository_id?.[0]
      if (typeof repositoryId === 'number') items = items.filter((item) => item.repository_id === repositoryId)
      return { total: items.length, items }
    })
    const { setManagerNamespace, setManagerRepository } = renderManager('designer')

    const namespaceSelector = screen.getByRole('combobox', { name: 'Namespace' })
    const repositorySelector = screen.getByRole('combobox', { name: 'Repository' })
    await screen.findByRole('option', { name: 'designer' })

    fireEvent.change(namespaceSelector, { target: { value: 'all' } })
    const packageRow = await screen.findByText('designer/forks/bracket')
    setManagerNamespace.mockClear()
    setManagerRepository.mockClear()
    fireEvent.click(packageRow.closest('button')!)
    await screen.findByRole('heading', { name: 'bracket' })
    expect(namespaceSelector).toHaveValue('all')
    expect(repositorySelector).toHaveValue('all')
    expect(setManagerNamespace).not.toHaveBeenCalled()
    expect(setManagerRepository).not.toHaveBeenCalled()

    fireEvent.change(namespaceSelector, { target: { value: 'shared' } })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'bracket' })).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('현재 목록 필터 밖의 선택 항목'))
    fireEvent.change(namespaceSelector, { target: { value: 'all' } })

    fireEvent.change(namespaceSelector, { target: { value: 'designer' } })
    await waitFor(() => expect(repositorySelector).toContainElement(screen.getByRole('option', { name: 'forks' })))
    fireEvent.change(repositorySelector, { target: { value: 'designer/forks' } })
    fireEvent.change(namespaceSelector, { target: { value: 'all' } })
    await waitFor(() => {
      expect(namespaceSelector).toHaveValue('all')
      expect(repositorySelector).toHaveValue('all')
    })

    fireEvent.change(namespaceSelector, { target: { value: 'designer' } })
    await waitFor(() => expect(repositorySelector).toContainElement(screen.getByRole('option', { name: 'forks' })))
    fireEvent.change(repositorySelector, { target: { value: 'designer/forks' } })
    fireEvent.change(repositorySelector, { target: { value: 'all' } })
    await waitFor(() => expect(repositorySelector).toHaveValue('all'))
  })

  it('does not derive filters from the selected Published Version', async () => {
    mocks.authenticated = true
    const coordinate = 'caemble:geometry/designer/forks/bracket@1.0.0' as const
    const sourceHash = 'a'.repeat(64)
    const moduleHash = 'b'.repeat(64)
    const version: GeometryVersionRecord = {
      id: 21,
      package_id: 7,
      version_major: 1,
      version_minor: 0,
      version_patch: 0,
      description: null,
      source: 'export const Bracket = () => <box />',
      source_hash: sourceHash,
      module_hash: moduleHash,
      module_format_version: 4,
      cad_api_version: 8,
      archived_at: null,
      repository_id: 3,
      namespace: 'designer',
      repository: 'forks',
      package_name: 'bracket',
      coordinate,
      version: '1.0.0',
      created_at: null,
      updated_at: null,
    }
    mocks.listVersions.mockResolvedValue({ total: 1, items: [version] })

    const { previewPublishedVersion, setManagerNamespace, setManagerRepository } = renderManager(
      'designer',
      vi.fn(),
      [],
      {
        selectedCoordinate: coordinate,
        managerModules: [
          {
            geometryVersionId: version.id,
            coordinate,
            moduleFormatVersion: 4,
            cadApiVersion: 8,
            description: null,
            source: version.source,
            sourceHash,
            moduleHash,
            imports: [],
          },
        ],
      },
    )

    await waitFor(() => expect(previewPublishedVersion).toHaveBeenCalledWith(version.id))
    expect(screen.getByRole('combobox', { name: 'Namespace' })).toHaveValue('examples')
    expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue('all')
    expect(setManagerNamespace).not.toHaveBeenCalled()
    expect(setManagerRepository).not.toHaveBeenCalled()
  })

  it('creates an Example fork only after the signed-in user confirms its target', async () => {
    mocks.authenticated = true
    const forkOfficial = vi.fn(() => 'caemble:geometry/designer/forks/basketball-goal@local')
    const { setManagerNamespace, setManagerRepository } = renderManager('designer', forkOfficial, [
      {
        id: 3,
        namespace: 'designer',
        slug: 'forks',
        user_id: 'user-1',
        description: null,
        archived_at: null,
        created_at: null,
        updated_at: null,
      },
    ])

    fireEvent.click(await screen.findByRole('button', { name: '개인 Repository로 Fork' }))
    const dialog = screen.getByRole('dialog', { name: '개인 Repository로 Fork' })
    fireEvent.change(dialog.querySelector('select')!, { target: { value: '3' } })
    fireEvent.submit(dialog.querySelector('form')!)

    await waitFor(() =>
      expect(forkOfficial).toHaveBeenCalledWith({
        key: 'basketball-goal',
        repository: 'forks',
        packageName: 'basketball-goal',
        source: geometryDetail.source,
        description: geometryDetail.description,
        repositoryId: 3,
      }),
    )
    expect(screen.getByRole('combobox', { name: 'Namespace' })).toHaveValue('examples')
    expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveValue('all')
    expect(setManagerNamespace).not.toHaveBeenCalled()
    expect(setManagerRepository).not.toHaveBeenCalled()
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
    const dialog = screen.getByRole('dialog', { name: '개인 Repository로 Fork' })
    fireEvent.change(dialog.querySelector('select')!, { target: { value: '3' } })
    fireEvent.submit(dialog.querySelector('form')!)

    await waitFor(() =>
      expect(mocks.listPackages).toHaveBeenCalledWith(
        expect.objectContaining({ text_filter: { name: ['basketball-goal'] } }),
      ),
    )
    expect(forkOfficial).not.toHaveBeenCalled()
  })
})
