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

vi.mock('@/features/auth/use-auth', () => ({ useAuth: () => ({ queryScope: 'user:first' }) }))
vi.mock('@/api/optimization', () => ({ optimizationApi: { create: vi.fn() } }))

it('submits every Tensor element and current Candidate with a saved unpreflighted scalar source', async () => {
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
  await waitFor(() => expect(created).toHaveBeenCalledWith(optimizationFixture))
})

it.each(['omitted', 'failed', 'unassessed'])(
  'selects an older revision and submits optional quality conditions (%s) for the server to judge',
  async (scenario) => {
    const withQuality = scenario !== 'omitted'
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
      definition: { fingerprint: 'definition', algorithm: { kind: 'knn' } },
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
    fireEvent.change(screen.getByLabelText('모델 revision'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('모델 복제본 · 실행 Launcher'), { target: { value: 'replica:launcher' } })
    expect(screen.getByLabelText('Solver 실행 시도 예산')).toHaveValue(8)
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
  },
)
