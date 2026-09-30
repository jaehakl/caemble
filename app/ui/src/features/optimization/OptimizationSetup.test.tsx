import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { optimizationApi } from '@/api/optimization'
import { dbTables } from '@/api'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { OptimizationSetup } from './OptimizationSetup'
import { studyFixture } from './fixtures.test-support'

vi.mock('@/features/auth/use-auth', () => ({ useAuth: () => ({ queryScope: 'user:first' }) }))
vi.mock('@/api/optimization', () => ({ optimizationApi: { create: vi.fn() } }))

it('submits every Tensor element and current Candidate with a saved unpreflighted scalar source', async () => {
  vi.spyOn(dbTables.Calculation, 'listRows').mockResolvedValue({
    items: [{ id: 9, name: 'Objective', contract_status: 'needs_preflight', output_layout: null }],
    total: 1,
  } as Awaited<ReturnType<typeof dbTables.Calculation.listRows>>)
  vi.mocked(optimizationApi.create).mockResolvedValue(studyFixture)
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
  render(
    <QueryClientProvider client={client}>
      <OptimizationSetup workbench={workbench} onCreated={created} />
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
  await waitFor(() => expect(created).toHaveBeenCalledWith(studyFixture))
})
