// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSyntheticSolver } from '@/test/syntheticCatalog'
import { DocsPage } from './DocsPage'

const catalog = vi.hoisted(() => ({
  getExperiment: vi.fn(),
  getMaterialModel: vi.fn(),
  getMaterialParameter: vi.fn(),
  getQuantityKind: vi.fn(),
  getSolver: vi.fn(),
  listExperiments: vi.fn(),
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
      'electrical.conductivity': [
        {
          kind: 'materialParameter',
          key: query,
          title: query,
          subtitle: 'Synthetic Material parameter.',
        },
      ],
      'electromagnetism.ElectricCurrent': [
        {
          kind: 'quantityKind',
          key: query,
          title: query,
          subtitle: 'Synthetic Quantity Kind.',
        },
      ],
      'dc-current-density@0.1.0': [
        {
          kind: 'solver',
          key: query,
          title: query,
          subtitle: 'Synthetic Solver.',
        },
      ],
      'dc-uniform-bar': [
        {
          kind: 'experiment',
          key: 'caemble:experiment/official/examples/dc-uniform-bar@1.0.0',
          title: 'DC Uniform Bar',
          subtitle: 'Official Experiment.',
        },
      ],
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
  const experiment = {
    key: 'dc-uniform-bar',
    namespace: 'official',
    repository: 'examples',
    version: '1.0.0',
    coordinate: 'caemble:experiment/official/examples/dc-uniform-bar@1.0.0',
    title: 'DC Uniform Bar',
    description: 'Official Experiment.',
    cadApiVersion: 8,
    sourceFormatVersion: 2,
    bundleFormatVersion: 6,
    bundleHash: 'c'.repeat(64),
    concepts: ['DC'],
    relatedSolvers: [{ name: 'dc-current-density', version: '0.1.0', description: 'Synthetic Solver.' }],
  }

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
    items: [
      {
        name: solver.name,
        version: solver.version,
        description: solver.descriptor.description,
        contractDigest: solver.contractDigest,
      },
    ],
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
  catalog.listExperiments.mockResolvedValue({ items: [experiment], nextCursor: null, total: 1 })
  catalog.getExperiment.mockResolvedValue({
    ...experiment,
    sourceBundle: {
      formatVersion: 6,
      files: {
        'experiment.tsx': 'export default 1',
        'geometry.tsx': 'export const Bar = () => <box />',
        'material.tsx': 'export {}',
        'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
        'tasks/solveField.tsx': 'export default 1',
      },
    },
    verification: { kernelTasks: ['solveField'], recordedData: ['current'], expectations: ['Current is finite.'] },
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

  it('opens a Manual section and preserves a legacy anchored deep link', () => {
    renderDocs('/docs?section=reference#cad-reference-v7-migration')

    expect(screen.getByRole('button', { name: 'API / CAD Reference' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'Transform: direct props와 operation wrapper' })).toBeInTheDocument()
    expect(document.getElementById('cad-reference-v7-migration')).toBeInTheDocument()
  })

  it('opens direct section and catalog item links', () => {
    renderDocs('/docs?section=geometry&item=box')

    expect(screen.getByRole('button', { name: 'Geometry Catalog' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'Primitives & Operations' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '<Box />' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Properties' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Surfaces' })).toBeInTheDocument()
    expect(screen.getByText('Origin')).toBeInTheDocument()
    expect(screen.getByText('Children')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '예제 복사' })).toBeInTheDocument()
  })

  it('opens an official Experiment deep link and follows its Solver relation', async () => {
    renderDocs('/docs?section=solvers&item=experiment:dc-uniform-bar')

    expect(await screen.findByRole('heading', { name: 'DC Uniform Bar' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Official Experiments' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'dc-current-density@0.1.0' }))
    expect(await screen.findByRole('heading', { name: 'dc-current-density' })).toBeInTheDocument()
  })

  it('opens a canonical coordinate deep link without falling back to a bare key', async () => {
    renderDocs(
      '/docs?section=solvers&item=experiment:caemble:experiment/official/examples/dc-uniform-bar@1.0.0',
    )

    expect(await screen.findByRole('heading', { name: 'DC Uniform Bar' })).toBeInTheDocument()
    expect(catalog.getExperiment).toHaveBeenCalledWith(
      'caemble:experiment/official/examples/dc-uniform-bar@1.0.0',
    )
  })

  it('leaves an ambiguous legacy key for the API to reject instead of selecting one coordinate', async () => {
    const listed = await catalog.listExperiments()
    const first = listed.items[0]
    catalog.listExperiments.mockResolvedValue({
      items: [
        first,
        {
          ...first,
          namespace: 'forked',
          repository: 'examples',
          coordinate: 'caemble:experiment/forked/examples/dc-uniform-bar@1.0.0',
        },
      ],
      nextCursor: null,
      total: 2,
    })
    catalog.getExperiment.mockRejectedValue(new Error('Ambiguous Experiment key'))

    renderDocs('/docs?section=solvers&item=experiment:dc-uniform-bar')

    await waitFor(() => expect(catalog.getExperiment).toHaveBeenCalled())
    expect(catalog.getExperiment.mock.calls.every(([selector]) => selector === 'dc-uniform-bar')).toBe(true)
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

  it('searches the live catalog index and opens a solver detail', async () => {
    const user = userEvent.setup()
    renderDocs()

    await user.type(screen.getByRole('searchbox', { name: '문서 전체 검색' }), 'dc-current-density@0.1.0')
    await user.click(await screen.findByRole('button', { name: 'Physics Catalog: dc-current-density@0.1.0' }))

    expect(screen.getByRole('heading', { name: 'Simulations & Analysis' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'dc-current-density' })).toBeInTheDocument()
  })
})
