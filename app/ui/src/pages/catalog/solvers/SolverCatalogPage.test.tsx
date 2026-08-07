// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaeManifestError, fetchCaeSolverManifests } from '@/features/cae/manifests'
import { useAuth } from '@/features/auth/use-auth'
import { SolverCatalogPage } from './SolverCatalogPage'

vi.mock('@/features/auth/use-auth', () => ({ useAuth: vi.fn() }))
vi.mock('@/features/cae/manifests', async (importActual) => {
  const actual = await importActual<typeof import('@/features/cae/manifests')>()
  return { ...actual, fetchCaeSolverManifests: vi.fn() }
})

const user = {
  id: 'user-1',
  is_active: true,
  roles: ['user'],
  gpstation_connection: {
    api_base_url: 'https://gps.example.test',
    access_token: 'gpsk_test',
  },
}
const manifests = [
  {
    schemaVersion: 1 as const,
    implementation: 'app.solvers.alpha.solver:run',
    descriptor: {
      name: 'alpha',
      version: '1.0.0',
      description: 'Alpha solver',
      referenceLengthUnit: 'm',
      parameters: {},
      materials: [],
      inputPorts: {},
      observations: {},
      methods: { initializations: [], boundaryConditions: [], outputs: [] },
    },
  },
]

function Harness({ children, client }: { children: ReactNode; client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/catalog/solvers']}>
        <Routes>
          <Route element={children} path="/catalog/solvers" />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('live Solver Catalog', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReset()
    vi.mocked(fetchCaeSolverManifests).mockReset()
    vi.mocked(useAuth).mockReturnValue({ user } as ReturnType<typeof useAuth>)
  })

  it('caches once per connection and only reloads through the refresh button', async () => {
    vi.mocked(fetchCaeSolverManifests).mockResolvedValue(manifests)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = render(
      <Harness client={client}>
        <SolverCatalogPage />
      </Harness>,
    )
    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(fetchCaeSolverManifests).toHaveBeenCalledOnce()

    first.unmount()
    render(
      <Harness client={client}>
        <SolverCatalogPage />
      </Harness>,
    )
    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(fetchCaeSolverManifests).toHaveBeenCalledOnce()

    await userEvent.click(screen.getByRole('button', { name: '새로고침' }))
    await waitFor(() => expect(fetchCaeSolverManifests).toHaveBeenCalledTimes(2))
  })

  it('separates missing connection, empty, transport, and invalid manifest states', async () => {
    const disconnectedClient = new QueryClient()
    vi.mocked(useAuth).mockReturnValue({ user: { ...user, gpstation_connection: null } } as ReturnType<typeof useAuth>)
    const disconnected = render(
      <Harness client={disconnectedClient}>
        <SolverCatalogPage />
      </Harness>,
    )
    expect(screen.getByText('GPStation 연결이 없습니다.')).toBeInTheDocument()
    disconnected.unmount()

    vi.mocked(useAuth).mockReturnValue({ user } as ReturnType<typeof useAuth>)
    vi.mocked(fetchCaeSolverManifests).mockResolvedValueOnce([])
    const empty = render(
      <Harness client={new QueryClient()}>
        <SolverCatalogPage />
      </Harness>,
    )
    expect(await screen.findByText('등록된 solver가 없습니다.')).toBeInTheDocument()
    empty.unmount()

    vi.mocked(fetchCaeSolverManifests).mockRejectedValueOnce(new Error('worker unavailable'))
    const unavailable = render(
      <Harness client={new QueryClient()}>
        <SolverCatalogPage />
      </Harness>,
    )
    expect(await screen.findByText('CAE launcher 또는 worker에 연결할 수 없습니다.')).toBeInTheDocument()
    unavailable.unmount()

    vi.mocked(fetchCaeSolverManifests).mockRejectedValueOnce(new CaeManifestError('invalid_manifest', 'bad descriptor'))
    const invalid = render(
      <Harness client={new QueryClient()}>
        <SolverCatalogPage />
      </Harness>,
    )
    expect(await screen.findByText('잘못된 solver manifest입니다.')).toBeInTheDocument()
    invalid.unmount()

    vi.mocked(fetchCaeSolverManifests).mockRejectedValueOnce(new CaeManifestError('protocol_error', 'bad attachment'))
    render(
      <Harness client={new QueryClient()}>
        <SolverCatalogPage />
      </Harness>,
    )
    expect(await screen.findByText('잘못된 manifest attachment 응답입니다.')).toBeInTheDocument()
  })
})
