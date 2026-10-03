import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, expect, it, vi } from 'vitest'
import { optimizationApi } from '@/api/optimization'
import { ApiError } from '@/api/http'
import { optimizationDetailSchema, optimizationTrialSchema } from '@/contracts/api/optimization'
import { OptimizationManagement } from './OptimizationManagement'
import { hybridOptimizationFixture, optimizationFixture, trialFixture } from './fixtures.test-support'
import { optimizationQueryKeys } from './queryKeys'
import { qualityReportFixture } from '@/features/prediction/qualityReport.fixture'

const auth = vi.hoisted(() => ({ isAuthenticated: true, queryScope: 'user:first' }))
vi.mock('@/features/auth/use-auth', () => ({ useAuth: () => auth }))
vi.mock('@/api/optimization', () => ({
  optimizationApi: {
    list: vi.fn(),
    read: vi.fn(),
    trials: vi.fn(),
    retry: vi.fn(),
    retryEvaluation: vi.fn(),
    modelUpdate: vi.fn(),
    stop: vi.fn(),
    resume: vi.fn(),
    remove: vi.fn(),
  },
}))
beforeEach(() => {
  vi.clearAllMocks()
  auth.queryScope = 'user:first'
  vi.mocked(optimizationApi.list).mockResolvedValue({ items: [optimizationFixture], total: 1 })
  vi.mocked(optimizationApi.read).mockResolvedValue(optimizationFixture)
  vi.mocked(optimizationApi.trials).mockResolvedValue({ items: [trialFixture], total: 1 })
  vi.mocked(optimizationApi.retry).mockResolvedValue(optimizationFixture)
  vi.mocked(optimizationApi.retryEvaluation).mockResolvedValue(optimizationFixture)
  vi.mocked(optimizationApi.modelUpdate).mockResolvedValue(hybridOptimizationFixture)
})

it.each([
  {
    algorithm: { id: 'random', version: 1, config: { seed: 42, candidates_per_round: 4 } },
    label: '무작위 탐색 · seed 42 · 회차당 4개',
  },
  {
    algorithm: {
      id: 'de',
      version: 1,
      config: { seed: 42, population_size: 8, mutation_factor: 0.8, crossover_rate: 0.9 },
    },
    label: 'DE · seed 42 · 개체군 8개 · F 0.8 · CR 0.9',
  },
])('restores the persisted $algorithm.id configuration in the execution detail', async ({ algorithm, label }) => {
  const saved = optimizationDetailSchema.parse({
    ...optimizationFixture,
    settings: {
      ...optimizationFixture.settings,
      algorithm,
    },
  })
  vi.mocked(optimizationApi.read).mockResolvedValue(saved)
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <OptimizationManagement selectedId={saved.id} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(await screen.findByLabelText('저장된 탐색 설정')).toHaveTextContent(label)
})

it('shows initial and adopted models, disables a pending update, and keeps a lost update request idempotent', async () => {
  let current = hybridOptimizationFixture
  vi.mocked(optimizationApi.read).mockImplementation(async () => current)
  vi.mocked(optimizationApi.modelUpdate)
    .mockRejectedValueOnce(new Error('Update response lost'))
    .mockImplementation(async (_id, requestId) => {
      current = {
        ...current,
        model_update: {
          ...current.model_update!,
          waiting: false,
          updates: [
            {
              request_id: requestId,
              operation_id: 'training-operation',
              model_id: 'model-1',
              revision: 2,
              version_name: 'Design search update 1',
              state: 'queued',
            },
          ],
        },
      }
      return current
    })
  renderManagement()
  const panel = within(await screen.findByLabelText('Hybrid 모델 갱신'))
  expect(panel.getByText('초기 모델')).toBeInTheDocument()
  expect(panel.getByText('현재 채택 모델')).toBeInTheDocument()
  fireEvent.click(panel.getByRole('button', { name: '모델 갱신' }))
  await screen.findByText('Update response lost')
  fireEvent.click(panel.getByRole('button', { name: '모델 갱신' }))
  await waitFor(() => expect(panel.getByRole('button', { name: '모델 갱신' })).toBeDisabled())
  expect(optimizationApi.modelUpdate).toHaveBeenCalledTimes(2)
  expect(vi.mocked(optimizationApi.modelUpdate).mock.calls[0]).toEqual(
    vi.mocked(optimizationApi.modelUpdate).mock.calls[1],
  )
  expect(panel.getByText('수동 갱신 · Design search update 1 · 학습 대기')).toBeInTheDocument()
})

it('keeps model update errors separate from evaluations and directs retries to Prediction operations', async () => {
  const active = {
    ...hybridOptimizationFixture.model_update!.active_model,
    model_revision: 2,
    version_name: 'Design search update 1',
    checksum: 'b'.repeat(64),
  }
  const optimization = {
    ...hybridOptimizationFixture,
    model_update: {
      ...hybridOptimizationFixture.model_update!,
      active_model: active,
      updates: [
        {
          request_id: 'update-2',
          operation_id: 'training-operation',
          model_id: 'model-1',
          revision: 3,
          version_name: 'Design search update 2',
          state: 'failed',
          error: { message: 'Training interrupted' },
        },
      ],
    },
  }
  expect(optimizationDetailSchema.parse(optimization).model_update).toEqual(optimization.model_update)
  vi.mocked(optimizationApi.read).mockResolvedValue(optimization)
  renderManagement()
  const panel = within(await screen.findByLabelText('Hybrid 모델 갱신'))
  expect(panel.getByText('Design search update 1 · revision 2')).toBeInTheDocument()
  expect(panel.getByText('Training interrupted')).toBeInTheDocument()
  expect(panel.getByRole('link', { name: 'Prediction 관리' })).toHaveAttribute('href', '/settings/prediction')
  expect(panel.getByText('Operation training-operation')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '재개' })).toBeEnabled()
})

it.each(['pausing', 'completed'])('does not offer a model update while %s', async (state) => {
  vi.mocked(optimizationApi.read).mockResolvedValue({ ...hybridOptimizationFixture, state })
  renderManagement()
  await screen.findByLabelText('Hybrid 모델 갱신')
  expect(screen.queryByRole('button', { name: '모델 갱신' })).not.toBeInTheDocument()
})

it('restores frozen and active quality assessments without deriving a verdict from the model list', async () => {
  const initial = {
    ...hybridOptimizationFixture.model_update!.initial_model,
    quality_report: qualityReportFixture,
    quality_requirements: [{ recordId: 10, component: 'value', rmseMaximum: 1 }],
    quality_assessment: {
      status: 'passed' as const,
      reasonCode: 'requirements-passed',
      items: [
        {
          recordId: 10,
          component: 'value',
          rmseMaximum: 1,
          rmse: 0.6,
          unit: 'K',
          status: 'passed' as const,
          reasonCode: 'within-limit',
        },
      ],
    },
  }
  const active = {
    ...initial,
    model_revision: 2,
    quality_assessment: {
      status: 'unassessed' as const,
      reasonCode: 'requirements-unassessed',
      items: [
        {
          ...initial.quality_assessment.items[0],
          rmse: null,
          status: 'unassessed' as const,
          reasonCode: 'record-unavailable',
        },
      ],
    },
  }
  const optimization = {
    ...hybridOptimizationFixture,
    definition: {
      ...hybridOptimizationFixture.definition,
      hybrid: { ...hybridOptimizationFixture.definition.hybrid!, ...initial },
    },
    model_update: { ...hybridOptimizationFixture.model_update!, initial_model: initial, active_model: active },
  }
  const parsed = optimizationDetailSchema.parse(optimization)
  expect(parsed.definition.hybrid?.quality_report).toEqual(qualityReportFixture)
  expect(parsed.model_update?.active_model.quality_assessment).toEqual(active.quality_assessment)
  vi.mocked(optimizationApi.read).mockResolvedValue(parsed)
  renderManagement()
  const initialQuality = within(await screen.findByLabelText('초기 모델 품질'))
  expect(initialQuality.getByText('품질 판정: 통과')).toBeInTheDocument()
  expect(initialQuality.getByText(/Record 10 · value: 통과 · RMSE 0.6 \/ 상한 1 K/)).toBeInTheDocument()
  const activeQuality = within(screen.getByLabelText('현재 채택 모델 품질'))
  expect(activeQuality.getByText('품질 판정: 미평가')).toBeInTheDocument()
  expect(activeQuality.getByText(/평가된 Record가 없습니다./)).toBeInTheDocument()
})

it('restores separate predictions and verifications, applies only verified Vars, and retries Calculation after budget exhaustion', async () => {
  const predicted = {
    ...optimizationFixture.best_trial!,
    id: 'predicted-trial',
    ordinal: 2,
    variables: { width: 4 },
    measurement_id: null,
    result: { objective: 1, feasible: true, violation: 0, constraints: [] },
  }
  const hybrid = {
    model_id: 'model-1',
    model_revision: 2,
    replica_id: 'replica-1',
    launcher_id: 'launcher-1',
    max_solver_runs: 8,
  }
  const optimization = {
    ...optimizationFixture,
    state: 'completed',
    termination_reason: 'solver_budget_exhausted',
    settings: { ...optimizationFixture.settings, hybrid },
    best_predicted_trial: predicted,
    best_verified_trial: optimizationFixture.best_trial,
    solver_budget: { limit: 8, used: 8, reserved: 0, remaining: 0 },
  }
  const prediction = {
    id: 'prediction-evaluation',
    kind: 'prediction' as const,
    definition_hash: 'prediction-hash',
    source: { model_id: hybrid.model_id, model_revision: 2 },
    state: 'failed',
    next_stage: 'calculate' as const,
    measurement_id: null,
    result: null,
    error: { message: 'Prediction calculation failed' },
    retry_count: 0,
    manual_retry_requested: false,
    stages: [{ ...trialFixture.stages[0], id: 'predict', stage: 'predict', job_id: 'prediction-job' }],
  }
  const solver = {
    ...prediction,
    id: 'solver-evaluation',
    kind: 'solver' as const,
    next_stage: 'solve' as const,
    source: {},
    error: { message: 'Solver disconnected' },
    stages: [],
  }
  vi.mocked(optimizationApi.read).mockResolvedValue(optimization)
  vi.mocked(optimizationApi.trials).mockResolvedValue({
    items: [{ ...trialFixture, evaluations: [prediction, solver] }],
    total: 1,
  })
  const apply = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const page = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement onApplyBest={apply} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByText('Trial 2')
  expect(within(screen.getByLabelText('예측 최선 후보')).getByText('1')).toBeInTheDocument()
  expect(screen.getByText('검증된 최선 후보 · Trial 1')).toBeInTheDocument()
  expect(screen.getByText('사용 8 · 예약 0 · 잔여 0')).toBeInTheDocument()
  expect(screen.getByText('종료 사유: Solver 실행 시도 예산 소진')).toBeInTheDocument()
  const predictionHistory = within(screen.getByLabelText('예측 평가'))
  expect(predictionHistory.queryByText(/Measurement/)).not.toBeInTheDocument()
  expect(predictionHistory.getByText('Job prediction-job')).toBeInTheDocument()
  expect(
    within(screen.getByLabelText('실제 검증 평가')).getByRole('button', { name: '실패 단계 재시도' }),
  ).toBeDisabled()
  fireEvent.click(predictionHistory.getByRole('button', { name: '실패 단계 재시도' }))
  await waitFor(() =>
    expect(optimizationApi.retryEvaluation).toHaveBeenCalledWith(optimization.id, prediction.id, expect.any(String)),
  )
  expect(optimizationApi.retry).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('최선 Vars로 새 Candidate 열기'))
  expect(apply.mock.calls[0][0].best_trial.variables).toEqual({ width: 3 })
  page.unmount()
  expect(optimizationApi.stop).not.toHaveBeenCalled()
})

it('reads one Optimization group, displays stage history, and retries only through the Optimization route', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const apply = vi.fn()
  const page = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement onApplyBest={apply} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(optimizationDetailSchema.parse(optimizationFixture)).toEqual(optimizationFixture)
  expect(optimizationTrialSchema.parse(trialFixture)).toEqual(trialFixture)
  await screen.findByText('Trial 2')
  expect(screen.getByText('Job build-job')).toBeInTheDocument()
  expect(screen.getByText('Job solve-job')).toBeInTheDocument()
  expect(screen.getByText('Job calculate-job')).toBeInTheDocument()
  expect(screen.getByLabelText('Optimization 목록').children).toHaveLength(1)
  expect(screen.getByText('재개')).toBeDisabled()
  fireEvent.click(screen.getByText('실패 단계 재시도'))
  await waitFor(() =>
    expect(optimizationApi.retry).toHaveBeenCalledWith('optimization-1', 'trial-2', expect.any(String)),
  )
  expect(optimizationApi.stop).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('최선 Vars로 새 Candidate 열기'))
  expect(apply).toHaveBeenCalledWith(optimizationFixture)
  page.unmount()
  expect(optimizationApi.stop).not.toHaveBeenCalled()
})

it.each([{ state: 'pausing' }, { executions_active: 1 }, { cleanup_pending: true }, { manual_retry_pending: true }])(
  'blocks retries while prior Optimization work is active: %j',
  async (status) => {
    const optimization = { ...optimizationFixture, ...status }
    vi.mocked(optimizationApi.read).mockResolvedValue(optimization)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <OptimizationManagement />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('실패 단계 재시도')).toBeDisabled()
    expect(screen.getByText('삭제')).toBeDisabled()
    expect(optimizationApi.retry).not.toHaveBeenCalled()
  },
)

it('resumes dormant pending Trials when there are no failed Trials or active executions', async () => {
  vi.mocked(optimizationApi.read).mockResolvedValue({ ...optimizationFixture, failed: 0, active: 2 })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(await screen.findByText('재개')).toBeEnabled()
})

it.each(['paused', 'running'])('keeps incompatible %s history readable while blocking new work', async (state) => {
  const reason = 'Stored search state is unsupported. Create a new Optimization.'
  vi.mocked(optimizationApi.read).mockResolvedValue({
    ...hybridOptimizationFixture,
    state,
    continuation: { supported: false, reason },
  })
  renderManagement()
  expect(await screen.findByText(reason)).toBeInTheDocument()
  expect(await screen.findByText('실패 단계 재시도')).toBeDisabled()
  expect(screen.getByRole('button', { name: '모델 갱신' })).toBeDisabled()
  if (state === 'paused') {
    expect(screen.getByRole('button', { name: '재개' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '삭제' })).toBeEnabled()
  } else {
    expect(screen.getByRole('button', { name: '중지' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '삭제' })).toBeDisabled()
  }
  expect(screen.getByText('Job solve-job')).toBeInTheDocument()
  expect(optimizationApi.retry).not.toHaveBeenCalled()
  expect(optimizationApi.modelUpdate).not.toHaveBeenCalled()
})

it('keeps ambiguous transport retries idempotent but advances after an accepted retry fails before submission', async () => {
  vi.mocked(optimizationApi.retry)
    .mockRejectedValueOnce(new Error('Connection lost'))
    .mockResolvedValue(optimizationFixture)
  vi.mocked(optimizationApi.trials)
    .mockResolvedValueOnce({ items: [trialFixture], total: 1 })
    .mockResolvedValue({ items: [{ ...trialFixture, retry_count: 1 }], total: 1 })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByText('실패 단계 재시도'))
  await screen.findByText('Connection lost')
  fireEvent.click(screen.getByText('실패 단계 재시도'))
  await screen.findByText('수동 재시도 1회 · 새 Trial 예산을 사용하지 않습니다.')
  await waitFor(() => expect(screen.getByText('실패 단계 재시도')).toBeEnabled())
  fireEvent.click(screen.getByText('실패 단계 재시도'))
  await waitFor(() => expect(optimizationApi.retry).toHaveBeenCalledTimes(3))
  const requests = vi.mocked(optimizationApi.retry).mock.calls.map((args) => args[2])
  expect(requests[0]).toBe(requests[1])
  expect(requests[2]).not.toBe(requests[1])
  expect(screen.getByText('Trial 2 / 20 · 성공 1 · 실패 1')).toBeInTheDocument()
})

it('starts at the first Trial page when the selected Optimization changes externally', async () => {
  vi.mocked(optimizationApi.trials).mockResolvedValue({ items: [trialFixture], total: 40 })
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => ({ ...optimizationFixture, id }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onSelect = vi.fn()
  const view = (id: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement selectedId={id} onSelect={onSelect} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const page = render(view('optimization-1'))
  fireEvent.click(await screen.findByText('다음 Trial'))
  await waitFor(() => expect(optimizationApi.trials).toHaveBeenCalledWith('optimization-1', 20, expect.anything()))
  page.rerender(view('optimization-2'))
  await waitFor(() => expect(optimizationApi.trials).toHaveBeenCalledWith('optimization-2', 0, expect.anything()))
  expect(optimizationApi.trials).not.toHaveBeenCalledWith('optimization-2', 20, expect.anything())
})

it('refreshes final Trial results when a running Optimization becomes terminal', async () => {
  vi.mocked(optimizationApi.read).mockResolvedValue({ ...optimizationFixture, state: 'running' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByText('Trial 2')
  const calls = vi.mocked(optimizationApi.trials).mock.calls.length
  act(() =>
    client.setQueryData(optimizationQueryKeys.detail('user:first', 'optimization-1'), {
      ...optimizationFixture,
      state: 'completed',
    }),
  )
  await waitFor(() => expect(optimizationApi.trials).toHaveBeenCalledTimes(calls + 1))
})

function renderManagement(selectedId?: string | null, experimentId?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onSelect = vi.fn()
  const view = (id?: string | null, experiment?: number) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement selectedId={id} experimentId={experiment} onSelect={onSelect} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const page = render(view(selectedId, experimentId))
  return {
    ...page,
    client,
    onSelect,
    update: (id?: string | null, experiment?: number) => page.rerender(view(id, experiment)),
  }
}

it('pins the initial selection while polling reorders the list without changing URL history', async () => {
  const first = { ...optimizationFixture, name: 'First optimization' }
  const second = { ...optimizationFixture, id: 'optimization-2', name: 'Second optimization' }
  vi.mocked(optimizationApi.list).mockResolvedValue({ items: [first, second], total: 2 })
  const page = renderManagement()
  await screen.findByText('Trial 2')
  act(() =>
    page.client.setQueryData(optimizationQueryKeys.list('user:first', undefined, 0), {
      items: [second, first],
      total: 2,
    }),
  )
  expect(screen.getByRole('button', { name: /First optimization/ })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: /Second optimization/ })).toHaveAttribute('aria-pressed', 'false')
  expect(page.onSelect).not.toHaveBeenCalled()
})

it('returns to the default selection when browser history clears an explicit URL target', async () => {
  const first = { ...optimizationFixture, name: 'First optimization' }
  const second = { ...optimizationFixture, id: 'optimization-2', name: 'Second optimization' }
  vi.mocked(optimizationApi.list).mockResolvedValue({ items: [first, second], total: 2 })
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => (id === second.id ? second : first))
  const page = renderManagement(null)
  fireEvent.click(await screen.findByRole('button', { name: /Second optimization/ }))
  page.update(second.id)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Second optimization/ })).toHaveAttribute('aria-pressed', 'true'),
  )
  page.update(null)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /First optimization/ })).toHaveAttribute('aria-pressed', 'true'),
  )
})

it('offers explicit recovery for a missing URL target and keeps the list available', async () => {
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => {
    if (id === 'missing') throw new ApiError(404, 'Not found', null)
    return optimizationFixture
  })
  const page = renderManagement('missing')
  const recover = await screen.findByRole('button', { name: '목록으로 돌아가기' })
  expect(screen.getByLabelText('Optimization 목록').children).toHaveLength(1)
  expect(optimizationApi.trials).not.toHaveBeenCalled()
  expect(page.onSelect).not.toHaveBeenCalled()
  fireEvent.click(recover)
  await screen.findByText('Trial 2')
  expect(page.onSelect).toHaveBeenCalledWith(null)
})

it('does not show a foreign Experiment target under the current Experiment', async () => {
  vi.mocked(optimizationApi.read).mockResolvedValue({ ...optimizationFixture, experiment_id: 8 })
  renderManagement(optimizationFixture.id, 7)
  await screen.findByRole('button', { name: '목록으로 돌아가기' })
  expect(optimizationApi.trials).not.toHaveBeenCalled()
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
})

it('scopes pending requests and late errors to their target Optimization', async () => {
  const first = { ...optimizationFixture, name: 'First optimization', failed: 0 }
  const second = { ...first, id: 'optimization-2', name: 'Second optimization' }
  vi.mocked(optimizationApi.list).mockResolvedValue({ items: [first, second], total: 2 })
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => (id === second.id ? second : first))
  let reject!: (cause: Error) => void
  vi.mocked(optimizationApi.resume).mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      }),
  )
  renderManagement()
  fireEvent.click(await screen.findByRole('button', { name: '재개' }))
  expect(screen.getByRole('button', { name: '재개' })).toBeDisabled()
  expect(screen.getByText('요청을 처리하고 있습니다…')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Second optimization/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: '재개' })).toBeEnabled())
  expect(screen.queryByText('요청을 처리하고 있습니다…')).not.toBeInTheDocument()
  await act(async () => reject(new Error('First request failed')))
  expect(screen.queryByText('First request failed')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /First optimization/ }))
  expect(await screen.findByText('First request failed')).toBeInTheDocument()
})

it('does not change the current selection after a previous target finishes deleting', async () => {
  const first = { ...optimizationFixture, name: 'First optimization' }
  const second = { ...first, id: 'optimization-2', name: 'Second optimization' }
  vi.mocked(optimizationApi.list).mockResolvedValue({ items: [first, second], total: 2 })
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => (id === second.id ? second : first))
  let finish!: () => void
  vi.mocked(optimizationApi.remove).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const page = renderManagement()
  fireEvent.click(await screen.findByRole('button', { name: '삭제' }))
  fireEvent.click(screen.getByRole('button', { name: /Second optimization/ }))
  await act(async () => finish())
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Second optimization/ })).toHaveAttribute('aria-pressed', 'true'),
  )
  expect(page.onSelect).not.toHaveBeenCalledWith(null)
  confirm.mockRestore()
})

it('returns to the preceding page after the last Optimization on a page is deleted', async () => {
  const first = { ...optimizationFixture, name: 'First page optimization' }
  const last = { ...optimizationFixture, id: 'last', name: 'Last page optimization' }
  let removed = false
  vi.mocked(optimizationApi.list).mockImplementation(async ({ offset } = {}) => ({
    items: offset === 20 ? (removed ? [] : [last]) : [first],
    total: removed ? 20 : 21,
  }))
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => (id === last.id ? last : first))
  vi.mocked(optimizationApi.remove).mockImplementation(async () => {
    removed = true
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderManagement()
  fireEvent.click(await screen.findByRole('button', { name: '다음' }))
  await screen.findByRole('button', { name: /Last page optimization/ })
  fireEvent.click(await screen.findByRole('button', { name: '삭제' }))
  expect(await screen.findByRole('button', { name: /First page optimization/ })).toHaveAttribute('aria-pressed', 'true')
  confirm.mockRestore()
})

it('ignores mutation completion after switching account scope', async () => {
  let finish!: () => void
  vi.mocked(optimizationApi.remove).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const page = renderManagement()
  fireEvent.click(await screen.findByRole('button', { name: '삭제' }))
  auth.queryScope = 'user:second'
  page.update()
  await act(async () => finish())
  expect(page.onSelect).not.toHaveBeenCalledWith(null)
  confirm.mockRestore()
})

it('skips an unavailable item still present in the cached list when clearing its URL', async () => {
  vi.mocked(optimizationApi.list).mockResolvedValue({
    items: [
      { ...optimizationFixture, id: 'missing' },
      { ...optimizationFixture, name: 'Available optimization' },
    ],
    total: 2,
  })
  vi.mocked(optimizationApi.read).mockImplementation(async (id) => {
    if (id === 'missing') throw new ApiError(404, 'Not found', null)
    return optimizationFixture
  })
  const page = renderManagement('missing')
  fireEvent.click(await screen.findByRole('button', { name: '목록으로 돌아가기' }))
  page.update(null)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Available optimization/ })).toHaveAttribute('aria-pressed', 'true'),
  )
  expect(screen.queryByRole('button', { name: '목록으로 돌아가기' })).not.toBeInTheDocument()
})

it('keeps Settings compact with controls and best objective, linking to Workbench for full history', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OptimizationManagement compact />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const link = await screen.findByRole('link', { name: 'Workbench에서 열기' })
  expect(link).toHaveAttribute('href', `/?experiment=7&optimization=${optimizationFixture.id}`)
  expect(screen.getByRole('button', { name: '삭제' })).toBeEnabled()
  expect(screen.getByRole('progressbar', { name: '평가 예산 사용' })).toHaveAttribute('aria-valuenow', '2')
  expect(screen.getByText('최선 후보 · Trial 1')).toBeInTheDocument()
  expect(screen.queryByText('Vars 확인')).not.toBeInTheDocument()
  expect(screen.queryByText('고정된 평가 정의')).not.toBeInTheDocument()
  expect(screen.queryByRole('list', { name: 'Trial 이력' })).not.toBeInTheDocument()
  expect(screen.queryByText('실패 단계 재시도')).not.toBeInTheDocument()
  expect(optimizationApi.trials).not.toHaveBeenCalled()
  expect(
    screen.getByRole('button', { name: '삭제' }).compareDocumentPosition(screen.getByRole('progressbar')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
})
