import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { defaultWorkbenchLayoutState, type WorkbenchDraft } from '@/features/cae-workbench/types'
import { loadWorkbenchDraft, saveWorkbenchDraft } from '@/features/cae-workbench/storage/draftStorage'
import { WorkbenchShellProvider } from './state/workbenchShellStore'
import { useCaePageSession } from './useCaePageSession'

vi.mock('@/features/cae-workbench/storage/draftStorage', () => ({
  loadWorkbenchDraft: vi.fn(),
  saveWorkbenchDraft: vi.fn(),
}))

const NativeRequest = globalThis.Request

const localDraft: WorkbenchDraft = {
  savedAt: 1,
  experiment: {
    baselineBundle: { files: { 'experiment.tsx': 'export default null' } },
    description: '',
    document: {
      kind: 'experiment',
      sourceBundle: { files: { 'experiment.tsx': 'export default 1' } },
    },
    name: 'Local draft',
    record: null,
  },
  candidate: { materialParameters: null, vars: null },
  layout: defaultWorkbenchLayoutState,
  selection: { measurementId: null },
}

const savedExperiment = (id: number) =>
  ({
    id,
    description: null,
    experiment_key: `experiment-${id}`,
    name: `Experiment ${id}`,
    namespace: 'first',
    repository_slug: `experiment-${id}`,
    source_bundle: { files: { 'experiment.tsx': 'export default null' } },
    source_hash: `hash-${id}`,
    user_id: 'first',
    version_major: 1,
    version_minor: 0,
    version_patch: 0,
  }) as Parameters<CaeWorkbenchState['applyExperiment']>[0]

function createWorkbench() {
  return {
    calculationDataActions: { busy: false, cancel: vi.fn() },
    draft: vi.fn(() => localDraft),
    experimentId: null,
    hasUnsavedExperimentWork: false,
    hasUnsavedWork: false,
    loadExperiment: vi.fn(),
    measurementActions: {
      busy: false,
      cancel: vi.fn(),
      error: null,
      pendingRecordMeasurementId: null,
      runSelected: vi.fn(),
    },
    restoreDraft: vi.fn(),
    saving: false,
    selection: {
      clearMeasurement: vi.fn(),
      loadMeasurement: vi.fn(),
      measurement: null,
    },
    selectionIds: { measurementId: null },
    selectionRestoring: false,
  } as unknown as CaeWorkbenchState
}

function renderSession({
  client,
  initialUrl,
  workbench,
}: {
  client: QueryClient
  initialUrl: string
  workbench: CaeWorkbenchState
}) {
  function Probe() {
    const session = useCaePageSession(workbench, { authPending: false, queryScope: 'user:first' })
    return (
      <div data-testid="session-state">
        {String(session.initialized)}|{session.layout.activeSection}|{String(session.calculationContextPending)}
      </div>
    )
  }
  const router = createMemoryRouter([{ path: '/', element: <Probe /> }], { initialEntries: [initialUrl] })
  const rendered = render(
    <QueryClientProvider client={client}>
      <WorkbenchShellProvider>
        <RouterProvider router={router} />
      </WorkbenchShellProvider>
    </QueryClientProvider>,
  )
  return { ...rendered, router }
}

beforeEach(() => {
  // React Router's Node Request and jsdom's AbortSignal use different realms in this test environment.
  vi.stubGlobal(
    'Request',
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init ? { ...init, signal: undefined } : undefined)
      }
    },
  )
  vi.mocked(loadWorkbenchDraft).mockReset().mockResolvedValue(null)
  vi.mocked(saveWorkbenchDraft).mockReset().mockResolvedValue(undefined)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useCaePageSession', () => {
  it('keeps a meaningful local draft when the user declines a conflicting URL selection', async () => {
    vi.mocked(loadWorkbenchDraft).mockResolvedValue(localDraft)
    vi.mocked(window.confirm).mockReturnValue(false)
    const client = new QueryClient()
    const fetchQuery = vi.spyOn(client, 'fetchQuery').mockResolvedValue({ id: 7 } as never)
    const workbench = createWorkbench()

    renderSession({ client, initialUrl: '/?experiment=7&section=measurement', workbench })

    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('true|measurement|false'))
    expect(workbench.restoreDraft).toHaveBeenLastCalledWith(localDraft)
    expect(workbench.loadExperiment).not.toHaveBeenCalled()
    expect(fetchQuery).not.toHaveBeenCalled()
  })

  it('opens the URL Experiment after explicit confirmation instead of restoring a conflicting draft', async () => {
    vi.mocked(loadWorkbenchDraft).mockResolvedValue(localDraft)
    const client = new QueryClient()
    const row = { id: 7, name: 'URL Experiment' }
    vi.spyOn(client, 'fetchQuery').mockResolvedValue(row as never)
    const workbench = createWorkbench()

    renderSession({ client, initialUrl: '/?experiment=7&section=experiment', workbench })

    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('true|experiment|false'))
    expect(workbench.loadExperiment).toHaveBeenCalledWith(row, null)
    expect(workbench.restoreDraft).not.toHaveBeenLastCalledWith(localDraft)
  })

  it('commits only the latest section after rapid external Experiment navigation', async () => {
    const client = new QueryClient()
    vi.spyOn(client, 'ensureQueryData').mockResolvedValue({ demos: [], mine: [] } as never)
    const workbench = createWorkbench()
    const pending = new Map<number, () => void>()
    vi.mocked(workbench.loadExperiment).mockImplementation((experiment) => {
      const experimentId = typeof experiment === 'number' ? experiment : experiment.id
      ;(workbench as unknown as { experimentId: number | null }).experimentId = experimentId
      return new Promise((resolve) => pending.set(experimentId, () => resolve(savedExperiment(experimentId))))
    })
    const { router } = renderSession({ client, initialUrl: '/?section=prediction', workbench })
    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('true|prediction|false'))

    await act(async () => router.navigate('/?experiment=7&section=experiment'))
    await waitFor(() => expect(pending.has(7)).toBe(true))
    await act(async () => router.navigate('/?experiment=8&section=analysis'))
    await waitFor(() => expect(pending.has(8)).toBe(true))

    await act(async () => pending.get(8)?.())
    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('true|analysis|false'))
    await act(async () => pending.get(7)?.())
    expect(screen.getByTestId('session-state')).toHaveTextContent('true|analysis|false')
  })
})
