import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { loadWorkbenchDraft, saveWorkbenchDraft } from '@/features/cae-workbench/storage/draftStorage'
import { defaultWorkbenchLayoutState, type WorkbenchDraft } from '@/features/cae-workbench/types'
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
  selection: { experimentId: null, measurementId: null, calculationId: null },
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

function savedDraft(
  experimentId: number,
  measurementId: number | null = null,
  calculationId: number | null = null,
  activeSection: WorkbenchDraft['layout']['activeSection'] = 'measurement',
): WorkbenchDraft {
  const record = savedExperiment(experimentId)
  return {
    ...localDraft,
    experiment: {
      record,
      baselineBundle: record.source_bundle,
      document: { kind: 'experiment', sourceBundle: record.source_bundle },
      name: record.name,
      description: '',
    },
    selection: { experimentId, measurementId, calculationId },
    layout: { ...defaultWorkbenchLayoutState, activeSection },
  }
}

function createWorkbench() {
  const state = {
    calculationDataActions: { busy: false, cancel: vi.fn() },
    draft: vi.fn(() => localDraft),
    experimentId: null as number | null,
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
    selectionContext: { experimentId: null, measurementId: null, calculationId: null } as
      | WorkbenchDraft['selection']
      | { experimentId: number; measurementId: number | null; calculationId: number | null },
    selectionRestoring: false,
    selectCalculation: vi.fn(),
  }
  state.restoreDraft.mockImplementation((draft: WorkbenchDraft) => {
    state.experimentId = draft.selection.experimentId
    state.selectionContext = draft.selection
  })
  state.loadExperiment.mockImplementation(async (experiment: ReturnType<typeof savedExperiment> | number) => {
    const row = typeof experiment === 'number' ? savedExperiment(experiment) : experiment
    state.experimentId = row.id
    state.selectionContext = { experimentId: row.id, measurementId: null, calculationId: null }
    return row
  })
  return state as unknown as CaeWorkbenchState
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
    const [, forceRender] = useState(0)
    const session = useCaePageSession(workbench, { authPending: false, queryScope: 'user:first' })
    return (
      <div>
        <div data-testid="session-state">
          {String(session.initialized)}|{session.layout.activeSection}
        </div>
        <button
          data-testid="calculation-tab"
          onClick={() => session.setLayout((current) => ({ ...current, activeSection: 'measurement' }))}
        />
        <button
          data-testid="experiment-tab"
          onClick={() => session.setLayout((current) => ({ ...current, activeSection: 'experiment' }))}
        />
        <button
          data-testid="experiment-8"
          onClick={() => {
            const mutable = workbench as unknown as {
              experimentId: number
              selectionContext: WorkbenchDraft['selection']
            }
            mutable.experimentId = 8
            mutable.selectionContext = { experimentId: 8, measurementId: null, calculationId: null }
            forceRender((current) => current + 1)
          }}
        />
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
  it('keeps a meaningful local draft and canonicalizes the URL when the user declines a conflict', async () => {
    vi.mocked(loadWorkbenchDraft).mockResolvedValue(localDraft)
    vi.mocked(window.confirm).mockReturnValue(false)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const fetchQuery = vi.spyOn(client, 'fetchQuery')
    const workbench = createWorkbench()
    const { router } = renderSession({
      client,
      initialUrl: '/?keep=yes&experiment=7&section=measurement&calculation=9',
      workbench,
    })

    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('true|prediction'))
    await waitFor(() => expect(router.state.location.search).toBe('?keep=yes'))
    expect(workbench.restoreDraft).toHaveBeenLastCalledWith(localDraft)
    expect(workbench.loadExperiment).not.toHaveBeenCalled()
    expect(fetchQuery).not.toHaveBeenCalled()
  })

  it('opens a confirmed URL Experiment in Prediction with empty children', async () => {
    vi.mocked(loadWorkbenchDraft).mockResolvedValue(localDraft)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const row = savedExperiment(7)
    vi.spyOn(client, 'fetchQuery').mockResolvedValue(row as never)
    const workbench = createWorkbench()
    const { router } = renderSession({
      client,
      initialUrl: '/?keep=yes&experiment=7&section=experiment&measurement=4&calculation=9',
      workbench,
    })

    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('true|prediction'))
    await waitFor(() => expect(router.state.location.search).toBe('?keep=yes&experiment=7'))
    expect(workbench.loadExperiment).toHaveBeenCalledWith(row)
    expect(workbench.selectionContext).toEqual({ experimentId: 7, measurementId: null, calculationId: null })
    expect(workbench.restoreDraft).not.toHaveBeenLastCalledWith(localDraft)
  })

  it('does not roll a Calculation tab transition back when an old composite URL commits later', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(client, 'fetchQuery').mockResolvedValue(savedExperiment(7) as never)
    const workbench = createWorkbench()
    const { router } = renderSession({ client, initialUrl: '/?experiment=7', workbench })
    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('true|prediction'))

    fireEvent.click(screen.getByTestId('experiment-tab'))
    fireEvent.click(screen.getByTestId('calculation-tab'))
    expect(screen.getByTestId('session-state')).toHaveTextContent('true|measurement')

    await act(async () => router.navigate('/?experiment=7&section=experiment&measurement=4&calculation=9'))
    await waitFor(() => expect(router.state.location.search).toBe('?experiment=7'))
    expect(screen.getByTestId('session-state')).toHaveTextContent('true|measurement')
    expect(workbench.loadExperiment).toHaveBeenCalledTimes(1)
  })

  it('mirrors only a newly confirmed Experiment to the URL', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(client, 'fetchQuery').mockResolvedValue(savedExperiment(7) as never)
    const workbench = createWorkbench()
    const { router } = renderSession({ client, initialUrl: '/?keep=yes&experiment=7', workbench })
    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('true|prediction'))

    fireEvent.click(screen.getByTestId('experiment-8'))
    await waitFor(() => expect(router.state.location.search).toBe('?keep=yes&experiment=8'))
    expect(workbench.selectionContext).toEqual({ experimentId: 8, measurementId: null, calculationId: null })
  })

  it('restores a saved tab and validates both child selections in parallel', async () => {
    const draft = savedDraft(7, 41, 9)
    vi.mocked(loadWorkbenchDraft).mockResolvedValue(draft)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let resolveMeasurement!: (value: { id: number; experiment_id: number }) => void
    let resolveCalculation!: (value: { id: number; experiment_id: number }) => void
    const fetchQuery = vi.spyOn(client, 'fetchQuery').mockImplementation((options) => {
      const queryKey = options.queryKey as readonly unknown[]
      return new Promise((resolve) => {
        if (queryKey.includes('measurements')) resolveMeasurement = resolve
        else if (queryKey.includes('calculations')) resolveCalculation = resolve
        else throw new Error(`Unexpected query: ${String(queryKey)}`)
      }) as never
    })
    const workbench = createWorkbench()
    const { router } = renderSession({ client, initialUrl: '/', workbench })

    await waitFor(() => expect(fetchQuery).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('session-state')).toHaveTextContent('false|prediction')
    await act(async () => {
      resolveMeasurement({ id: 41, experiment_id: 7 })
      resolveCalculation({ id: 9, experiment_id: 7 })
    })

    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('true|measurement'))
    expect(workbench.restoreDraft).toHaveBeenLastCalledWith(draft)
    await waitFor(() => expect(router.state.location.search).toBe('?experiment=7'))
  })

  it('partially restores a draft while clearing deleted or foreign child selections', async () => {
    const draft = savedDraft(7, 41, 9, 'analysis')
    vi.mocked(loadWorkbenchDraft).mockResolvedValue(draft)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(client, 'fetchQuery').mockImplementation((options) => {
      const queryKey = options.queryKey as readonly unknown[]
      if (queryKey.includes('measurements')) return Promise.resolve({ id: 41, experiment_id: 8 }) as never
      return Promise.reject(new Error('Calculation was deleted')) as never
    })
    const workbench = createWorkbench()
    renderSession({ client, initialUrl: '/', workbench })

    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('true|analysis'))
    const restored = vi.mocked(workbench.restoreDraft).mock.lastCall?.[0]
    expect(restored?.experiment).toEqual(draft.experiment)
    expect(restored?.selection).toEqual({ experimentId: 7, measurementId: null, calculationId: null })
  })

  it('falls back to the local draft and rewrites an inaccessible URL Experiment', async () => {
    const draft = savedDraft(8, null, null, 'analysis')
    vi.mocked(loadWorkbenchDraft).mockResolvedValue(draft)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.spyOn(client, 'fetchQuery').mockRejectedValue(new Error('Experiment #7을 찾을 수 없습니다.'))
    const workbench = createWorkbench()
    const { router } = renderSession({
      client,
      initialUrl: '/?experiment=7&section=measurement',
      workbench,
    })

    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('true|analysis'))
    expect(workbench.restoreDraft).toHaveBeenLastCalledWith(draft)
    await waitFor(() => expect(router.state.location.search).toBe('?experiment=8'))
  })
})
