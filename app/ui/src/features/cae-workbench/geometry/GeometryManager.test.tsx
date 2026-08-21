// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeometryManager } from './GeometryManager'
import type { GeometryWorkspaceState } from './useGeometryWorkspaceState'

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

function renderManager(namespace: string | null, openCatalogDraft = vi.fn()) {
  return {
    openCatalogDraft,
    ...render(
      <GeometryManager
        geometry={{ namespace, openCatalogDraft } as unknown as GeometryWorkspaceState}
        onCatalogDraftOpened={vi.fn()}
        onEdit={vi.fn()}
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

  it('lets an anonymous local namespace clone an official Geometry draft', async () => {
    const openCatalogDraft = vi.fn(() => ({
      coordinate: 'caemble:geometry/local/catalog/basketball-goal@local',
      created: true,
    }))
    renderManager('local', openCatalogDraft)

    expect(screen.queryByRole('tab', { name: 'Workspace Packages' })).not.toBeInTheDocument()
    expect(await screen.findByText('Official standalone Geometry')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '로컬 Draft로 열기' }))

    expect(openCatalogDraft).toHaveBeenCalledWith({
      key: 'basketball-goal',
      source: geometryDetail.source,
      description: geometryDetail.description,
    })
  })

  it('guides a signed-in user to configure a namespace before cloning', async () => {
    mocks.authenticated = true
    renderManager(null)

    expect(await screen.findByText('Account에서 기본 Geometry namespace를 먼저 설정하세요.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '로컬 Draft로 열기' })).toBeDisabled())
    expect(screen.getByRole('tab', { name: 'Workspace Packages' })).toBeInTheDocument()
  })
})
