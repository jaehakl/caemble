// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  url: string | URL

  constructor(url: string | URL) {
    this.url = url
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
  recordedMeasurementCount: 20,
  recordedDataCount: 20,
  columns: [
    {
      key: 'measurement.vars.width',
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
      key: 'measurement.vars.height',
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
      key: 'target:stress',
      label: 'Stress',
      kind: 'target',
      source: 'recorded-data',
      count: 20,
      distinctCount: 20,
      distinctInputCount: 20,
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
  const relationshipsRequest = worker.postMessage.mock.calls.find(([request]) => request.type === 'relationships')?.[0]
  expect(relationshipsRequest).toBeDefined()
  act(() =>
    worker.emit({
      type: 'relationships',
      requestId: relationshipsRequest.requestId,
      result: {
        fingerprint: profile.fingerprint,
        pairs: [
          {
            inputKey: 'measurement.vars.height',
            targetKey: 'target:stress',
            pearson: 0.96,
            spearman: 0.93,
            count: 20,
          },
          {
            inputKey: 'measurement.vars.width',
            targetKey: 'target:stress',
            pearson: -0.82,
            spearman: -0.8,
            count: 18,
          },
        ],
      },
    }),
  )
  const plotRequest = worker.postMessage.mock.calls.find(([request]) => request.type === 'relationship-plot')?.[0]
  expect(plotRequest).toMatchObject({
    inputKey: 'measurement.vars.height',
    targetKey: 'target:stress',
  })
  act(() =>
    worker.emit({
      type: 'relationship-plot',
      requestId: plotRequest.requestId,
      result: {
        fingerprint: profile.fingerprint,
        inputKey: plotRequest.inputKey,
        targetKey: plotRequest.targetKey,
        pearson: 0.96,
        spearman: 0.93,
        count: 20,
        points: [
          { measurementId: 1, x: 2, y: 100 },
          { measurementId: 2, x: 4, y: 120 },
          { measurementId: 3, x: 6, y: 140 },
        ],
      },
    }),
  )
  await screen.findByRole('img', { name: 'Height와 Stress 산점도' })
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
  it('uses a revisioned Worker URL so response-policy changes bypass immutable caches', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(workspace(client, 'explore'))

    await waitFor(() => expect(AnalysisWorkerMock.instances).toHaveLength(1))
    const workerUrl = new URL(AnalysisWorkerMock.instances[0].url)
    expect(workerUrl.searchParams.get('response-policy')).toBe('connect-self-v1')
  })

  it('portals the active tab settings and omits its internal tab strip', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const settingsContainer = document.createElement('aside')
    document.body.append(settingsContainer)
    const view = render(workspace(client, 'explore', undefined, settingsContainer))
    await loadProfile()

    expect(await within(settingsContainer).findByText('Explore')).toBeVisible()
    expect(within(settingsContainer).getByRole('listbox', { name: 'Input variable' })).toHaveTextContent('Height')
    expect(within(settingsContainer).getByRole('option', { name: /Height/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(settingsContainer).getByRole('listbox', { name: 'Recorded Data' })).toHaveTextContent('Stress')
    expect(
      within(view.container).queryByText(
        'input vars 하나와 숫자 Recorded Data 하나를 선택하면 산점도가 즉시 갱신됩니다.',
      ),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()

    view.rerender(workspace(client, 'mining', undefined, settingsContainer))
    expect(await within(settingsContainer).findByText('Mining 설정')).toBeVisible()
    expect(within(settingsContainer).queryByText('Input variable')).not.toBeInTheDocument()
  })

  it('최상위 조합을 자동 선택하고 순위 행 선택을 선택기·산점도에 연동한다', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const settingsContainer = document.createElement('aside')
    document.body.append(settingsContainer)
    render(workspace(client, 'explore', undefined, settingsContainer))
    const worker = await loadProfile()

    expect(screen.getByText('Strongest relationships')).toBeVisible()
    expect(screen.getAllByText('0.96')[0]).toBeVisible()
    fireEvent.click(screen.getByRole('row', { name: 'Width와 Stress 관계 보기' }))
    const plotRequests = worker.postMessage.mock.calls.filter(([request]) => request.type === 'relationship-plot')
    const nextPlotRequest = plotRequests[plotRequests.length - 1]?.[0]
    expect(nextPlotRequest).toMatchObject({ inputKey: 'measurement.vars.width', targetKey: 'target:stress' })
    act(() =>
      worker.emit({
        type: 'relationship-plot',
        requestId: nextPlotRequest.requestId,
        result: {
          fingerprint: profile.fingerprint,
          inputKey: 'measurement.vars.width',
          targetKey: 'target:stress',
          pearson: -0.82,
          spearman: -0.8,
          count: 18,
          points: [{ measurementId: 4, x: 8, y: 160 }],
        },
      }),
    )

    expect(within(settingsContainer).getByRole('option', { name: /Width/ })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('img', { name: 'Width와 Stress 산점도' })).toBeVisible()
  })

  it('keeps the tab strip and settings placement in standalone mode', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(workspace(client, 'explore'))
    await loadProfile()

    expect(screen.getByRole('tablist')).toBeVisible()
    expect(within(view.container).getByText('Input variable')).toBeVisible()
  })

  it('executes each ribbon command once by command id', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(workspace(client, 'explore'))
    const worker = await loadProfile()

    view.rerender(workspace(client, 'explore', { id: 'dataset-1', type: 'export-dataset' }))
    await waitFor(() =>
      expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'export-csv', kind: 'dataset' })),
    )

    view.rerender(workspace(client, 'explore', { id: 'prediction-1', type: 'export-prediction' }))
    await waitFor(() =>
      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'export-csv', kind: 'prediction' }),
      ),
    )
    const exportCount = worker.postMessage.mock.calls.filter(([request]) => request.type === 'export-csv').length
    view.rerender(workspace(client, 'explore', { id: 'prediction-1', type: 'export-prediction' }))
    await act(async () => undefined)
    expect(worker.postMessage.mock.calls.filter(([request]) => request.type === 'export-csv')).toHaveLength(exportCount)

    view.rerender(workspace(client, 'explore', { id: 'reload-1', type: 'reload' }))
    await waitFor(() => expect(AnalysisWorkerMock.instances).toHaveLength(2))
    expect(worker.terminate).toHaveBeenCalled()
  })
})
