import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { BatchGenerationDialog } from './BatchGenerationDialog'
import { sampleMeasurementVars } from './measurementSpace'
import type { BrowserBatchCandidates } from './buildBatchArtifact'
import type { CaeBatch } from '@/contracts/api/cae'

const mocks = vi.hoisted(() => ({ list: vi.fn(), run: vi.fn(), cancel: vi.fn(), inspect: vi.fn(), toast: vi.fn() }))
vi.mock('@/api', () => ({ getListRequest: () => ({}), dbTables: { Measurement: { listRows: mocks.list } } }))
vi.mock('@/features/cae/CaeBatchProvider', () => ({ useCaeBatches: () => ({ inspectBatch: mocks.inspect }) }))
vi.mock('sonner', () => ({ toast: { success: mocks.toast } }))
vi.mock('./measurementSpace', async (original) => {
  const actual = await original<typeof import('./measurementSpace')>()
  return { ...actual, sampleMeasurementVars: vi.fn(actual.sampleMeasurementVars) }
})
const workbench = {
  experimentId: 7,
  candidateVars: { x: 0.5 },
  selection: { measurement: null },
  experimentDocument: { varsSchema: { x: { shape: [], min: 0, max: 1 } } },
  measurementActions: { runCandidatesAsync: mocks.run, cancel: mocks.cancel, stage: '입력 준비 1/10' },
} as unknown as CaeWorkbenchState
function Harness({ eligible = true }: { eligible?: boolean }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button onClick={() => setOpen(true)}>열기</button>
      {open ? <BatchGenerationDialog workbench={workbench} eligible={eligible} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.list.mockReset().mockResolvedValue({ items: [{ vars: { x: 0.2 } }], total: 1 })
  mocks.run
    .mockReset()
    .mockImplementation(async (candidates: BrowserBatchCandidates, _progress, submitted: (batch: CaeBatch) => void) => {
      for (let i = 1; i <= candidates.count; i++) await candidates.next(i, new AbortController().signal)
      submitted({ id: 'batch-1', total: candidates.count } as CaeBatch)
      return {}
    })
})

it.each(['empty-lhs', 'random'] as const)(
  'submits %s samples once, closes at commit and links the server batch',
  async (algorithm) => {
    render(<Harness />)
    expect(screen.getByLabelText('알고리즘')).toHaveValue('empty-lhs')
    expect(screen.getByLabelText('생성 개수')).toHaveValue(10)
    fireEvent.change(screen.getByLabelText('알고리즘'), { target: { value: algorithm } })
    fireEvent.change(screen.getByLabelText('생성 개수'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '실행' }))
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
    expect(sampleMeasurementVars).toHaveBeenCalledWith(
      workbench.experimentDocument.varsSchema,
      [{ x: 0.2 }, { x: 0.5 }],
      3,
      algorithm,
    )
    expect(mocks.run.mock.calls[0][0]).toMatchObject({
      count: 3,
      algorithm: algorithm === 'empty-lhs' ? 'latin-hypercube' : 'monte-carlo',
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(mocks.toast.mock.calls[0][1].description).toContain('요청 3개 · 제출 3개')
    mocks.toast.mock.calls[0][1].action.onClick()
    expect(mocks.inspect).toHaveBeenCalledWith('batch-1')
    fireEvent.click(screen.getByRole('button', { name: '열기' }))
    expect(screen.getByLabelText('알고리즘')).toHaveValue('empty-lhs')
    expect(screen.getByLabelText('생성 개수')).toHaveValue(10)
  },
)

it('blocks invalid counts and requests without execution permission', () => {
  const { rerender } = render(<Harness />)
  for (const count of ['0', '-1', '1.5', '100001', '']) {
    fireEvent.change(screen.getByLabelText('생성 개수'), { target: { value: count } })
    expect(screen.getByRole('button', { name: '실행' })).toBeDisabled()
  }
  fireEvent.change(screen.getByLabelText('생성 개수'), { target: { value: '10' } })
  rerender(<Harness eligible={false} />)
  expect(screen.getByRole('button', { name: '실행' })).toBeDisabled()
  expect(mocks.run).not.toHaveBeenCalled()
})

it('cancels the listing request before submission and prevents duplicate starts', async () => {
  let finish!: (value: unknown) => void
  mocks.list.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  render(<Harness />)
  const submit = screen.getByRole('button', { name: '실행' })
  fireEvent.click(submit)
  fireEvent.click(submit)
  expect(mocks.list).toHaveBeenCalledTimes(1)
  const signal = mocks.list.mock.calls[0][1].signal as AbortSignal
  fireEvent.click(screen.getByRole('button', { name: '취소' }))
  expect(signal.aborted).toBe(true)
  await act(async () => finish({ items: [] }))
  expect(mocks.run).not.toHaveBeenCalled()
})

it.each(['cancel', 'unmount'])('cancels an uncommitted upload on %s', async (action) => {
  let finish!: () => void
  mocks.run.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const view = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '실행' }))
  await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('status')).toHaveTextContent('입력 준비 1/10')
  if (action === 'cancel') fireEvent.click(screen.getByRole('button', { name: '취소' }))
  else view.unmount()
  expect(mocks.cancel).toHaveBeenCalledTimes(1)
  await act(async () => finish())
})

it('does not cancel a committed batch while server execution is still pending', async () => {
  let finish!: () => void
  mocks.run.mockImplementation((_c, _progress, submitted: (batch: CaeBatch) => void) => {
    submitted({ id: 'batch-1', total: 10 } as CaeBatch)
    return new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  const view = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '실행' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  view.unmount()
  expect(mocks.cancel).not.toHaveBeenCalled()
  await act(async () => finish())
})

it('reports partial preparation failures and the actual submitted count', async () => {
  mocks.run.mockImplementation(
    async (candidates: BrowserBatchCandidates, _progress, submitted: (batch: CaeBatch) => void) => {
      candidates.failed(2, new Error('invalid geometry'))
      submitted({ id: 'batch-1', total: 9 } as CaeBatch)
    },
  )
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '실행' }))
  await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
  expect(mocks.toast.mock.calls[0][1].description).toContain('요청 10개 · 제출 9개 · 입력 준비 실패 1개')
})

it.each(['입력 준비 실패', '업로드 실패'])('keeps the dialog and displays %s for retry', async (message) => {
  mocks.run.mockRejectedValueOnce(new Error(message))
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '실행' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(screen.getByRole('dialog')).toBeVisible()
  expect(screen.getByRole('button', { name: '실행' })).toBeEnabled()
})
