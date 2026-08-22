// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisProfile, AnalysisWorkerResponse } from './analysis-types'
import { AnalysisWorkspace, type AnalysisCommand, type AnalysisTab } from './AnalysisPage'

const api = vi.hoisted(() => ({ listExperiments: vi.fn() }))

vi.mock('@/api', () => ({
  dbTables: { Experiment: { listRows: api.listExperiments } },
  getListRequest: (scope = 'visible') => ({
    filter: {},
    limit: 24,
    offset: 0,
    scope,
    search_text: null,
    selected_ids: [],
    sort: ['updated_at', 'desc'],
    text_filter: {},
  }),
}))

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'user-1', roles: ['user'] },
  }),
}))

class AnalysisWorkerMock {
  static instances: AnalysisWorkerMock[] = []
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<AnalysisWorkerResponse>) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()

  constructor() {
    AnalysisWorkerMock.instances.push(this)
  }

  emit(data: AnalysisWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<AnalysisWorkerResponse>)
  }
}

const profile: AnalysisProfile = {
  fingerprint: 'profile-1',
  experimentId: 7,
  rowCount: 20,
  preparedCount: 20,
  recordedMeasurementCount: 5,
  recordedDataCount: 5,
  columns: [
    {
      key: 'vars.width',
      label: 'Width',
      kind: 'feature',
      source: 'measurement-vars',
      count: 20,
      distinctCount: 20,
      missingRatio: 0,
      eligible: true,
      min: 1,
      max: 20,
      p50: 10,
      histogram: [{ min: 1, max: 20, count: 20 }],
    },
    {
      key: 'vars.height',
      label: 'Height',
      kind: 'feature',
      source: 'measurement-vars',
      count: 20,
      distinctCount: 20,
      missingRatio: 0,
      eligible: true,
      min: 2,
      max: 40,
      p50: 20,
    },
    {
      key: 'recorded.stress',
      label: 'Stress',
      kind: 'target',
      source: 'recorded-data',
      count: 20,
      distinctCount: 20,
      missingRatio: 0,
      eligible: true,
      min: 100,
      max: 200,
      p50: 150,
      histogram: [{ min: 100, max: 200, count: 20 }],
    },
  ],
  categoricalSummaries: [],
  warnings: [],
}

function workspace(client: QueryClient, tab: AnalysisTab, command?: AnalysisCommand, settingsContainer?: Element) {
  return (
    <QueryClientProvider client={client}>
      <AnalysisWorkspace command={command} embedded experimentId={7} settingsContainer={settingsContainer} tab={tab} />
    </QueryClientProvider>
  )
}

async function loadProfile() {
  await waitFor(() => expect(AnalysisWorkerMock.instances).toHaveLength(1))
  const worker = AnalysisWorkerMock.instances[0]
  const loadRequest = worker.postMessage.mock.calls.find(([request]) => request.type === 'load-context')?.[0]
  expect(loadRequest).toBeDefined()
  act(() => worker.emit({ type: 'profile', requestId: loadRequest.requestId, profile }))
  await screen.findByText('Browser analysis workspace')
  return worker
}

beforeEach(() => {
  AnalysisWorkerMock.instances = []
  vi.stubGlobal('Worker', AnalysisWorkerMock)
  api.listExperiments.mockResolvedValue({ items: [], total: 0 })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('AnalysisWorkspace split-pane integration', () => {
  it('portals the active tab settings and omits its internal tab strip', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const settingsContainer = document.createElement('aside')
    document.body.append(settingsContainer)
    const view = render(workspace(client, 'relationships', undefined, settingsContainer))
    await loadProfile()

    expect(await within(settingsContainer).findByText('관계 설정')).toBeVisible()
    expect(within(settingsContainer).getByRole('button', { name: '관계 분석 실행' })).toBeVisible()
    expect(within(view.container).queryByText('관계 설정')).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()

    view.rerender(workspace(client, 'mining', undefined, settingsContainer))
    expect(await within(settingsContainer).findByText('PCA · 군집 · 이상치')).toBeVisible()
    expect(within(settingsContainer).queryByText('관계 설정')).not.toBeInTheDocument()
  })

  it('keeps the original tab strip and settings placement in standalone mode', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(workspace(client, 'relationships'))
    await loadProfile()

    expect(screen.getByRole('tablist')).toBeVisible()
    expect(within(view.container).getByText('관계 설정')).toBeVisible()
  })

  it('executes each ribbon command once by command id', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(workspace(client, 'overview'))
    const worker = await loadProfile()

    view.rerender(workspace(client, 'overview', { id: 'dataset-1', type: 'export-dataset' }))
    await waitFor(() =>
      expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'export-csv', kind: 'dataset' })),
    )

    view.rerender(workspace(client, 'overview', { id: 'prediction-1', type: 'export-prediction' }))
    await waitFor(() =>
      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'export-csv', kind: 'prediction' }),
      ),
    )
    const exportCount = worker.postMessage.mock.calls.filter(([request]) => request.type === 'export-csv').length
    view.rerender(workspace(client, 'overview', { id: 'prediction-1', type: 'export-prediction' }))
    await act(async () => undefined)
    expect(worker.postMessage.mock.calls.filter(([request]) => request.type === 'export-csv')).toHaveLength(exportCount)

    view.rerender(workspace(client, 'overview', { id: 'reload-1', type: 'reload' }))
    await waitFor(() => expect(AnalysisWorkerMock.instances).toHaveLength(2))
    expect(worker.terminate).toHaveBeenCalled()
  })
})
