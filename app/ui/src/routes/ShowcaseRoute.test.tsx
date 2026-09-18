import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, expect, it, vi } from 'vitest'
import { Component } from './ShowcaseRoute'

const mocks = vi.hoisted(() => ({
  load: vi.fn().mockResolvedValue(null),
  available: vi.fn(),
  detach: vi.fn(),
  viewer: vi.fn(),
  state: {} as Record<string, unknown>,
}))
vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ isPending: false, user: null, isAuthenticated: false, queryScope: 'public' }),
}))
vi.mock('@/features/experiment/queryOptions', () => ({
  availableExperimentsQueryOptions: () => ({ queryKey: ['showcase-route'], queryFn: mocks.available }),
}))
vi.mock('@/features/cae-workbench/state/useCaeWorkbenchState', () => ({
  useCaeWorkbenchState: () => ({
    loadExperiment: mocks.load,
    detachDeletedExperiment: mocks.detach,
    experimentId: null,
    ...mocks.state,
  }),
}))
vi.mock('@/features/cae-workbench/viewer/WorkbenchViewer', () => ({
  WorkbenchViewer: (props: unknown) => {
    mocks.viewer(props)
    return <div>Viewer</div>
  },
}))
vi.mock('@/features/experiment/ExperimentShowcase', () => ({
  ExperimentShowcase: ({
    onEdit,
    onSelect,
  }: {
    onEdit: (row: { id: number }) => void
    onSelect: (row: { id: number }) => void
  }) => (
    <>
      <button onClick={() => onEdit({ id: 12 })}>편집</button>
      <button onClick={() => onSelect({ id: 12 })}>선택</button>
    </>
  ),
}))
function Destination() {
  const location = useLocation()
  return (
    <p>
      {location.pathname}
      {location.search}
    </p>
  )
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/showcase']}>
          <Routes>
            <Route path="/showcase" element={<Component />} />
            <Route path="/workbench" element={<Destination />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  )
}
beforeEach(() => {
  mocks.state = {}
  mocks.viewer.mockClear()
  mocks.load.mockReset().mockResolvedValue(null)
  mocks.available.mockResolvedValue({ mine: [], demos: [] })
})

it('passes public Demo defaults to its Viewer without management actions', () => {
  const defaults = { version: 1, selectedResult: 'signal', settings: { 'signal:box.overlay': false }, camera: null }
  mocks.state = {
    experimentId: 4,
    experimentRecord: { isDemo: true, viewer_defaults: defaults },
    experimentDocument: { resultSessionKey: 1 },
    selection: { measurement: { id: 8 }, loading: false },
    selectionRestoring: false,
  }
  mount()
  expect(mocks.viewer).toHaveBeenCalledWith(
    expect.objectContaining({ initialDefaults: defaults, presentation: undefined, autoSelectResult: true }),
  )
})
it('opens the exact representative Demo once in StrictMode', async () => {
  const demo = { id: 4, demoDefault: true }
  mocks.available.mockResolvedValue({ mine: [], demos: [demo] })
  mount()
  await waitFor(() => expect(mocks.load).toHaveBeenCalledExactlyOnceWith(demo))
  fireEvent.click(screen.getByText('선택'))
  expect(mocks.load).toHaveBeenLastCalledWith({ id: 12 })
})
it('starts empty without a representative Demo and navigates directly to a version for editing', async () => {
  mount()
  expect(screen.getByText(/Experiment 카드를 선택하면/)).toBeInTheDocument()
  fireEvent.click(screen.getByText('편집'))
  expect(await screen.findByText('/workbench?experiment=12')).toBeInTheDocument()
  expect(mocks.load).not.toHaveBeenCalled()
})
