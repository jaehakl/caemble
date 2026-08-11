// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaeManifestError, fetchCaeSolverManifests } from '@/features/cae/manifests'
import { PhysicsCatalog } from './SolverCatalogPage'

vi.mock('@/features/cae/manifests', async (importActual) => {
  const actual = await importActual<typeof import('@/features/cae/manifests')>()
  return { ...actual, fetchCaeSolverManifests: vi.fn() }
})

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
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('bundled Solver Catalog', () => {
  beforeEach(() => {
    vi.mocked(fetchCaeSolverManifests).mockReset()
  })

  it('caches the build-time manifest list', async () => {
    vi.mocked(fetchCaeSolverManifests).mockResolvedValue(manifests)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = render(
      <Harness client={client}>
        <PhysicsCatalog />
      </Harness>,
    )
    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(fetchCaeSolverManifests).toHaveBeenCalledOnce()

    first.unmount()
    render(
      <Harness client={client}>
        <PhysicsCatalog />
      </Harness>,
    )
    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(fetchCaeSolverManifests).toHaveBeenCalledOnce()
  })

  it('separates empty, load error, and invalid manifest states', async () => {
    vi.mocked(fetchCaeSolverManifests).mockResolvedValueOnce([])
    const empty = render(
      <Harness client={new QueryClient()}>
        <PhysicsCatalog />
      </Harness>,
    )
    expect(await screen.findByText('등록된 solver가 없습니다.')).toBeInTheDocument()
    empty.unmount()

    vi.mocked(fetchCaeSolverManifests).mockRejectedValueOnce(new Error('worker unavailable'))
    const unavailable = render(
      <Harness client={new QueryClient()}>
        <PhysicsCatalog />
      </Harness>,
    )
    expect(await screen.findByText('Solver manifest를 읽을 수 없습니다.')).toBeInTheDocument()
    unavailable.unmount()

    vi.mocked(fetchCaeSolverManifests).mockRejectedValueOnce(new CaeManifestError('invalid_manifest', 'bad descriptor'))
    const invalid = render(
      <Harness client={new QueryClient()}>
        <PhysicsCatalog />
      </Harness>,
    )
    expect(await screen.findByText('잘못된 solver manifest입니다.')).toBeInTheDocument()
    invalid.unmount()
  })
})
