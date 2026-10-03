import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { optimizationApi } from '@/api/optimization'
import { predictionApi } from '@/api/prediction'
import { dbTables } from '@/api'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { OptimizationSetup } from './OptimizationSetup'
import { optimizationFixture } from './fixtures.test-support'
import { createOptimizationDraft } from './optimizationDraft'
import { useOptimizationCreation } from './useOptimizationData'
import { qualityReportFixture } from '@/features/prediction/qualityReport.fixture'
import { optimizationAlgorithmSchema } from '@/contracts/api/optimization'

vi.mock('@/features/auth/use-auth', () => ({ useAuth: () => ({ queryScope: 'user:first' }) }))
vi.mock('@/api/optimization', () => ({ optimizationApi: { create: vi.fn() } }))

it('validates DE defaults and bounded settings', () => {
  expect(optimizationAlgorithmSchema.parse({ id: 'de' })).toEqual({
    id: 'de',
    version: 1,
    config: { seed: 0, population_size: 8, mutation_factor: 0.8, crossover_rate: 0.9 },
  })
  for (const config of [
    { seed: -1 },
    { seed: 2 ** 32 },
    { seed: true },
    { population_size: 3 },
    { population_size: 33 },
    { population_size: 4.5 },
    { mutation_factor: 0 },
    { mutation_factor: 2 },
    { mutation_factor: Infinity },
    { crossover_rate: -0.1 },
    { crossover_rate: 1.1 },
    { unknown: true },
  ])
    expect(optimizationAlgorithmSchema.safeParse({ id: 'de', config }).success).toBe(false)
  expect(optimizationAlgorithmSchema.safeParse({ id: 'de', version: 2 }).success).toBe(false)
  expect(optimizationAlgorithmSchema.safeParse({ id: 'de', config: { crossover_rate: 0 } }).success).toBe(true)
  expect(optimizationAlgorithmSchema.safeParse({ id: 'de', config: { crossover_rate: 1 } }).success).toBe(true)
})

it.each(['coordinate', 'random', 'de'] as const)(
  'submits Tensor elements and current Candidate with %s search settings',
  async (algorithmId) => {
    vi.mocked(optimizationApi.create).mockClear()
    vi.spyOn(dbTables.Calculation, 'listRows').mockResolvedValue({
      items: [{ id: 9, name: 'Objective', contract_status: 'needs_preflight', output_layout: null }],
      total: 1,
    } as Awaited<ReturnType<typeof dbTables.Calculation.listRows>>)
    vi.mocked(optimizationApi.create).mockResolvedValue(optimizationFixture)
    const workbench = {
      experimentId: 7,
      experimentName: 'Demo',
      experimentClean: true,
      experimentManageable: true,
      experimentSourceValidated: true,
      selectionRestoring: false,
      selectionContext: { calculationId: 9 },
      experimentRecord: { source_hash: 'hash-7' },
      candidateVars: {
        width: 2,
        matrix: [
          [1, 2],
          [3, 4],
        ],
      },
      experimentDocument: {
        runIsBusy: false,
        varsSchema: { width: { shape: [], min: 0, max: 10 }, matrix: { shape: [2, 2], min: 0, max: 10 } },
      },
    } as unknown as CaeWorkbenchState
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const created = vi.fn()
    function Setup() {
      const [draft, setDraft] = useState(() => ({
        ...createOptimizationDraft(workbench),
        qualityRequirements: [{ recordId: 10, component: 'value', rmseMaximum: 'invalid stale Hybrid input' }],
      }))
      const creation = useOptimizationCreation(created)
      return <OptimizationSetup workbench={workbench} draft={draft} onDraftChange={setDraft} creation={creation} />
    }
    render(
      <QueryClientProvider client={client}>
        <Setup />
      </QueryClientProvider>,
    )
    await screen.findByText('Objective · 첫 평가에서 검증')
    fireEvent.change(screen.getByLabelText('탐색 알고리즘'), { target: { value: algorithmId } })
    if (algorithmId === 'random') {
      fireEvent.change(screen.getByLabelText('난수 seed'), { target: { value: '42' } })
      fireEvent.change(screen.getByLabelText('회차당 후보 수'), { target: { value: '4' } })
      // Switching strategies preserves each strategy's edited settings.
      fireEvent.change(screen.getByLabelText('탐색 알고리즘'), { target: { value: 'coordinate' } })
      fireEvent.change(screen.getByLabelText('탐색 알고리즘'), { target: { value: 'random' } })
      expect(screen.getByLabelText('난수 seed')).toHaveValue(42)
    } else if (algorithmId === 'de') {
      fireEvent.change(screen.getByLabelText('난수 seed'), { target: { value: '42' } })
      fireEvent.change(screen.getByLabelText('개체군 크기'), { target: { value: '12' } })
      fireEvent.change(screen.getByLabelText('변이 계수 F'), { target: { value: '0.6' } })
      fireEvent.change(screen.getByLabelText('교차 확률 CR'), { target: { value: '0.7' } })
      fireEvent.change(screen.getByLabelText('탐색 알고리즘'), { target: { value: 'random' } })
      expect(screen.getByLabelText('난수 seed')).toHaveValue(0)
      fireEvent.change(screen.getByLabelText('탐색 알고리즘'), { target: { value: 'de' } })
      expect(screen.getByLabelText('난수 seed')).toHaveValue(42)
      expect(screen.getByLabelText('개체군 크기')).toHaveValue(12)
      expect(screen.getByLabelText('변이 계수 F')).toHaveValue(0.6)
      expect(screen.getByLabelText('교차 확률 CR')).toHaveValue(0.7)
    } else {
      fireEvent.change(screen.getByLabelText('초기 step'), { target: { value: '0.2' } })
    }
    fireEvent.click(screen.getByText('최적화 시작'))
    await waitFor(() => expect(optimizationApi.create).toHaveBeenCalledOnce())
    const payload = vi.mocked(optimizationApi.create).mock.calls[0][0]
    expect(payload.initial_vars).toEqual(workbench.candidateVars)
    expect(payload.axes?.map(({ name, indices, fixed }) => [name, indices, fixed])).toEqual([
      ['width', [], false],
      ['matrix', [0, 0], false],
      ['matrix', [0, 1], false],
      ['matrix', [1, 0], false],
      ['matrix', [1, 1], false],
    ])
    expect(payload.objective).toEqual({ calculation_id: 9, direction: 'minimize' })
    expect(payload.hybrid).toBeUndefined()
    expect(payload.algorithm).toEqual({
      id: algorithmId,
      version: 1,
      config:
        algorithmId === 'random'
          ? { seed: 42, candidates_per_round: 4 }
          : algorithmId === 'de'
            ? { seed: 42, population_size: 12, mutation_factor: 0.6, crossover_rate: 0.7 }
            : { initial_step: 0.2, min_step: 0.001 },
    })
    await waitFor(() => expect(created).toHaveBeenCalledWith(optimizationFixture))
  },
)

it.each(['omitted', 'failed', 'unassessed', 'automatic', 'legacy-auto'])(
  'selects an older revision and submits optional quality conditions (%s) for the server to judge',
  async (scenario) => {
    const withQuality = scenario === 'failed' || scenario === 'unassessed'
    const rejection =
      scenario === 'unassessed'
        ? 'Hybrid quality unassessed: Record 10/value has no saved quality report.'
        : 'Hybrid quality rejected: Record 10/value RMSE 0.6 exceeds 0.5 K.'
    vi.mocked(optimizationApi.create).mockClear().mockResolvedValue(optimizationFixture)
    vi.spyOn(dbTables.Calculation, 'listRows').mockResolvedValue({
      items: [{ id: 9, name: 'Current error', contract_status: 'needs_preflight', output_layout: null }],
      total: 1,
    } as Awaited<ReturnType<typeof dbTables.Calculation.listRows>>)
    const replica = {
      id: 'replica',
      storage_id: 'storage',
      state: 'present' as const,
      manifest_sha256: 'checksum',
      artifact: {},
      checked_at: null,
      verified_at: null,
      delete_id: null,
    }
    const revision = {
      revision: 1,
      operation_id: 'operation',
      state: 'ready',
      dataset_id: 'dataset',
      dataset_revision: 1,
      dataset_fingerprint: 'data-hash',
      definition: {
        fingerprint: 'definition',
        algorithm: { kind: 'knn' },
        qualityValidation: { version: scenario === 'legacy-auto' ? 1 : 2 },
      },
      source_contracts: {
        records: [{ id: 10, name: 'temperature', data_schema: { unit: 'K', boxGrid: { components: ['value'] } } }],
      },
      artifact: {
        manifest_sha256: 'checksum',
        ...(scenario === 'unassessed' ? {} : { quality_report: qualityReportFixture }),
      },
      replicas: [replica],
    }
    vi.spyOn(predictionApi, 'algorithms').mockResolvedValue([
      {
        kind: 'knn',
        implementationVersion: 'knn-v1',
        preprocessingVersion: 'box-relative-v2',
        directions: ['forward'],
        representations: ['box-relative-v2'],
        resources: { training: { gpu_count: 0 }, inference: { gpu_count: 0 } },
      },
    ])
    vi.spyOn(predictionApi, 'models').mockResolvedValue([
      {
        id: 'model',
        name: 'Saved kNN',
        experiment_id: 7,
        state: 'active',
        current_revision: 2,
        delete_id: null,
        direction: 'forward',
        algorithm: 'unsupported-newer-algorithm',
        support_status: 'unsupported',
        revisions: [
          revision,
          {
            ...revision,
            revision: 2,
            support_status: 'unsupported',
            definition: { fingerprint: 'new-definition', algorithm: { kind: 'unsupported-newer-algorithm' } },
          },
        ],
      },
    ])
    vi.spyOn(predictionApi, 'storages').mockResolvedValue([
      {
        storage_id: 'storage',
        name: 'Local Predictor',
        kind: 'predictor_local',
        checked_at: null,
        accesses: [{ launcher_id: 'launcher', connected: true, checked_at: null }],
      },
    ])
    const workbench = {
      experimentId: 7,
      experimentName: 'Conductor',
      experimentClean: true,
      experimentManageable: true,
      experimentSourceValidated: true,
      selectionRestoring: false,
      selectionContext: { calculationId: 9 },
      experimentRecord: { source_hash: 'hash-7' },
      candidateVars: { width: 2 },
      experimentDocument: { runIsBusy: false, varsSchema: { width: { shape: [], min: 1, max: 3 } } },
    } as unknown as CaeWorkbenchState
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Setup() {
      const [draft, setDraft] = useState(() => createOptimizationDraft(workbench))
      const creation = useOptimizationCreation(vi.fn())
      return <OptimizationSetup workbench={workbench} draft={draft} onDraftChange={setDraft} creation={creation} />
    }
    render(
      <QueryClientProvider client={client}>
        <Setup />
      </QueryClientProvider>,
    )
    await screen.findByText('Current error · 첫 평가에서 검증')
    fireEvent.click(screen.getByLabelText('Forward Hybrid Optimization'))
    await screen.findByText('Saved kNN')
    fireEvent.change(screen.getByLabelText('저장된 Forward 모델'), { target: { value: 'model' } })
    if (scenario === 'legacy-auto') fireEvent.click(screen.getByLabelText('자동 재학습'))
    fireEvent.change(screen.getByLabelText('모델 revision'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('모델 복제본 · 실행 Launcher'), { target: { value: 'replica:launcher' } })
    expect(screen.getByLabelText('Solver 실행 시도 예산')).toHaveValue(8)
    expect(screen.getByLabelText('자동 재학습')).not.toBeChecked()
    if (scenario === 'legacy-auto') {
      expect(screen.getByLabelText('자동 재학습')).toBeDisabled()
      expect(screen.getByText(/모델 갱신과 자동 재학습에는 새 v2 모델이 필요합니다/)).toBeInTheDocument()
    }
    if (scenario === 'automatic') {
      fireEvent.change(screen.getByLabelText('탐색 알고리즘'), { target: { value: 'de' } })
      fireEvent.click(screen.getByLabelText('자동 재학습'))
      expect(screen.getByLabelText('갱신에 필요한 새 결과 수')).toHaveValue(3)
      expect(screen.getByLabelText('최대 자동 갱신 횟수')).toHaveValue(3)
      expect(screen.getByLabelText('회당 대기·학습 제한 (초)')).toHaveValue(180)
      expect(screen.getByLabelText('누적 대기·학습 제한 (초)')).toHaveValue(540)
      fireEvent.change(screen.getByLabelText('갱신에 필요한 새 결과 수'), { target: { value: '2' } })
    }
    expect(
      screen.getByText(scenario === 'unassessed' ? '저장 보고서 RMSE: 미평가' : '저장 보고서 RMSE: 0.6 K'),
    ).toBeInTheDocument()
    if (withQuality) {
      fireEvent.change(screen.getByLabelText('temperature · value RMSE 상한 (K)'), { target: { value: '0.5' } })
      vi.mocked(optimizationApi.create).mockRejectedValueOnce(new Error(rejection))
    }
    fireEvent.click(screen.getByText('최적화 시작'))
    await waitFor(() => expect(optimizationApi.create).toHaveBeenCalledOnce())
    expect(vi.mocked(optimizationApi.create).mock.calls[0][0]).toMatchObject({
      max_trials: 20,
      max_parallel: 2,
      ...(scenario === 'automatic' ? { algorithm: { id: 'de', version: 1 } } : {}),
      hybrid: {
        model_id: 'model',
        model_revision: 1,
        replica_id: 'replica',
        launcher_id: 'launcher',
        max_solver_runs: 8,
        ...(withQuality ? { quality_requirements: [{ recordId: 10, component: 'value', rmseMaximum: 0.5 }] } : {}),
      },
    })
    if (withQuality) {
      expect(await screen.findByText(rejection)).toBeInTheDocument()
      fireEvent.change(screen.getByLabelText('모델 revision'), { target: { value: '' } })
      fireEvent.change(screen.getByLabelText('모델 revision'), { target: { value: '1' } })
      expect(screen.getByLabelText('temperature · value RMSE 상한 (K)')).toHaveValue(null)
      fireEvent.change(screen.getByLabelText('temperature · value RMSE 상한 (K)'), { target: { value: '0.2' } })
      fireEvent.change(screen.getByLabelText('저장된 Forward 모델'), { target: { value: '' } })
      fireEvent.change(screen.getByLabelText('저장된 Forward 모델'), { target: { value: 'model' } })
      fireEvent.change(screen.getByLabelText('모델 revision'), { target: { value: '1' } })
      expect(screen.getByLabelText('temperature · value RMSE 상한 (K)')).toHaveValue(null)
    } else {
      expect(vi.mocked(optimizationApi.create).mock.calls[0][0].hybrid?.quality_requirements).toBeUndefined()
    }
    expect(vi.mocked(optimizationApi.create).mock.calls[0][0].hybrid?.model_update_policy).toEqual(
      scenario === 'automatic'
        ? {
            id: 'new_solver_results',
            version: 1,
            config: {
              min_new_measurements: 2,
              max_updates: 3,
              update_timeout_seconds: 180,
              total_timeout_seconds: 540,
            },
          }
        : undefined,
    )
  },
)
