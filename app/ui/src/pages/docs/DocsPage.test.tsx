// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSyntheticSolver } from '@/test/syntheticCatalog'
import { DocsPage } from './DocsPage'

const catalog = vi.hoisted(() => ({
  getMaterialModel: vi.fn(),
  getMaterialParameter: vi.fn(),
  getQuantityKind: vi.fn(),
  getSolver: vi.fn(),
  listMaterialModels: vi.fn(),
  listMaterialParameters: vi.fn(),
  listQuantityKinds: vi.fn(),
  listSolvers: vi.fn(),
  search: vi.fn(),
}))

vi.mock('@/api/catalog', async (importActual) => {
  const actual = await importActual<typeof import('@/api/catalog')>()
  return { ...actual, catalogApi: catalog }
})

afterEach(cleanup)

beforeEach(() => {
  Object.values(catalog).forEach((mock) => mock.mockReset())
  catalog.search.mockImplementation(async (query: string) => {
    const items = {
      'electrical.conductivity': [{
        kind: 'materialParameter', key: query, title: query, subtitle: 'Synthetic Material parameter.',
      }],
      'electromagnetism.ElectricCurrent': [{
        kind: 'quantityKind', key: query, title: query, subtitle: 'Synthetic Quantity Kind.',
      }],
      'dc-current-density@0.1.0': [{
        kind: 'solver', key: query, title: query, subtitle: 'Synthetic Solver.',
      }],
    } as const
    return { items: items[query as keyof typeof items] ?? [] }
  })

  const quantityKind = {
    name: 'electromagnetism.ElectricCurrent',
    domain: 'electromagnetism',
    tensorOrder: 0,
    description: 'Synthetic Quantity Kind.',
    opaque: false,
    applicableUnits: ['A'],
  }
  const materialParameter = {
    key: 'electrical.conductivity',
    domain: 'electrical',
    labelKo: 'synthetic conductivity',
    quantityKind: 'electromagnetism.ElectricConductivity',
    specialQualifiers: [],
  }
  const solver = buildSyntheticSolver('dc-current-density', '0.1.0')

  catalog.listMaterialParameters.mockResolvedValue({ items: [materialParameter], nextCursor: null, total: 1 })
  catalog.listMaterialModels.mockResolvedValue({ items: [], nextCursor: null, total: 0 })
  catalog.getMaterialParameter.mockResolvedValue({
    ...materialParameter,
    quantityKindDefinition: {
      name: materialParameter.quantityKind,
      domain: 'electromagnetism',
      tensorOrder: 2,
      description: 'Synthetic conductivity.',
      opaque: false,
      applicableUnits: ['S.m-1'],
    },
    solverRequirements: [],
  })
  catalog.listQuantityKinds.mockResolvedValue({ items: [quantityKind], nextCursor: null, total: 1 })
  catalog.getQuantityKind.mockResolvedValue({ ...quantityKind, materialParameters: [], solverUsages: [] })
  catalog.listSolvers.mockResolvedValue({
    items: [{
      name: solver.name,
      version: solver.version,
      description: solver.descriptor.description,
      contractDigest: solver.contractDigest,
    }],
    nextCursor: null,
    total: 1,
  })
  catalog.getSolver.mockResolvedValue({
    ...solver,
    description: solver.descriptor.description,
    materialRequirements: [],
    quantityKindUsages: [],
    producesArtifacts: [],
    consumesArtifacts: [],
  })
})

function renderDocs(entry = '/docs') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route element={<DocsPage />} path="/docs" />
          <Route element={<div>CAE Workbench</div>} path="/" />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('integrated documentation page', () => {
  it('uses Experiment Authoring by default and normalizes an unknown section', () => {
    renderDocs('/docs?section=unknown')

    expect(screen.getByRole('heading', { name: 'Experiment Authoring' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Experiment Program의 파일과 책임' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Experiment Authoring' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('searchbox', { name: '문서 전체 검색' })).toBeInTheDocument()
  })

  it.each([
    ['program', 'Experiment Authoring', 'Experiment Program의 파일과 책임'],
    ['reference', 'API / CAD Reference', '공개 Source와 import 경계'],
    ['troubleshooting', 'Troubleshooting', '문서가 Ready가 되지 않을 때'],
  ])('opens the %s Manual deep link', (section, navigationLabel, articleTitle) => {
    renderDocs(`/docs?section=${section}`)

    expect(screen.getByRole('button', { name: navigationLabel })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: articleTitle })).toBeInTheDocument()
  })

  it('opens direct section and catalog item links', () => {
    renderDocs('/docs?section=geometry&item=box')

    expect(screen.getByRole('button', { name: 'Geometry Catalog' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'Primitives & Operations' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '<box />' })).toBeInTheDocument()
  })

  it('navigates between Manual sections from the sidebar', async () => {
    const user = userEvent.setup()
    renderDocs()

    await user.click(screen.getByRole('button', { name: 'API / CAD Reference' }))

    expect(screen.getByRole('heading', { name: 'API / CAD Reference' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'API / CAD Reference' })).toHaveAttribute('aria-current', 'page')
  })

  it('uses the mobile navigation sheet to open a catalog section', async () => {
    const user = userEvent.setup()
    renderDocs()

    await user.click(screen.getByRole('button', { name: '문서 메뉴 열기' }))
    const navigation = screen.getByRole('dialog', { name: 'Caemble Documentation' })
    await user.click(within(navigation).getByRole('button', { name: 'Material Catalog' }))

    expect(screen.queryByRole('dialog', { name: 'Caemble Documentation' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Material Parameters' })).toBeInTheDocument()
  })

  it('searches Manual headings and opens their anchored content', async () => {
    const user = userEvent.setup()
    renderDocs()

    await user.type(screen.getByRole('searchbox', { name: '문서 전체 검색' }), 'invalid_unit')
    await user.click(
      await screen.findByRole('button', { name: 'Troubleshooting: unit, QuantityKind 또는 Material 오류' }),
    )

    expect(screen.getByRole('heading', { name: 'unit, QuantityKind 또는 Material 오류' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: '문서 전체 검색' })).toHaveValue('')
  })

  it.each([
    ['curvedEdgeCylinder', 'Geometry Catalog: curvedEdgeCylinder', 'Primitives & Operations', '<curvedEdgeCylinder />'],
    [
      'electrical.conductivity',
      'Material Catalog: electrical.conductivity',
      'Material Parameters',
      'electrical.conductivity',
    ],
    [
      'electromagnetism.ElectricCurrent',
      'Quantity Catalog: electromagnetism.ElectricCurrent',
      'Physical Quantity Kinds',
      'electromagnetism.ElectricCurrent',
    ],
    [
      'dc-current-density@0.1.0',
      'Physics Catalog: dc-current-density@0.1.0',
      'Simulations & Analysis',
      'dc-current-density',
    ],
  ])(
    'searches the full catalog index for %s and opens its detail',
    async (query, resultName, pageTitle, detailTitle) => {
      const user = userEvent.setup()
      renderDocs()

      await user.type(screen.getByRole('searchbox', { name: '문서 전체 검색' }), query)
      await user.click(await screen.findByRole('button', { name: resultName }))

      expect(screen.getByRole('heading', { name: pageTitle })).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: detailTitle })).toBeInTheDocument()
    },
  )
})
