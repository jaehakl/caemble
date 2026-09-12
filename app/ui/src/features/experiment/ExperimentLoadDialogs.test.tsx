import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { SavedExperimentRecord } from '@/api'
import { LoadExperimentDialog } from './LoadExperimentDialog'
import { ExamplesDialog } from './ExamplesDialog'

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  listExperiments: vi.fn(),
  getExperiment: vi.fn(),
  load: vi.fn(),
}))
vi.mock('@/api', () => ({ dbTables: { Experiment: { available: mocks.available } } }))
vi.mock('@/api/catalog', () => ({ catalogApi: mocks }))
vi.mock('@/features/cae-workbench/state/useCaeWorkbenchState', () => ({
  useCaeWorkbenchState: () => {
    const [row, setRow] = useState<{ id: number } | null>(null)
    return {
      experimentRecord: row,
      experimentId: row?.id,
      selectionRestoring: false,
      loadExperiment: async (value: { id: number }) => {
        mocks.load(value)
        setRow(value)
      },
    }
  },
}))
vi.mock('./ExperimentPreview', () => ({
  ExperimentPreview: ({ workbench }: { workbench: { experimentId: number } }) => (
    <output aria-label="Preview">{workbench.experimentId}</output>
  ),
}))
vi.mock('./ExperimentShowcase', () => ({
  ExperimentShowcase: ({ onSelect }: { onSelect: (row: unknown) => void }) => (
    <button onClick={() => onSelect({ id: 2 })}>Previous version</button>
  ),
}))
function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.available.mockResolvedValue({ mine: [], demos: [{ id: 3, demoDefault: true }] })
})
it('previews current and previous versions independently and applies only on Load', async () => {
  const apply = vi.fn(),
    close = vi.fn()
  render(
    <LoadExperimentDialog user={null} current={{ id: 1 } as SavedExperimentRecord} onApply={apply} onClose={close} />,
    { wrapper },
  )
  await waitFor(() => expect(screen.getByLabelText('Preview')).toHaveTextContent('1'))
  fireEvent.click(screen.getByRole('button', { name: 'Previous version' }))
  expect(screen.getByLabelText('Preview')).toHaveTextContent('2')
  expect(apply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '불러오기' }))
  expect(apply).toHaveBeenCalledWith({ id: 2 })
})
it('defaults to representative demo and cancel never applies it', async () => {
  const apply = vi.fn(),
    close = vi.fn()
  render(<LoadExperimentDialog user={null} current={null} onApply={apply} onClose={close} />, { wrapper })
  await waitFor(() => expect(screen.getByLabelText('Preview')).toHaveTextContent('3'))
  fireEvent.click(screen.getByRole('button', { name: '취소' }))
  expect(close).toHaveBeenCalledOnce()
  expect(apply).not.toHaveBeenCalled()
})
it('shows a searchable example table and imports source and Calculation definitions on Apply', async () => {
  const row = { coordinate: 'fixture/example@1.0.0', title: '예제', description: '한 줄 설명', version: '1.0.0' }
  const detail = { ...row, sourceBundle: { files: {} }, calculations: [{ name: '계산', source_code: 'fixture' }] }
  mocks.listExperiments.mockResolvedValue({ items: [row], nextCursor: null })
  mocks.getExperiment.mockResolvedValue(detail)
  const apply = vi.fn()
  render(<ExamplesDialog onApply={apply} onClose={vi.fn()} />, { wrapper })
  await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
  fireEvent.change(screen.getByLabelText('Catalog 예제 검색'), { target: { value: '예제' } })
  await waitFor(() =>
    expect(mocks.listExperiments).toHaveBeenCalledWith(expect.objectContaining({ q: '예제' }), expect.anything()),
  )
  fireEvent.click(await screen.findByRole('button', { name: '예제' }))
  expect(apply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '적용' }))
  await waitFor(() => expect(apply).toHaveBeenCalledWith(detail))
})
