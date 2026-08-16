// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  catalogApi,
  type CatalogMaterialModel,
  type CatalogMaterialParameter,
  type CatalogMaterialParameterDetail,
} from '@/api/catalog'
import { MaterialCatalog } from './MaterialCatalogPage'

vi.mock('@/api/catalog', async (importActual) => {
  const actual = await importActual<typeof import('@/api/catalog')>()
  return {
    ...actual,
    catalogApi: {
      ...actual.catalogApi,
      getMaterialModel: vi.fn(),
      getMaterialParameter: vi.fn(),
      listMaterialModels: vi.fn(),
      listMaterialParameters: vi.fn(),
    },
  }
})

const parameter: CatalogMaterialParameter = {
  key: 'synthetic.elasticity',
  domain: 'synthetic',
  labelKo: '합성 탄성값',
  quantityKind: 'synthetic.ScalarStiffness',
  specialQualifiers: ['synthetic.ambient'],
}

const parameterDetail: CatalogMaterialParameterDetail = {
  ...parameter,
  quantityKindDefinition: {
    name: parameter.quantityKind,
    domain: 'synthetic',
    tensorOrder: 0,
    description: 'Synthetic scalar quantity for UI tests.',
    opaque: false,
    applicableUnits: ['widget'],
  },
  solverRequirements: [
    {
      solverName: 'synthetic-material-solver',
      solverVersion: '3.2.1',
      role: 'body',
      methodCategory: 'initializations',
      methodId: 'seed',
      description: 'Uses the synthetic property.',
    },
  ],
}

const model: CatalogMaterialModel = {
  key: 'model.synthetic_curve',
  labelKo: '합성 곡선 모델',
  kind: 'sampled_relation',
  input: { name: 'stimulus', quantityKind: 'synthetic.Stimulus' },
  output: { name: 'response', quantityKind: 'synthetic.Response' },
  minimumSamples: 3,
  sharedBasis: true,
}

function Harness({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

function renderCatalog() {
  return render(
    <Harness>
      <MaterialCatalog />
    </Harness>,
  )
}

describe('API-backed Material catalog', () => {
  beforeEach(() => {
    vi.mocked(catalogApi.getMaterialModel).mockReset()
    vi.mocked(catalogApi.getMaterialParameter).mockReset()
    vi.mocked(catalogApi.listMaterialModels).mockReset()
    vi.mocked(catalogApi.listMaterialParameters).mockReset()
  })

  afterEach(cleanup)

  it('shows loading, then opens a parameter with Quantity Kind and Solver cross-links', async () => {
    let resolveParameters!: (value: { items: CatalogMaterialParameter[]; nextCursor: null; total: number }) => void
    vi.mocked(catalogApi.listMaterialParameters).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveParameters = resolve
      }),
    )
    vi.mocked(catalogApi.listMaterialModels).mockResolvedValue({ items: [model], nextCursor: null, total: 1 })
    vi.mocked(catalogApi.getMaterialParameter).mockResolvedValue(parameterDetail)

    const user = userEvent.setup()
    renderCatalog()

    expect(screen.getByText('Material 카탈로그를 조회하고 있습니다.')).toBeInTheDocument()
    resolveParameters({ items: [parameter], nextCursor: null, total: 1 })
    await user.click(await screen.findByText(parameter.key))

    expect(await screen.findByRole('heading', { name: parameter.key })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: parameter.quantityKind })).toHaveAttribute(
      'href',
      '/docs?section=quantity-kinds&item=synthetic.ScalarStiffness',
    )
    expect(screen.getByRole('link', { name: /synthetic-material-solver@3\.2\.1/ })).toHaveAttribute(
      'href',
      '/docs?section=solvers&item=synthetic-material-solver%403.2.1',
    )
    expect(screen.getByText('body · initializations.seed')).toBeInTheDocument()
  })

  it('opens a sampled model and links both sides of its relation to Quantity Kinds', async () => {
    vi.mocked(catalogApi.listMaterialParameters).mockResolvedValue({ items: [], nextCursor: null, total: 0 })
    vi.mocked(catalogApi.listMaterialModels).mockResolvedValue({ items: [model], nextCursor: null, total: 1 })
    vi.mocked(catalogApi.getMaterialModel).mockResolvedValue(model)

    const user = userEvent.setup()
    renderCatalog()
    await user.click(await screen.findByText(model.key))

    expect(await screen.findByRole('heading', { name: model.key })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: model.input.quantityKind })).toHaveAttribute(
      'href',
      '/docs?section=quantity-kinds&item=synthetic.Stimulus',
    )
    expect(screen.getByRole('link', { name: model.output.quantityKind })).toHaveAttribute(
      'href',
      '/docs?section=quantity-kinds&item=synthetic.Response',
    )
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('Yes')).toBeInTheDocument()
  })

  it('shows empty and list API failure states separately', async () => {
    vi.mocked(catalogApi.listMaterialParameters).mockResolvedValueOnce({ items: [], nextCursor: null, total: 0 })
    vi.mocked(catalogApi.listMaterialModels).mockResolvedValueOnce({ items: [], nextCursor: null, total: 0 })

    const empty = renderCatalog()
    expect(await screen.findByText('조건에 맞는 항목이 없습니다.')).toBeInTheDocument()
    expect(screen.getByText('Material 항목을 선택하세요')).toBeInTheDocument()
    empty.unmount()

    vi.mocked(catalogApi.listMaterialParameters).mockRejectedValueOnce(new Error('synthetic material outage'))
    vi.mocked(catalogApi.listMaterialModels).mockResolvedValueOnce({ items: [], nextCursor: null, total: 0 })
    renderCatalog()

    expect(await screen.findByText('Catalog API를 사용할 수 없습니다.')).toBeInTheDocument()
    expect(screen.getByText('synthetic material outage')).toBeInTheDocument()
  })

  it('sends parameter filters and appends the next cursor page', async () => {
    const secondParameter: CatalogMaterialParameter = {
      ...parameter,
      key: 'synthetic.elasticity.second',
      labelKo: '합성 두 번째 탄성값',
    }
    vi.mocked(catalogApi.listMaterialParameters).mockImplementation(async (query = {}) =>
      query.cursor
        ? { items: [secondParameter], nextCursor: null, total: 2 }
        : { items: [parameter], nextCursor: 'material-cursor-two', total: 2 },
    )
    vi.mocked(catalogApi.listMaterialModels).mockResolvedValue({ items: [], nextCursor: null, total: 0 })

    const user = userEvent.setup()
    renderCatalog()
    expect(await screen.findByText(parameter.key)).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: 'Material 검색' }), 'elasticity')
    await user.type(screen.getByRole('textbox', { name: 'Quantity Kind 필터' }), 'ScalarStiffness')
    await user.type(screen.getByRole('textbox', { name: 'Material domain' }), 'synthetic')

    await waitFor(() => {
      expect(catalogApi.listMaterialParameters).toHaveBeenCalledWith(
        expect.objectContaining({
          q: 'elasticity',
          quantityKind: 'ScalarStiffness',
          domain: 'synthetic',
          limit: 100,
        }),
      )
    })
    expect(catalogApi.listMaterialModels).toHaveBeenCalledWith({ q: 'elasticity', limit: 100 })

    await user.click(screen.getByRole('button', { name: '더 불러오기' }))

    expect(await screen.findByText(secondParameter.key)).toBeInTheDocument()
    expect(catalogApi.listMaterialParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'elasticity',
        quantityKind: 'ScalarStiffness',
        domain: 'synthetic',
        cursor: 'material-cursor-two',
      }),
    )
  })
})
