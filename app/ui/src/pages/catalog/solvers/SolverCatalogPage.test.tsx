// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PhysicsCatalog } from './SolverCatalogPage'

const catalog = vi.hoisted(() => ({ getSolver: vi.fn(), listSolvers: vi.fn() }))

vi.mock('@/api/catalog', async (importActual) => {
  const actual = await importActual<typeof import('@/api/catalog')>()
  return { ...actual, catalogApi: { ...actual.catalogApi, ...catalog } }
})

const solvers = [
  {
    name: 'alpha',
    version: '1.0.0',
    description: 'Alpha solver',
    contractDigest: 'a'.repeat(64),
  },
]

function Harness({ children, client }: { children: ReactNode; client: QueryClient }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('Solver Catalog API', () => {
  beforeEach(() => {
    catalog.listSolvers.mockReset()
    catalog.getSolver.mockReset()
  })

  it('caches a typed API list without loading raw manifests', async () => {
    catalog.listSolvers.mockResolvedValue({ items: solvers, nextCursor: null, total: 1 })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const first = render(
      <Harness client={client}>
        <PhysicsCatalog />
      </Harness>,
    )
    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(catalog.listSolvers).toHaveBeenCalledOnce()

    first.unmount()
    render(
      <Harness client={client}>
        <PhysicsCatalog />
      </Harness>,
    )
    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(catalog.listSolvers).toHaveBeenCalledOnce()
  })

  it('separates empty and unavailable API states', async () => {
    catalog.listSolvers.mockResolvedValueOnce({ items: [], nextCursor: null, total: 0 })
    const empty = render(
      <Harness client={new QueryClient()}>
        <PhysicsCatalog />
      </Harness>,
    )
    expect(await screen.findByText('등록된 활성 Solver가 없습니다.')).toBeInTheDocument()
    empty.unmount()

    catalog.listSolvers.mockRejectedValueOnce(new Error('catalog unavailable'))
    const unavailable = render(
      <Harness client={new QueryClient()}>
        <PhysicsCatalog />
      </Harness>,
    )
    expect(await screen.findByText('Catalog API를 사용할 수 없습니다.')).toBeInTheDocument()
    unavailable.unmount()
  })
})
