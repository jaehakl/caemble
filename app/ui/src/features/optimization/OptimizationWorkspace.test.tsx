import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { optimizationApi } from '@/api/optimization'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { OptimizationDraft } from './optimizationDraft'
import type { useOptimizationCreation } from './useOptimizationData'
import { OptimizationSetup } from './OptimizationSetup'
import { OptimizationWorkspace } from './OptimizationWorkspace'
import { optimizationFixture } from './fixtures.test-support'

vi.mock('@/features/auth/use-auth', () => ({ useAuth: () => ({ isAuthenticated: true, queryScope: 'user:first' }) }))
vi.mock('@/api/optimization', () => ({ optimizationApi: { create: vi.fn() } }))
vi.mock('./OptimizationSetup', () => ({
  OptimizationSetup: vi.fn(
    ({
      draft,
      onDraftChange,
      creation,
    }: {
      draft: OptimizationDraft
      onDraftChange: (draft: OptimizationDraft) => void
      creation: ReturnType<typeof useOptimizationCreation>
    }) => (
      <div data-testid="optimization-setup">
        <input
          aria-label="최적화 이름"
          value={draft.name}
          onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
        />
        {creation.error ? <p role="alert">{creation.error}</p> : null}
        <button
          disabled={creation.pending}
          onClick={() =>
            void creation.create({
              name: draft.name,
              experiment_id: 7,
              source_hash: 'source',
              vars_schema: {},
              initial_vars: {},
              objective: { calculation_id: 9 },
            })
          }
        >
          최적화 시작
        </button>
      </div>
    ),
  ),
}))
vi.mock('./OptimizationManagement', () => ({
  OptimizationManagement: vi.fn(({ selectedId }: { selectedId: string | null }) => (
    <section aria-label="Optimizations">{selectedId}</section>
  )),
}))

const schema = { sizeX: { shape: [], min: 1, max: 10 } }
const workbench = {
  experimentId: 7,
  experimentName: 'Beam',
  experimentRecord: { source_hash: 'restored-source' },
  selectionContext: { calculationId: 9 },
  workspaceSession: 2,
  selectionRestoring: false,
  candidateVars: { sizeX: 4 },
  experimentDocument: { varsSchema: schema, variables: null },
} as unknown as CaeWorkbenchState

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(optimizationApi.create).mockResolvedValue(optimizationFixture)
})

function renderWorkspace(initial: CaeWorkbenchState = workbench) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onSelectOptimization = vi.fn()
  const view = (state: CaeWorkbenchState, id = 'running-optimization') => (
    <QueryClientProvider client={client}>
      <OptimizationWorkspace
        workbench={state}
        requestedOptimizationId={id}
        onSelectOptimization={onSelectOptimization}
        onApplyBest={vi.fn()}
        onRequestLogin={vi.fn()}
      />
    </QueryClientProvider>
  )
  const rendered = render(view(initial))
  return {
    ...rendered,
    onSelectOptimization,
    update: (state: CaeWorkbenchState, id?: string) => rendered.rerender(view(state, id)),
  }
}

it('keeps progress available while restoring the Candidate, then enables creation', () => {
  const page = renderWorkspace({ ...workbench, selectionRestoring: true })
  expect(OptimizationSetup).not.toHaveBeenCalled()
  expect(screen.getByRole('status')).toHaveTextContent('Candidate를 복원하는 중입니다')
  expect(screen.getByRole('region', { name: 'Optimizations' })).toHaveTextContent('running-optimization')
  expect(screen.getByRole('button', { name: '새 Optimization' })).toBeDisabled()
  page.update(workbench)
  fireEvent.click(screen.getByRole('button', { name: '새 Optimization' }))
  expect(screen.getByTestId('optimization-setup')).toBeInTheDocument()
})

it.each([
  ['a different source key', { width: 4 }],
  ['a non-finite scalar', { sizeX: Number.NaN }],
  ['an out-of-range scalar', { sizeX: 11 }],
  ['a mismatched tensor shape', { sizeX: [4] }],
] as const)('contains %s during restoration and recovers with valid values', (_name, candidateVars) => {
  const page = renderWorkspace({ ...workbench, candidateVars })
  expect(OptimizationSetup).not.toHaveBeenCalled()
  expect(screen.getByRole('status')).toHaveTextContent('Candidate의 변수와 현재 소스가 일치하지 않습니다')
  expect(screen.getByRole('region', { name: 'Optimizations' })).toBeInTheDocument()
  page.update(workbench)
  fireEvent.click(screen.getByRole('button', { name: '새 Optimization' }))
  expect(screen.getByTestId('optimization-setup')).toBeInTheDocument()
})

it('keeps management available until the restored source schema is ready', () => {
  renderWorkspace({ ...workbench, experimentDocument: { ...workbench.experimentDocument, varsSchema: null } })
  expect(OptimizationSetup).not.toHaveBeenCalled()
  expect(screen.getByRole('region', { name: 'Optimizations' })).toBeInTheDocument()
})

it('retains the draft when the panel closes and resets it when the source session changes', () => {
  const page = renderWorkspace()
  fireEvent.click(screen.getByRole('button', { name: '새 Optimization' }))
  fireEvent.change(screen.getByLabelText('최적화 이름'), { target: { value: 'Draft name' } })
  fireEvent.click(screen.getByRole('button', { name: '메뉴 닫기' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '새 Optimization' }))
  expect(screen.getByLabelText('최적화 이름')).toHaveValue('Draft name')
  page.update({ ...workbench, workspaceSession: 3 })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '새 Optimization' }))
  expect(screen.getByLabelText('최적화 이름')).toHaveValue('Beam 최적화')
})

it('selects a created Optimization even if the panel was closed while creating it', async () => {
  let finish!: (value: typeof optimizationFixture) => void
  vi.mocked(optimizationApi.create).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const page = renderWorkspace()
  fireEvent.click(screen.getByRole('button', { name: '새 Optimization' }))
  fireEvent.click(screen.getByRole('button', { name: '최적화 시작' }))
  fireEvent.click(screen.getByRole('button', { name: '메뉴 닫기' }))
  await act(async () => finish(optimizationFixture))
  expect(page.onSelectOptimization).toHaveBeenCalledWith(optimizationFixture.id)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('ignores creation completion from an old source session', async () => {
  let finish!: (value: typeof optimizationFixture) => void
  vi.mocked(optimizationApi.create).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const page = renderWorkspace()
  fireEvent.click(screen.getByRole('button', { name: '새 Optimization' }))
  fireEvent.click(screen.getByRole('button', { name: '최적화 시작' }))
  page.update({ ...workbench, workspaceSession: 3 })
  await act(async () => finish(optimizationFixture))
  expect(page.onSelectOptimization).not.toHaveBeenCalled()
})

it('retains creation idempotency after a transport failure and panel close', async () => {
  vi.mocked(optimizationApi.create)
    .mockRejectedValueOnce(new Error('Connection lost'))
    .mockResolvedValue(optimizationFixture)
  renderWorkspace()
  fireEvent.click(screen.getByRole('button', { name: '새 Optimization' }))
  fireEvent.click(screen.getByRole('button', { name: '최적화 시작' }))
  await screen.findByText('Connection lost')
  fireEvent.click(screen.getByRole('button', { name: '메뉴 닫기' }))
  fireEvent.click(screen.getByRole('button', { name: '새 Optimization' }))
  fireEvent.click(screen.getByRole('button', { name: '최적화 시작' }))
  await waitFor(() => expect(optimizationApi.create).toHaveBeenCalledTimes(2))
  const [first, second] = vi.mocked(optimizationApi.create).mock.calls
  expect(second[0].request_id).toBe(first[0].request_id)
})

it('passes URL selection changes to the manager without remounting the draft', () => {
  const page = renderWorkspace()
  page.update(workbench, 'another-optimization')
  expect(screen.getByRole('region', { name: 'Optimizations' })).toHaveTextContent('another-optimization')
})
