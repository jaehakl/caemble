// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogApi, type CatalogQuantityKind, type CatalogQuantityKindDetail } from '@/api/catalog'
import { QuantityCatalog } from './QuantityKindCatalogPage'

vi.mock('@/api/catalog', async (importActual) => {
  const actual = await importActual<typeof import('@/api/catalog')>()
  return {
    ...actual,
    catalogApi: {
      ...actual.catalogApi,
      getQuantityKind: vi.fn(),
      listQuantityKinds: vi.fn(),
    },
  }
})

const quantity: CatalogQuantityKind = {
  name: 'synthetic.VectorFlux',
  domain: 'synthetic',
  tensorOrder: 1,
  description: 'Synthetic vector quantity for UI tests.',
  opaque: false,
  applicableUnits: ['widget/s', 'gadget/s'],
}

const quantityDetail: CatalogQuantityKindDetail = {
  ...quantity,
  materialParameters: [{ key: 'synthetic.transport', labelKo: '합성 전달 계수' }],
  solverUsages: [
    {
      solverName: 'synthetic-solver',
      solverVersion: '9.9.9',
      context: 'method_parameter',
      path: 'methods.outputs.synthetic.value',
      unit: 'widget/s',
    },
  ],
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
      <QuantityCatalog />
    </Harness>,
  )
}

describe('API-backed Quantity Kind catalog', () => {
  beforeEach(() => {
    vi.mocked(catalogApi.getQuantityKind).mockReset()
    vi.mocked(catalogApi.listQuantityKinds).mockReset()
  })

  afterEach(cleanup)

  it('shows loading, then opens relational Material and Solver links from a selected detail', async () => {
    let resolveList!: (value: { items: CatalogQuantityKind[]; nextCursor: null; total: number }) => void
    vi.mocked(catalogApi.listQuantityKinds).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve
      }),
    )
    vi.mocked(catalogApi.getQuantityKind).mockResolvedValue(quantityDetail)

    const user = userEvent.setup()
    renderCatalog()

    expect(screen.getByText('Quantity Kind를 조회하고 있습니다.')).toBeInTheDocument()
    resolveList({ items: [quantity], nextCursor: null, total: 1 })

    await user.click(await screen.findByText(quantity.name))

    expect(await screen.findByRole('heading', { name: quantity.name })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /synthetic\.transport/ })).toHaveAttribute(
      'href',
      '/docs?section=materials&item=synthetic.transport',
    )
    expect(screen.getByRole('link', { name: /synthetic-solver@9\.9\.9/ })).toHaveAttribute(
      'href',
      '/docs?section=solvers&item=synthetic-solver%409.9.9',
    )
    expect(screen.getByText('method_parameter · methods.outputs.synthetic.value · widget/s')).toBeInTheDocument()
  })

  it('distinguishes an empty result from the initial empty detail', async () => {
    vi.mocked(catalogApi.listQuantityKinds).mockResolvedValue({ items: [], nextCursor: null, total: 0 })

    renderCatalog()

    expect(await screen.findByText('조건에 맞는 항목이 없습니다.')).toBeInTheDocument()
    expect(screen.getByText('Quantity Kind를 선택하세요')).toBeInTheDocument()
    expect(screen.getByText('0 entries')).toBeInTheDocument()
  })

  it('recovers from a list API error when the user retries', async () => {
    vi.mocked(catalogApi.listQuantityKinds)
      .mockRejectedValueOnce(new Error('synthetic catalog outage'))
      .mockResolvedValueOnce({ items: [quantity], nextCursor: null, total: 1 })

    const user = userEvent.setup()
    renderCatalog()

    expect(await screen.findByText('Catalog API를 사용할 수 없습니다.')).toBeInTheDocument()
    expect(screen.getByText('synthetic catalog outage')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /다시 시도/ }))

    expect(await screen.findByText(quantity.name)).toBeInTheDocument()
    expect(catalogApi.listQuantityKinds).toHaveBeenCalledTimes(2)
  })

  it('sends filters to the API and appends the next cursor page', async () => {
    const secondQuantity: CatalogQuantityKind = {
      ...quantity,
      name: 'synthetic.VectorFlux.SecondPage',
    }
    vi.mocked(catalogApi.listQuantityKinds).mockImplementation(async (query = {}) =>
      query.cursor
        ? { items: [secondQuantity], nextCursor: null, total: 2 }
        : { items: [quantity], nextCursor: 'cursor-two', total: 2 },
    )

    const user = userEvent.setup()
    renderCatalog()
    expect(await screen.findByText(quantity.name)).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: 'Quantity Kind 검색' }), 'VectorFlux')
    await user.type(screen.getByRole('textbox', { name: 'Unit 검색' }), 'widget/s')
    await user.type(screen.getByRole('textbox', { name: 'Quantity Kind domain' }), 'synthetic')

    await waitFor(() => {
      expect(catalogApi.listQuantityKinds).toHaveBeenCalledWith(
        expect.objectContaining({
          q: 'VectorFlux',
          unit: 'widget/s',
          domain: 'synthetic',
          limit: 100,
        }),
      )
    })

    await user.click(screen.getByRole('button', { name: '더 불러오기' }))

    expect(await screen.findByText(secondQuantity.name)).toBeInTheDocument()
    expect(catalogApi.listQuantityKinds).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'VectorFlux',
        unit: 'widget/s',
        domain: 'synthetic',
        cursor: 'cursor-two',
      }),
    )
  })
})
