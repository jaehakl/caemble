// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeometryManager } from './GeometryManager'
import type { GeometryManagerState } from './useGeometryWorkspaceState'

const mocks = vi.hoisted(() => ({
  authenticated: false,
  getGeometry: vi.fn(),
  listGeometries: vi.fn(),
}))

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: mocks.authenticated }),
}))

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
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Geometry source" value={value} onChange={(event) => onChange(event.target.value)} />
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

function renderManager(namespace: string | null, updateCatalogSource = vi.fn()) {
  const previewSource = vi.fn()
  return {
    previewSource,
    updateCatalogSource,
    ...render(
      <GeometryManager
        geometry={
          {
            namespace,
            draftVersions: {},
            managerView: 'official',
            publishPlan: null,
            repositories: [],
            selectedCoordinate: null,
            selectedCatalogKey: 'basketball-goal',
            previewSource,
            setSelectedCoordinate: vi.fn(),
            setManagerView: vi.fn(),
            setSelectedCatalogKey: vi.fn(),
            updateCatalogSource,
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

describe('Geometry Manager official catalog', () => {
  beforeEach(() => {
    mocks.authenticated = false
    mocks.getGeometry.mockReset().mockResolvedValue(geometryDetail)
    mocks.listGeometries.mockReset().mockResolvedValue({ items: [geometryItem], nextCursor: null, total: 1 })
  })
  afterEach(cleanup)

  it('shows Workspace to anonymous users and creates an Official Draft Version on first edit', async () => {
    const updateCatalogSource = vi.fn(() => ({
      coordinate: 'caemble:geometry/local/catalog/basketball-goal@local',
      created: true,
    }))
    renderManager('local', updateCatalogSource)

    expect(screen.getByRole('tab', { name: 'Workspace Packages' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Local Drafts/u })).not.toBeInTheDocument()
    expect(await screen.findByText('Official standalone Geometry')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Geometry source' }), {
      target: { value: 'export const BasketballGoal = () => <box />' },
    })

    expect(updateCatalogSource).toHaveBeenCalledWith({
      key: 'basketball-goal',
      source: 'export const BasketballGoal = () => <box />',
      description: geometryDetail.description,
    })
  })

  it('guides a signed-in user to configure a namespace before editing', async () => {
    mocks.authenticated = true
    renderManager(null)

    expect(await screen.findByText('Account에서 기본 Geometry namespace를 먼저 설정하세요.')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Workspace Packages' })).toBeInTheDocument()
  })
})
