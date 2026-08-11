// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisProfile, AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-types'
import { AnalysisWorkspace, type AnalysisTab } from './AnalysisPage'

const apiMocks = vi.hoisted(() => ({
  experimentList: vi.fn(),
  structureList: vi.fn(),
}))

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'user-1', roles: ['user'] },
  }),
}))

vi.mock('@/api', () => ({
  getListRequest: (scope = 'visible') => ({
    scope,
    offset: 0,
    limit: 24,
    selected_ids: [],
    search_text: null,
    text_filter: {},
    filter: {},
    sort: ['updated_at', 'desc'],
  }),
  dbTables: {
    Structure: { listRows: apiMocks.structureList },
    Experiment: { listRows: apiMocks.experimentList },
  },
}))

const profile: AnalysisProfile = {
  fingerprint: 'fixture',
  structureId: 1,
  experimentId: 2,
  rowCount: 24,
  sampleCount: 6,
  setupCount: 4,
  recordedDataCount: 24,
  categoricalSummaries: [],
  warnings: [],
  columns: [
    {
      key: 'sample.vars.width',
      label: 'sample.vars.width',
      kind: 'feature',
      source: 'sample-vars',
      count: 24,
      distinctCount: 6,
      missingRatio: 0,
      eligible: true,
      min: 1,
      max: 6,
      mean: 3.5,
      std: 1.5,
      p05: 1,
      p25: 2,
      p50: 3.5,
      p75: 5,
      p95: 6,
      histogram: [{ min: 1, max: 6, count: 24 }],
    },
    {
      key: 'target:result',
      label: 'result',
      kind: 'target',
      source: 'recorded-data',
      count: 24,
      distinctCount: 24,
      missingRatio: 0,
      eligible: true,
      quantityKind: 'Dimensionless',
      min: 2,
      max: 48,
      mean: 25,
      std: 12,
      p05: 2,
      p25: 12,
      p50: 25,
      p75: 36,
      p95: 48,
      histogram: [{ min: 2, max: 48, count: 24 }],
    },
  ],
}

class MockWorker {
  static instances: MockWorker[] = []
  static autoLoad = true
  static responseProfile = profile
  static stale = false

  onerror: ((event: ErrorEvent) => void) | null = null
  onmessage: ((event: MessageEvent<AnalysisWorkerResponse>) => void) | null = null
  messages: AnalysisWorkerRequest[] = []
  terminated = false

  constructor() {
    MockWorker.instances.push(this)
  }

  postMessage(request: AnalysisWorkerRequest) {
    this.messages.push(request)
    if (request.type === 'load-context') {
      this.respond({
        type: 'progress',
        requestId: request.requestId,
        stage: 'Recorded Data 조회',
        completed: 1,
        total: 2,
      })
      if (MockWorker.autoLoad) {
        this.respond({ type: 'profile', requestId: request.requestId, profile: MockWorker.responseProfile })
      }
    } else if (request.type === 'check-stale') {
      this.respond({ type: 'stale', requestId: request.requestId, stale: MockWorker.stale })
    } else if (request.type === 'table-page') {
      this.respond({
        type: 'table-page',
        requestId: request.requestId,
        page: {
          fingerprint: 'fixture',
          offset: request.offset,
          total: 1,
          columns: request.columnKeys,
          rows: [
            {
              measurementId: 101,
              sampleId: 10,
              setupId: 20,
              values: request.columnKeys.map((_, index) => index + 1),
            },
          ],
        },
      })
    } else if (request.type === 'export-csv') {
      this.respond({
        type: 'csv',
        requestId: request.requestId,
        blob: new Blob(['\uFEFFmeasurement_id\r\n101'], { type: 'text/csv;charset=utf-8' }),
        filename: 'analysis-data.csv',
      })
    }
  }

  terminate() {
    this.terminated = true
  }

  private respond(response: AnalysisWorkerResponse) {
    queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<AnalysisWorkerResponse>))
  }
}

function renderPage(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const url = new URL(initialEntry, 'http://localhost')
  const requestedTab = url.searchParams.get('tab')
  const tab: AnalysisTab = requestedTab === 'data' ? 'data' : 'overview'
  render(
    <QueryClientProvider client={queryClient}>
      <AnalysisWorkspace experimentId={2} initialTargetKey={url.searchParams.get('target')} structureId={1} tab={tab} />
    </QueryClientProvider>,
  )
}

describe('AnalysisWorkspace', () => {
  beforeEach(() => {
    MockWorker.instances = []
    MockWorker.autoLoad = true
    MockWorker.responseProfile = profile
    MockWorker.stale = false
    vi.stubGlobal('Worker', MockWorker)
    const BrowserUrl = globalThis.URL
    class TestUrl extends BrowserUrl {}
    TestUrl.createObjectURL = vi.fn(() => 'blob:analysis')
    TestUrl.revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', TestUrl)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    apiMocks.structureList.mockResolvedValue({ total: 1, items: [{ id: 1, name: 'Structure A', code: '' }] })
    apiMocks.experimentList.mockResolvedValue({ total: 1, items: [{ id: 2, name: 'Experiment B', code: '' }] })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('주어진 context와 Data 탭을 복원하고 Worker에서 현재 100행만 요청한다', async () => {
    renderPage('/?structure=1&experiment=2&tab=data&target=target%3Aresult')

    expect(await screen.findByText('#101')).toBeInTheDocument()
    const worker = MockWorker.instances[0]
    expect(worker.messages[0]).toMatchObject({
      type: 'load-context',
      structureId: 1,
      experimentId: 2,
    })
    expect(worker.messages).toContainEqual(
      expect.objectContaining({
        type: 'table-page',
        limit: 100,
        offset: 0,
        columnKeys: ['sample.vars.width', 'target:result'],
      }),
    )
  })

  it('포커스 복귀 때 signature를 확인하고 stale 배너를 표시한다', async () => {
    MockWorker.stale = true
    renderPage('/?structure=1&experiment=2')
    await screen.findAllByText('24')

    act(() => window.dispatchEvent(new Event('focus')))

    expect(await screen.findByText(/다른 화면에서 Measurement가 변경되었습니다/)).toBeInTheDocument()
    expect(MockWorker.instances[0].messages).toContainEqual(expect.objectContaining({ type: 'check-stale' }))
  })

  it('현재 조합에 Measurement가 없으면 명확한 빈 상태를 표시한다', async () => {
    MockWorker.responseProfile = {
      ...profile,
      rowCount: 0,
      sampleCount: 0,
      setupCount: 0,
      recordedDataCount: 0,
      columns: [],
    }
    renderPage('/?structure=1&experiment=2')

    expect(await screen.findByText('이 조합에 Measurement가 없습니다.')).toBeInTheDocument()
  })

  it('취소 시 실행 중 Worker를 종료하고 새 Worker로 context를 다시 불러온다', async () => {
    MockWorker.autoLoad = false
    renderPage('/?structure=1&experiment=2')
    expect(await screen.findByText('1/2 범위 완료')).toBeInTheDocument()
    const first = MockWorker.instances[0]

    await userEvent.click(screen.getByRole('button', { name: '취소' }))

    await waitFor(() => expect(MockWorker.instances).toHaveLength(2))
    expect(first.terminated).toBe(true)
    expect(MockWorker.instances[1].messages[0]).toMatchObject({
      type: 'load-context',
      structureId: 1,
      experimentId: 2,
    })
  })

  it('CSV 버튼은 전체 matrix 대신 Worker export 명령을 보낸다', async () => {
    renderPage('/?structure=1&experiment=2')
    await screen.findAllByText('24')

    await userEvent.click(screen.getByRole('button', { name: '분석 데이터 CSV' }))

    await waitFor(() => {
      expect(MockWorker.instances[0].messages).toContainEqual(
        expect.objectContaining({
          type: 'export-csv',
          kind: 'dataset',
          columnKeys: ['sample.vars.width', 'target:result'],
        }),
      )
    })
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it('라우터 상태 없이 고정된 Structure와 Experiment 조합을 분석한다', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AnalysisWorkspace experimentId={8} structureId={7} />
      </QueryClientProvider>,
    )

    await screen.findAllByText('24')
    expect(MockWorker.instances[0].messages[0]).toMatchObject({
      type: 'load-context',
      structureId: 7,
      experimentId: 8,
    })
    expect(screen.queryByText('Structure 선택')).not.toBeInTheDocument()
    expect(screen.queryByText('Experiment 선택')).not.toBeInTheDocument()
  })
})
