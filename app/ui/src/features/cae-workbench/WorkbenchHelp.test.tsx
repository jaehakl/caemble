import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { WorkbenchHelpDetail, WorkbenchHelpExplorer } from './WorkbenchHelp'

vi.mock('@/features/docs/docsKnowledge', () => ({ catalogDocsKnowledge: [], manualDocsKnowledge: [] }))
vi.mock('@/lib/cad/catalog', () => ({ cadElementCatalog: [] }))

const materialModel = vi.hoisted(() => ({
  key: 'em.drude-isotropic@1',
  labelKo: 'Drude 등방성 응답',
  description: 'Drude 물리 모델입니다.',
  equation: 'epsilon(omega) = epsilonInfinity - omegaP^2 / (...)',
  conventions: 'frequency는 Hz입니다.',
  parameterSchema: {
    kind: 'object' as const,
    required: ['epsilonInfinity'],
    fields: {
      epsilonInfinity: {
        kind: 'value' as const,
        dtype: 'float64' as const,
        shape: [],
        quantityKind: 'dimensionless',
        unit: '{ratio}',
      },
    },
  },
  solverRequirements: [
    { solverName: 'fdtd', solverVersion: '2.0.0', role: 'body', groupKey: 'response', required: true },
  ],
}))

const queryState = vi.hoisted(() => ({ searchQuery: '' }))

vi.mock('@/features/catalog/queryOptions', () => ({
  catalogMaterialModelsQueryOptions: (query: { q: string }, enabled: boolean) => ({
    queryKey: ['material-models', query.q],
    enabled,
    queryFn: async () => {
      queryState.searchQuery = query.q
      return { items: [materialModel], nextCursor: null, total: 1 }
    },
  }),
  catalogMaterialModelQueryOptions: (key: string, enabled: boolean) => ({
    queryKey: ['material-model', key],
    enabled,
    queryFn: async () => materialModel,
  }),
  catalogQuantityKindsQueryOptions: (_query: unknown, enabled: boolean) => ({
    queryKey: ['quantity-kinds'],
    enabled,
    queryFn: async () => ({ items: [], nextCursor: null, total: 0 }),
  }),
  catalogQuantityKindQueryOptions: (key: string, enabled: boolean) => ({
    queryKey: ['quantity-kind', key],
    enabled,
    queryFn: async () => null,
  }),
  catalogSolversQueryOptions: (_query: unknown, enabled: boolean) => ({
    queryKey: ['solvers'],
    enabled,
    queryFn: async () => ({ items: [], nextCursor: null, total: 0 }),
  }),
  catalogSolverQueryOptions: (name: string, version: string, enabled: boolean) => ({
    queryKey: ['solver', name, version],
    enabled,
    queryFn: async () => null,
  }),
}))

function MaterialModelHelp() {
  const [selectedItem, setSelectedItem] = useState<string | null>(null)
  return (
    <>
      <aside aria-label="Explorer">
        <WorkbenchHelpExplorer kind="materials" selectedItem={selectedItem} onSelectedItemChange={setSelectedItem} />
      </aside>
      <aside aria-label="Detail">
        <WorkbenchHelpDetail kind="materials" selectedItem={selectedItem} />
      </aside>
    </>
  )
}

describe('Workbench Material Model Help', () => {
  it('searches, selects, and shows the Material Model contract and supported Solver', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <MaterialModelHelp />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const explorer = within(screen.getByRole('complementary', { name: 'Explorer' }))
    const detail = within(screen.getByRole('complementary', { name: 'Detail' }))
    expect(await explorer.findByRole('heading', { name: 'Material Model' })).toBeInTheDocument()
    expect(await explorer.findByText('Drude 등방성 응답')).toBeInTheDocument()
    fireEvent.change(explorer.getByRole('textbox', { name: 'Help 검색' }), { target: { value: 'drude' } })
    await waitFor(() => expect(queryState.searchQuery).toBe('drude'))
    expect(await explorer.findByText('Drude 등방성 응답')).toBeInTheDocument()
    expect(explorer.getAllByText('Material Model')).toHaveLength(2)

    fireEvent.click(explorer.getByRole('button', { name: /Drude 등방성 응답/ }))
    expect(await detail.findByText('Material Model 식')).toBeInTheDocument()
    expect(detail.getByText('Material Model parameters')).toBeInTheDocument()
    expect(detail.getByText('fdtd@2.0.0')).toBeInTheDocument()
  })
})
